/**
 * Sign-in, session lifecycle and the password lifecycle — against real PostgreSQL.
 *
 * Revocation taking effect on the very next request is the property that justifies
 * server-side sessions over a JWT (ADR-0009), and it is only meaningful against a real
 * store.
 */
import { hashToken } from '@growth-os/authn';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  closeIdentityFixture,
  type IdentityFixture,
  openIdentityFixture,
  TEST_PASSWORD as PASSWORD,
  resetIdentityTables,
} from '../__testing__/db-fixture.js';
import { CountingRateLimiter } from '../__testing__/harness.js';
import {
  authenticateSession,
  changePassword,
  completePasswordReset,
  listSessions,
  register,
  requestPasswordReset,
  signIn,
  signOut,
  signOutEverywhere,
  verifyEmail,
} from './index.js';

let fixture: IdentityFixture;
let db: IdentityFixture['db'];
let h: IdentityFixture['h'];

beforeAll(async () => {
  fixture = await openIdentityFixture();
  db = fixture.db;
  h = fixture.h;
}, 120_000);

afterAll(async () => {
  await closeIdentityFixture(fixture);
});

beforeEach(async () => {
  await resetIdentityTables(fixture);
});

/** Registers and verifies, which is the normal precondition for signing in. */
async function activeUser(email: string): Promise<string> {
  const { userId, verificationToken } = await register(h, { email, password: PASSWORD });
  await verifyEmail(h, verificationToken);
  return userId;
}

describe('sign-in', () => {
  it('authenticates a verified user and issues a session', async () => {
    await activeUser('ada@example.test');
    const result = await signIn(h, { email: 'ada@example.test', password: PASSWORD });
    expect(result.outcome).toBe('authenticated');
    if (result.outcome !== 'authenticated') return;
    expect(result.token).toHaveLength(43);

    const stored = await db.pool.query<{ token_hash: Buffer }>('SELECT token_hash FROM sessions');
    expect(stored.rows[0]?.token_hash.equals(hashToken(result.token))).toBe(true);
  });

  it('refuses a wrong password', async () => {
    await activeUser('ada@example.test');
    const result = await signIn(h, { email: 'ada@example.test', password: 'wrong password 1' });
    expect(result).toEqual({ outcome: 'refused', reason: 'bad_password' });
  });

  it('refuses an unknown address with the same shape as a wrong password', async () => {
    const result = await signIn(h, { email: 'nobody@example.test', password: PASSWORD });
    expect(result.outcome).toBe('refused');
  });

  it('refuses an unverified account', async () => {
    await register(h, { email: 'ada@example.test', password: PASSWORD });
    const result = await signIn(h, { email: 'ada@example.test', password: PASSWORD });
    expect(result).toEqual({ outcome: 'refused', reason: 'email_unverified' });
  });

  it('refuses a suspended account even with the right password', async () => {
    const userId = await activeUser('ada@example.test');
    await h.users.setStatus(userId, 'suspended');
    const result = await signIn(h, { email: 'ada@example.test', password: PASSWORD });
    expect(result).toEqual({ outcome: 'refused', reason: 'suspended' });
  });

  it('locks the account after five failures and refuses the correct password', async () => {
    await activeUser('ada@example.test');
    for (let i = 0; i < 5; i++) {
      await signIn(h, { email: 'ada@example.test', password: `wrong password ${i}` });
    }
    const result = await signIn(h, { email: 'ada@example.test', password: PASSWORD });
    expect(result).toEqual({ outcome: 'refused', reason: 'locked' });
  });

  it('releases the lock once the window passes', async () => {
    await activeUser('ada@example.test');
    for (let i = 0; i < 5; i++) {
      await signIn(h, { email: 'ada@example.test', password: `wrong password ${i}` });
    }
    h.clock.advance(16 * 60 * 1000);
    const result = await signIn(h, { email: 'ada@example.test', password: PASSWORD });
    expect(result.outcome).toBe('authenticated');
  });

  it('clears the counter after a successful sign-in', async () => {
    const userId = await activeUser('ada@example.test');
    await signIn(h, { email: 'ada@example.test', password: 'wrong password 0' });
    await signIn(h, { email: 'ada@example.test', password: PASSWORD });
    expect((await h.users.findById(userId))?.failedLoginCount).toBe(0);
  });

  /**
   * Per-source limiting, distinct from lockout. Lockout never sees a spray across many
   * accounts, because each account only fails once.
   */
  it('rate limits by source independently of per-account lockout', async () => {
    await activeUser('a@example.test');
    await activeUser('b@example.test');
    const limited = { ...h, rateLimiter: new CountingRateLimiter(2) };
    expect(
      (await signIn(limited, { email: 'a@example.test', password: 'x'.repeat(12), ip: '1.2.3.4' }))
        .outcome,
    ).toBe('refused');
    expect(
      (await signIn(limited, { email: 'b@example.test', password: 'x'.repeat(12), ip: '1.2.3.4' }))
        .outcome,
    ).toBe('refused');
    expect(
      (await signIn(limited, { email: 'a@example.test', password: PASSWORD, ip: '1.2.3.4' }))
        .outcome,
    ).toBe('rate_limited');
  });
});

describe('session lifecycle', () => {
  async function signedIn(email = 'ada@example.test') {
    await activeUser(email);
    const result = await signIn(h, { email, password: PASSWORD, ip: '10.0.0.1' });
    if (result.outcome !== 'authenticated') throw new Error(`expected auth, got ${result.outcome}`);
    return result;
  }

  it('authenticates a presented token', async () => {
    const { token, userId } = await signedIn();
    const lookup = await authenticateSession(h, token);
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    expect(lookup.value.user.id).toBe(userId);
    expect(lookup.value.mfaSatisfied).toBe(true);
  });

  it('rejects a forged token', async () => {
    await signedIn();
    const lookup = await authenticateSession(h, 'b'.repeat(43));
    expect(lookup).toEqual({ ok: false, reason: 'not_found' });
  });

  it('rejects an expired session', async () => {
    const { token } = await signedIn();
    h.clock.advance(31 * 24 * 60 * 60 * 1000);
    expect(await authenticateSession(h, token)).toEqual({ ok: false, reason: 'expired' });
  });

  it('enforces the absolute ceiling even for a continuously-used session', async () => {
    const { token } = await signedIn();
    // Used every 20 days, so the sliding window never lapses.
    for (let i = 0; i < 5; i++) {
      h.clock.advance(20 * 24 * 60 * 60 * 1000);
      await authenticateSession(h, token);
    }
    expect((await authenticateSession(h, token)).ok).toBe(false);
  });

  it('takes revocation into effect on the very next request', async () => {
    const { token, sessionId, userId } = await signedIn();
    expect((await authenticateSession(h, token)).ok).toBe(true);
    await signOut(h, sessionId, userId);
    expect(await authenticateSession(h, token)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('invalidates live sessions when the user is suspended', async () => {
    const { token, userId } = await signedIn();
    await h.users.setStatus(userId, 'suspended');
    expect(await authenticateSession(h, token)).toEqual({ ok: false, reason: 'user_invalid' });
  });

  it('supports concurrent sessions on different devices', async () => {
    await activeUser('ada@example.test');
    const a = await signIn(h, {
      email: 'ada@example.test',
      password: PASSWORD,
      deviceLabel: 'laptop',
    });
    const b = await signIn(h, {
      email: 'ada@example.test',
      password: PASSWORD,
      deviceLabel: 'phone',
    });
    if (a.outcome !== 'authenticated' || b.outcome !== 'authenticated') throw new Error('setup');
    expect((await authenticateSession(h, a.token)).ok).toBe(true);
    expect((await authenticateSession(h, b.token)).ok).toBe(true);

    // Revoking one must not disturb the other.
    await signOut(h, a.sessionId, a.userId);
    expect((await authenticateSession(h, a.token)).ok).toBe(false);
    expect((await authenticateSession(h, b.token)).ok).toBe(true);
  });

  it('signs out everywhere, optionally sparing the current device', async () => {
    await activeUser('ada@example.test');
    const a = await signIn(h, { email: 'ada@example.test', password: PASSWORD });
    const b = await signIn(h, { email: 'ada@example.test', password: PASSWORD });
    const c = await signIn(h, { email: 'ada@example.test', password: PASSWORD });
    if (
      a.outcome !== 'authenticated' ||
      b.outcome !== 'authenticated' ||
      c.outcome !== 'authenticated'
    ) {
      throw new Error('setup');
    }
    const revoked = await signOutEverywhere(h, a.userId, c.sessionId);
    expect(revoked).toBe(2);
    expect((await authenticateSession(h, a.token)).ok).toBe(false);
    expect((await authenticateSession(h, b.token)).ok).toBe(false);
    expect((await authenticateSession(h, c.token)).ok).toBe(true);
  });

  it('lists devices without exposing any token material', async () => {
    const { userId } = await signedIn();
    const sessions = await listSessions(h, userId);
    expect(sessions).toHaveLength(1);
    expect(JSON.stringify(sessions)).not.toContain('token');
    // host(), not ip::text: casting inet to text would render this as '10.0.0.1/32'.
    expect(sessions[0]?.ip).toBe('10.0.0.1');
  });

  it('requires re-authentication for a sensitive action once the window lapses', async () => {
    const { token } = await signedIn();
    const fresh = await authenticateSession(h, token);
    expect(fresh.ok && fresh.value.needsReauthentication).toBe(false);

    h.clock.advance(16 * 60 * 1000);
    const stale = await authenticateSession(h, token);
    expect(stale.ok && stale.value.needsReauthentication).toBe(true);
  });
});

describe('password lifecycle', () => {
  it('resets a password and revokes every session', async () => {
    await activeUser('ada@example.test');
    const session = await signIn(h, { email: 'ada@example.test', password: PASSWORD });
    if (session.outcome !== 'authenticated') throw new Error('setup');

    const request = await requestPasswordReset(h, { email: 'ada@example.test' });
    expect(request).toBeDefined();
    if (request === undefined) return;

    const newPassword = 'a completely different passphrase';
    expect(await completePasswordReset(h, request.token, newPassword)).toBe('reset');

    // The attacker's session is what a reset exists to kill.
    expect((await authenticateSession(h, session.token)).ok).toBe(false);
    expect((await signIn(h, { email: 'ada@example.test', password: newPassword })).outcome).toBe(
      'authenticated',
    );
    expect((await signIn(h, { email: 'ada@example.test', password: PASSWORD })).outcome).toBe(
      'refused',
    );
  });

  it('says nothing about whether an unknown address has an account', async () => {
    expect(await requestPasswordReset(h, { email: 'nobody@example.test' })).toBeUndefined();
  });

  it('refuses a reused reset token', async () => {
    await activeUser('ada@example.test');
    const request = await requestPasswordReset(h, { email: 'ada@example.test' });
    if (request === undefined) throw new Error('setup');
    expect(await completePasswordReset(h, request.token, 'a new long passphrase')).toBe('reset');
    expect(await completePasswordReset(h, request.token, 'another long passphrase')).toBe(
      'invalid',
    );
  });

  it('refuses an expired reset token', async () => {
    await activeUser('ada@example.test');
    const request = await requestPasswordReset(h, { email: 'ada@example.test' });
    if (request === undefined) throw new Error('setup');
    h.clock.advance(2 * 60 * 60 * 1000);
    expect(await completePasswordReset(h, request.token, 'a new long passphrase')).toBe('expired');
  });

  it('clears a lockout, so a locked-out user can recover by resetting', async () => {
    const userId = await activeUser('ada@example.test');
    for (let i = 0; i < 5; i++) {
      await signIn(h, { email: 'ada@example.test', password: `wrong password ${i}` });
    }
    const request = await requestPasswordReset(h, { email: 'ada@example.test' });
    if (request === undefined) throw new Error('setup');
    await completePasswordReset(h, request.token, 'a new long passphrase');
    expect((await h.users.findById(userId))?.lockedUntil).toBeNull();
    expect(
      (await signIn(h, { email: 'ada@example.test', password: 'a new long passphrase' })).outcome,
    ).toBe('authenticated');
  });

  /**
   * A change requires the CURRENT password even though the session already proves identity.
   * A session can be stolen; this is what stops a stolen one becoming permanent ownership.
   */
  it('requires the current password to change it', async () => {
    const userId = await activeUser('ada@example.test');
    await expect(
      changePassword(h, {
        userId,
        currentPassword: 'not the password',
        newPassword: 'a new long passphrase',
      }),
    ).rejects.toThrow(/current password is incorrect/i);
  });

  it('keeps the current device signed in and drops the others', async () => {
    const userId = await activeUser('ada@example.test');
    const keep = await signIn(h, { email: 'ada@example.test', password: PASSWORD });
    const drop = await signIn(h, { email: 'ada@example.test', password: PASSWORD });
    if (keep.outcome !== 'authenticated' || drop.outcome !== 'authenticated')
      throw new Error('setup');

    await changePassword(h, {
      userId,
      currentPassword: PASSWORD,
      newPassword: 'a new long passphrase',
      currentSessionId: keep.sessionId,
    });
    expect((await authenticateSession(h, keep.token)).ok).toBe(true);
    expect((await authenticateSession(h, drop.token)).ok).toBe(false);
  });
});
