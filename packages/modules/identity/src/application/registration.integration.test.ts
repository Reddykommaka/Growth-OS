/**
 * Registration and email verification — against real PostgreSQL.
 *
 * Uniqueness, single-use tokens and the concurrent-redemption race are all properties OF the
 * database, so none of them is tested against a fake.
 */
import { hashToken } from '@growth-os/authn';
import { ConflictError, ValidationError } from '@growth-os/errors';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  closeIdentityFixture,
  type IdentityFixture,
  openIdentityFixture,
  TEST_PASSWORD as PASSWORD,
  resetIdentityTables,
} from '../__testing__/db-fixture.js';
import { register, resendVerification, verifyEmail } from './index.js';

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
async function _activeUser(email: string): Promise<string> {
  const { userId, verificationToken } = await register(h, { email, password: PASSWORD });
  await verifyEmail(h, verificationToken);
  return userId;
}

describe('registration', () => {
  it('creates a pending user and a verification token', async () => {
    const result = await register(h, { email: 'ada@example.test', password: PASSWORD });
    expect(result.userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.verificationToken).toHaveLength(43);

    const row = await h.users.findByEmail('ada@example.test');
    expect(row?.status).toBe('pending_verification');
    expect(row?.emailVerifiedAt).toBeNull();
  });

  it('stores an argon2id hash, never the password', async () => {
    await register(h, { email: 'ada@example.test', password: PASSWORD });
    const stored = await db.pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE email = $1',
      ['ada@example.test'],
    );
    const hash = stored.rows[0]?.password_hash ?? '';
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
    expect(hash).not.toContain(PASSWORD);
  });

  /** Only sha256(token) is stored, so a database leak yields nothing presentable. */
  it('stores only the hash of the verification token', async () => {
    const { verificationToken } = await register(h, {
      email: 'ada@example.test',
      password: PASSWORD,
    });
    const stored = await db.pool.query<{ token_hash: Buffer }>(
      'SELECT token_hash FROM user_tokens',
    );
    expect(stored.rows[0]?.token_hash.equals(hashToken(verificationToken))).toBe(true);
    const asText = stored.rows[0]?.token_hash.toString('base64url') ?? '';
    expect(asText).not.toBe(verificationToken);
  });

  it('refuses a duplicate address', async () => {
    await register(h, { email: 'ada@example.test', password: PASSWORD });
    await expect(register(h, { email: 'ada@example.test', password: PASSWORD })).rejects.toThrow(
      ConflictError,
    );
  });

  it('treats addresses case-insensitively, as citext does', async () => {
    await register(h, { email: 'Ada@Example.test', password: PASSWORD });
    await expect(register(h, { email: 'ada@example.TEST', password: PASSWORD })).rejects.toThrow(
      ConflictError,
    );
  });

  it('trims whitespace so a pasted address is the same address', async () => {
    await register(h, { email: '  ada@example.test  ', password: PASSWORD });
    expect(await h.users.findByEmail('ada@example.test')).toBeDefined();
  });

  it('rejects an implausible address before touching the database', async () => {
    for (const bad of ['', 'ada', 'ada@', '@example.test', 'ada@example', 'a b@c.test']) {
      await expect(register(h, { email: bad, password: PASSWORD }), bad).rejects.toThrow(
        ValidationError,
      );
    }
    expect((await db.pool.query('SELECT 1 FROM users')).rowCount).toBe(0);
  });

  it('rejects a weak password and writes nothing', async () => {
    await expect(register(h, { email: 'ada@example.test', password: 'short' })).rejects.toThrow(
      ValidationError,
    );
    expect((await db.pool.query('SELECT 1 FROM users')).rowCount).toBe(0);
  });

  it('records an audit event carrying no credential', async () => {
    const { verificationToken } = await register(h, {
      email: 'ada@example.test',
      password: PASSWORD,
    });
    const event = h.audit.find('identity.user.registered');
    expect(event).toBeDefined();
    const serialised = JSON.stringify(event);
    expect(serialised).not.toContain(PASSWORD);
    expect(serialised).not.toContain(verificationToken);
    expect(serialised).not.toContain('argon2');
  });
});

describe('email verification', () => {
  it('verifies and activates the account', async () => {
    const { userId, verificationToken } = await register(h, {
      email: 'ada@example.test',
      password: PASSWORD,
    });
    expect(await verifyEmail(h, verificationToken)).toBe('verified');
    const user = await h.users.findById(userId);
    expect(user?.status).toBe('active');
    expect(user?.emailVerifiedAt).not.toBeNull();
  });

  /** Replay prevention: the second presentation of the same token must lose. */
  it('refuses a second use of the same token', async () => {
    const { verificationToken } = await register(h, {
      email: 'ada@example.test',
      password: PASSWORD,
    });
    expect(await verifyEmail(h, verificationToken)).toBe('verified');
    expect(await verifyEmail(h, verificationToken)).toBe('invalid');
  });

  /**
   * The race the conditional UPDATE exists for. Two concurrent presentations of the same
   * token would both pass a read-then-write check; exactly one may win.
   */
  it('lets exactly one of two concurrent uses win', async () => {
    const { verificationToken } = await register(h, {
      email: 'ada@example.test',
      password: PASSWORD,
    });
    const results = await Promise.all([
      verifyEmail(h, verificationToken),
      verifyEmail(h, verificationToken),
    ]);
    expect(results.filter((r) => r === 'verified')).toHaveLength(1);
    expect(results.filter((r) => r !== 'verified')).toHaveLength(1);
  });

  it('refuses an expired token', async () => {
    const { verificationToken } = await register(h, {
      email: 'ada@example.test',
      password: PASSWORD,
    });
    h.clock.advance(25 * 60 * 60 * 1000);
    expect(await verifyEmail(h, verificationToken)).toBe('expired');
  });

  it('refuses a forged token', async () => {
    await register(h, { email: 'ada@example.test', password: PASSWORD });
    expect(await verifyEmail(h, 'a'.repeat(43))).toBe('invalid');
  });

  /** Re-issuing invalidates the previous token, so three emails leave one live link. */
  it('invalidates the previous token when re-issued', async () => {
    const { userId, verificationToken: first } = await register(h, {
      email: 'ada@example.test',
      password: PASSWORD,
    });
    const { verificationToken: second } = await resendVerification(h, userId);
    expect(await verifyEmail(h, first)).toBe('invalid');
    expect(await verifyEmail(h, second)).toBe('verified');
  });
});
