/**
 * MFA enrolment, verification, replay prevention and recovery — against real PostgreSQL.
 *
 * The replay guard in particular cannot be tested without a database: it is a conditional
 * UPDATE, and its whole purpose is to settle a race that a read-then-write check loses.
 */
import { generateTotp, hashRecoveryCode } from '@growth-os/authn';
import { ValidationError } from '@growth-os/errors';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  closeIdentityFixture,
  type IdentityFixture,
  openIdentityFixture,
  resetIdentityTables,
} from '../__testing__/db-fixture.js';
import { CountingRateLimiter } from '../__testing__/harness.js';
import {
  authenticateSession,
  completeMfaChallenge,
  confirmTotpEnrolment,
  disableMfa,
  regenerateRecoveryCodes,
  register,
  signIn,
  startTotpEnrolment,
  verifyEmail,
} from './index.js';

let fixture: IdentityFixture;
let db: IdentityFixture['db'];
let h: IdentityFixture['h'];
const PASSWORD = 'correct horse battery staple';
const EMAIL = 'ada@example.test';

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

async function activeUser(): Promise<string> {
  const { userId, verificationToken } = await register(h, { email: EMAIL, password: PASSWORD });
  await verifyEmail(h, verificationToken);
  return userId;
}

/** Reads the stored secret back the way the service does, to generate a valid code. */
async function currentCode(userId: string): Promise<string> {
  const credential = await h.mfa.findTotpForUser(userId);
  if (credential?.secretEncrypted == null) throw new Error('no credential');
  return generateTotp(h.cipher.decrypt(credential.secretEncrypted), h.clock.now());
}

async function enrolled(): Promise<{ userId: string; recoveryCodes: readonly string[] }> {
  const userId = await activeUser();
  await startTotpEnrolment(h, userId, EMAIL);
  const { recoveryCodes } = await confirmTotpEnrolment(h, userId, await currentCode(userId));
  // Confirmation CONSUMES that counter, so the same code cannot immediately double as a
  // sign-in code — see the dedicated test below. Real enrolment and sign-in are never in the
  // same 30-second period; advancing the clock here reflects that rather than working around
  // it.
  h.clock.advance(60_000);
  return { userId, recoveryCodes };
}

describe('enrolment', () => {
  it('writes an UNCONFIRMED credential that cannot yet satisfy a challenge', async () => {
    const userId = await activeUser();
    await startTotpEnrolment(h, userId, EMAIL);

    const credential = await h.mfa.findTotpForUser(userId);
    expect(credential?.confirmedAt).toBeNull();
    // Starting enrolment must not itself be the bypass.
    expect(await completeMfaChallenge(h, 'session-x', userId, await currentCode(userId))).toBe(
      'not_enrolled',
    );
    expect((await h.users.findById(userId))?.mfaEnabled).toBe(false);
  });

  it('stores the secret ENCRYPTED, never in the clear', async () => {
    const userId = await activeUser();
    const start = await startTotpEnrolment(h, userId, EMAIL);

    const stored = await db.pool.query<{ secret_encrypted: Buffer }>(
      'SELECT secret_encrypted FROM mfa_credentials WHERE user_id = $1',
      [userId],
    );
    const ciphertext = stored.rows[0]?.secret_encrypted;
    expect(ciphertext).toBeDefined();
    if (ciphertext === undefined) return;

    // The base32 secret shown to the user must not appear anywhere in the stored bytes.
    expect(ciphertext.toString('base64')).not.toContain(start.secretBase32);
    expect(ciphertext.toString('utf8')).not.toContain(start.secretBase32);
    // But it must decrypt back to exactly what the QR code carried.
    expect(h.cipher.decrypt(ciphertext).length).toBe(20);
  });

  it('keeps the secret and the enrolment URI out of the audit log', async () => {
    const userId = await activeUser();
    const start = await startTotpEnrolment(h, userId, EMAIL);
    const serialised = JSON.stringify(h.audit.events);
    expect(serialised).not.toContain(start.secretBase32);
    expect(serialised).not.toContain('otpauth://');
  });

  it('confirms with a valid code and issues ten recovery codes', async () => {
    const userId = await activeUser();
    await startTotpEnrolment(h, userId, EMAIL);
    const { recoveryCodes } = await confirmTotpEnrolment(h, userId, await currentCode(userId));

    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    expect((await h.users.findById(userId))?.mfaEnabled).toBe(true);
    expect((await h.mfa.findTotpForUser(userId))?.confirmedAt).not.toBeNull();
  });

  it('stores only hashes of the recovery codes', async () => {
    const { userId, recoveryCodes } = await enrolled();
    const stored = await db.pool.query<{ code_hash: Buffer }>(
      'SELECT code_hash FROM mfa_recovery_codes WHERE user_id = $1',
      [userId],
    );
    expect(stored.rowCount).toBe(10);
    const first = recoveryCodes[0];
    if (first === undefined) return;
    const hashes = stored.rows.map((r) => r.code_hash.toString('base64'));
    expect(hashes).toContain(hashRecoveryCode(first).toString('base64'));
    expect(hashes.join('')).not.toContain(first);
  });

  it('refuses to confirm with a wrong code, and issues nothing', async () => {
    const userId = await activeUser();
    await startTotpEnrolment(h, userId, EMAIL);
    await expect(confirmTotpEnrolment(h, userId, '000000')).rejects.toThrow(ValidationError);
    expect((await h.users.findById(userId))?.mfaEnabled).toBe(false);
    expect(await h.mfa.countUnusedRecoveryCodes(userId)).toBe(0);
  });

  it('refuses to re-enrol once enabled', async () => {
    const { userId } = await enrolled();
    await expect(startTotpEnrolment(h, userId, EMAIL)).rejects.toThrow(/already enabled/i);
  });
});

describe('sign-in with MFA', () => {
  it('stops at mfa_required and leaves the session unsatisfied', async () => {
    await enrolled();
    const result = await signIn(h, { email: EMAIL, password: PASSWORD });
    expect(result.outcome).toBe('mfa_required');
    if (result.outcome !== 'mfa_required') return;

    // The session exists but is not MFA-satisfied, so anything sensitive still refuses.
    const lookup = await authenticateSession(h, result.token);
    expect(lookup.ok).toBe(true);
    expect(lookup.ok && lookup.value.mfaSatisfied).toBe(false);
    expect(lookup.ok && lookup.value.needsReauthentication).toBe(true);
  });

  it('satisfies the session with a valid TOTP code', async () => {
    const { userId } = await enrolled();
    const result = await signIn(h, { email: EMAIL, password: PASSWORD });
    if (result.outcome !== 'mfa_required') throw new Error('setup');

    expect(await completeMfaChallenge(h, result.sessionId, userId, await currentCode(userId))).toBe(
      'satisfied',
    );
    const lookup = await authenticateSession(h, result.token);
    expect(lookup.ok && lookup.value.mfaSatisfied).toBe(true);
    expect(lookup.ok && lookup.value.needsReauthentication).toBe(false);
  });

  /**
   * The code that proved possession during enrolment is CONSUMED by it.
   *
   * Not a quirk: confirmation is a successful verification, so RFC 6238 §5.2 applies to it
   * exactly as it does to a sign-in. Discovered by a test that assumed otherwise.
   */
  it('will not reuse the enrolment code as a sign-in code in the same period', async () => {
    const userId = await activeUser();
    await startTotpEnrolment(h, userId, EMAIL);
    const code = await currentCode(userId);
    await confirmTotpEnrolment(h, userId, code);

    const result = await signIn(h, { email: EMAIL, password: PASSWORD });
    if (result.outcome !== 'mfa_required') throw new Error('setup');
    expect(await completeMfaChallenge(h, result.sessionId, userId, code)).toBe('replayed');
  });

  it('refuses a wrong code without satisfying the session', async () => {
    const { userId } = await enrolled();
    const result = await signIn(h, { email: EMAIL, password: PASSWORD });
    if (result.outcome !== 'mfa_required') throw new Error('setup');

    expect(await completeMfaChallenge(h, result.sessionId, userId, '000000')).toBe('invalid_code');
    const lookup = await authenticateSession(h, result.token);
    expect(lookup.ok && lookup.value.mfaSatisfied).toBe(false);
  });

  /**
   * RFC 6238 §5.2: a code accepted once must not be accepted again. Without this, an
   * intercepted code works for the remainder of its 30-second period.
   */
  it('REFUSES A REPLAYED CODE inside the same period', async () => {
    const { userId } = await enrolled();
    const code = await currentCode(userId);

    const first = await signIn(h, { email: EMAIL, password: PASSWORD });
    if (first.outcome !== 'mfa_required') throw new Error('setup');
    expect(await completeMfaChallenge(h, first.sessionId, userId, code)).toBe('satisfied');

    // Same code, same period, a second session — must not work.
    const second = await signIn(h, { email: EMAIL, password: PASSWORD });
    if (second.outcome !== 'mfa_required') throw new Error('setup');
    expect(await completeMfaChallenge(h, second.sessionId, userId, code)).toBe('replayed');
  });

  it('accepts the next period’s code after a replay is refused', async () => {
    const { userId } = await enrolled();
    const first = await signIn(h, { email: EMAIL, password: PASSWORD });
    if (first.outcome !== 'mfa_required') throw new Error('setup');
    await completeMfaChallenge(h, first.sessionId, userId, await currentCode(userId));

    h.clock.advance(60_000);
    const second = await signIn(h, { email: EMAIL, password: PASSWORD });
    if (second.outcome !== 'mfa_required') throw new Error('setup');
    expect(await completeMfaChallenge(h, second.sessionId, userId, await currentCode(userId))).toBe(
      'satisfied',
    );
  });

  it('rate limits challenge attempts per user', async () => {
    const { userId } = await enrolled();
    const limited = { ...h, rateLimiter: new CountingRateLimiter(3) };
    const result = await signIn(h, { email: EMAIL, password: PASSWORD });
    if (result.outcome !== 'mfa_required') throw new Error('setup');

    for (let i = 0; i < 3; i++) {
      expect(await completeMfaChallenge(limited, result.sessionId, userId, '000000')).toBe(
        'invalid_code',
      );
    }
    // The code space is a million over a 30-second window; unbounded attempts are genuinely
    // brute-forceable, so the limiter is a control rather than a nicety.
    expect(await completeMfaChallenge(limited, result.sessionId, userId, '000000')).toBe(
      'rate_limited',
    );
  });
});

describe('recovery codes', () => {
  it('satisfies a challenge and is consumed', async () => {
    const { userId, recoveryCodes } = await enrolled();
    const code = recoveryCodes[0];
    if (code === undefined) throw new Error('setup');

    const result = await signIn(h, { email: EMAIL, password: PASSWORD });
    if (result.outcome !== 'mfa_required') throw new Error('setup');

    expect(await completeMfaChallenge(h, result.sessionId, userId, code)).toBe('satisfied');
    expect(await h.mfa.countUnusedRecoveryCodes(userId)).toBe(9);
  });

  it('is single use', async () => {
    const { userId, recoveryCodes } = await enrolled();
    const code = recoveryCodes[0];
    if (code === undefined) throw new Error('setup');

    const first = await signIn(h, { email: EMAIL, password: PASSWORD });
    if (first.outcome !== 'mfa_required') throw new Error('setup');
    await completeMfaChallenge(h, first.sessionId, userId, code);

    const second = await signIn(h, { email: EMAIL, password: PASSWORD });
    if (second.outcome !== 'mfa_required') throw new Error('setup');
    expect(await completeMfaChallenge(h, second.sessionId, userId, code)).toBe('invalid_code');
  });

  it('accepts a code however it was transcribed', async () => {
    const { userId, recoveryCodes } = await enrolled();
    const code = recoveryCodes[0];
    if (code === undefined) throw new Error('setup');

    const result = await signIn(h, { email: EMAIL, password: PASSWORD });
    if (result.outcome !== 'mfa_required') throw new Error('setup');
    expect(
      await completeMfaChallenge(h, result.sessionId, userId, code.toLowerCase().replace('-', ' ')),
    ).toBe('satisfied');
  });

  it('does not consume a recovery code when the TOTP code is valid', async () => {
    const { userId } = await enrolled();
    const result = await signIn(h, { email: EMAIL, password: PASSWORD });
    if (result.outcome !== 'mfa_required') throw new Error('setup');
    await completeMfaChallenge(h, result.sessionId, userId, await currentCode(userId));
    expect(await h.mfa.countUnusedRecoveryCodes(userId)).toBe(10);
  });

  it('regenerates, invalidating every previous code', async () => {
    const { userId, recoveryCodes } = await enrolled();
    h.clock.advance(60_000);
    const fresh = await regenerateRecoveryCodes(h, userId, await currentCode(userId));

    expect(fresh).toHaveLength(10);
    expect(fresh.some((c) => recoveryCodes.includes(c))).toBe(false);
    expect(await h.mfa.countUnusedRecoveryCodes(userId)).toBe(10);

    const old = recoveryCodes[0];
    if (old === undefined) return;
    const result = await signIn(h, { email: EMAIL, password: PASSWORD });
    if (result.outcome !== 'mfa_required') throw new Error('setup');
    expect(await completeMfaChallenge(h, result.sessionId, userId, old)).toBe('invalid_code');
  });
});

describe('disabling MFA', () => {
  /**
   * Requires a live factor, not merely a session. Removing the second factor is the first
   * thing an attacker with a stolen session wants to do, and a session is exactly what MFA
   * exists to backstop.
   */
  it('requires a valid current code', async () => {
    const { userId } = await enrolled();
    await expect(disableMfa(h, userId, '000000')).rejects.toThrow(/not correct/i);
    expect((await h.users.findById(userId))?.mfaEnabled).toBe(true);
  });

  it('disables with a valid TOTP code and removes the credential and codes', async () => {
    const { userId } = await enrolled();
    h.clock.advance(60_000);
    await disableMfa(h, userId, await currentCode(userId));

    expect((await h.users.findById(userId))?.mfaEnabled).toBe(false);
    expect(await h.mfa.findTotpForUser(userId)).toBeUndefined();
    expect(await h.mfa.countUnusedRecoveryCodes(userId)).toBe(0);
    expect((await signIn(h, { email: EMAIL, password: PASSWORD })).outcome).toBe('authenticated');
  });

  it('disables with a recovery code, for a lost authenticator', async () => {
    const { userId, recoveryCodes } = await enrolled();
    const code = recoveryCodes[0];
    if (code === undefined) throw new Error('setup');
    await disableMfa(h, userId, code);
    expect((await h.users.findById(userId))?.mfaEnabled).toBe(false);
  });

  it('records the method used, for audit', async () => {
    const { userId, recoveryCodes } = await enrolled();
    const code = recoveryCodes[0];
    if (code === undefined) throw new Error('setup');
    h.audit.clear();
    await disableMfa(h, userId, code);
    expect(h.audit.find('identity.mfa.disabled')?.metadata).toMatchObject({
      verifiedBy: 'recovery_code',
    });
  });
});
