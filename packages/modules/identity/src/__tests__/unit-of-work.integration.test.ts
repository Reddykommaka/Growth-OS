/**
 * The identity unit of work, against real PostgreSQL and the REAL hash-chained audit sink.
 *
 * The sibling suites assert what identity does; this one asserts that a half of it can never
 * be left behind. Every case here is a property of the transaction, so none of it can be
 * established with a mock — and the audit sink is the production one, because the guarantee
 * being tested is that the security record commits with the change rather than beside it.
 */

import {
  type AuditEntry,
  type AuditQueryable,
  type AuditSink,
  createAuditReader,
  PLATFORM_ORGANIZATION_ID,
  verifyChain,
} from '@growth-os/audit';
import { createSecretCipher, generateSecretKey } from '@growth-os/authn';
import { acquireTestDatabase, stopSharedCluster, type TestDatabase } from '@growth-os/testing';
import { Client, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  completePasswordReset,
  confirmTotpEnrolment,
  register,
  requestPasswordReset,
  signIn,
  startTotpEnrolment,
  verifyEmail,
} from '../application/index.js';
import { createMfaRepository } from '../infrastructure/mfa-repository.js';
import { createSessionRepository } from '../infrastructure/session-repository.js';
import { createIdentityUnitOfWork } from '../infrastructure/unit-of-work.js';
import { createUserRepository } from '../infrastructure/user-repository.js';
import { createUserTokenRepository } from '../infrastructure/user-token-repository.js';

let db: TestDatabase;
let admin: Client;

const PASSWORD = 'correct horse battery staple';
const clock = { now: () => new Date('2026-09-18T09:00:00.000Z') };
// One cipher for the whole suite. A fresh key per `productionDeps()` call cannot decrypt a
// secret an earlier one encrypted, which fails as "Could not decrypt the stored secret" and
// looks like an MFA defect rather than a test defect.
const cipher = createSecretCipher(generateSecretKey());

/**
 * The sink a service would reach if it wrote an audit event OUTSIDE its unit of work.
 *
 * Throwing rather than recording turns that into a visible failure: every audited write in
 * this suite is therefore proved to run inside the transaction, not merely assumed to.
 */
const outsideUnitOfWork: AuditSink = {
  record: async () => {
    throw new Error('audit write attempted outside the unit of work');
  },
};

/** Production dependencies: the real unit of work, the real chained audit sink. */
function productionDeps(overrides: { audit?: (client: AuditQueryable) => AuditSink } = {}) {
  const unitOfWork =
    overrides.audit === undefined
      ? createIdentityUnitOfWork(db.pool, { now: clock.now })
      : createIdentityUnitOfWork(db.pool, { now: clock.now, auditSink: overrides.audit });
  return {
    unitOfWork,
    clock,
    audit: outsideUnitOfWork,
    cipher,
    users: createUserRepository(db.pool),
    tokens: createUserTokenRepository(db.pool),
    sessions: createSessionRepository(db.pool),
    mfa: createMfaRepository(db.pool),
  };
}

/**
 * A sink that records normally until the nth call, then throws.
 *
 * The realistic failure: the mutation succeeded and the audit write did not. Under a unit of
 * work that must take the mutation down with it, because a change with no record is the one
 * outcome the audit design exists to prevent.
 */
function failingAuditSink(failOnCall: number, inner: (c: AuditQueryable) => AuditSink) {
  let calls = 0;
  return (client: AuditQueryable): AuditSink => {
    const delegate = inner(client);
    return {
      async record(entry: AuditEntry) {
        calls += 1;
        if (calls === failOnCall) throw new Error('audit sink unavailable');
        await delegate.record(entry);
      },
    };
  };
}

async function platformEvents() {
  const r = await admin.query<{ action: string; sequence: string; result: string }>(
    `SELECT action, sequence, result FROM audit_events
      WHERE organization_id = $1 ORDER BY sequence`,
    [PLATFORM_ORGANIZATION_ID],
  );
  return r.rows;
}

const countUsers = async (email: string): Promise<number> =>
  (await admin.query('SELECT 1 FROM users WHERE email = $1', [email])).rowCount ?? 0;

beforeAll(async () => {
  db = await acquireTestDatabase();
  admin = new Client({ connectionString: db.adminUrl });
  await admin.connect();
}, 180_000);

afterAll(async () => {
  await admin.end();
  await db.close();
  await stopSharedCluster();
});

beforeEach(async () => {
  await admin.query('DELETE FROM audit_events');
  await admin.query('DELETE FROM audit_chain_heads');
  await admin.query('DELETE FROM user_tokens');
  await admin.query('DELETE FROM sessions');
  await admin.query('DELETE FROM mfa_credentials');
  await admin.query('DELETE FROM users');
});

describe('a mutation and its audit event commit together', () => {
  it('registration writes the user, the token and the audit row as one unit', async () => {
    const deps = productionDeps();
    const { userId } = await register(deps, { email: 'atomic@example.test', password: PASSWORD });

    expect(await countUsers('atomic@example.test')).toBe(1);
    expect(
      (await admin.query('SELECT 1 FROM user_tokens WHERE user_id = $1', [userId])).rowCount,
    ).toBe(1);
    const events = await platformEvents();
    expect(events.map((e) => e.action)).toContain('identity.user.registered');
  });

  it('the identity chain is a real chain and verifies', async () => {
    const deps = productionDeps();
    await register(deps, { email: 'chain@example.test', password: PASSWORD });
    await register(deps, { email: 'chain2@example.test', password: PASSWORD });

    const events = await withPlatformScope(
      async (c) => await createAuditReader(c).chainSlice(PLATFORM_ORGANIZATION_ID, 1, 100),
    );
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(verifyChain(PLATFORM_ORGANIZATION_ID, events)).toMatchObject({ valid: true });
  });
});

/** Reads the platform chain through a session scoped to the reserved id — the operator path. */
async function withPlatformScope<T>(body: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', [
      'app.organization_id',
      PLATFORM_ORGANIZATION_ID,
    ]);
    await client.query('SELECT set_config($1, $2, true)', ['app.workspace_ids', '{}']);
    await client.query('SELECT set_config($1, $2, true)', ['app.workspace_scope', 'all']);
    const value = await body(client);
    await client.query('COMMIT');
    return value;
  } finally {
    client.release();
  }
}

describe('a failing audit write takes the mutation down with it', () => {
  /**
   * THE CENTRAL CLAIM. Before the unit of work, the user row committed on its own and the
   * audit failure vanished into a rejected promise — a registered account with no record that
   * it was ever created.
   */
  it('registration leaves NO user when the audit write fails', async () => {
    const deps = productionDeps({ audit: failingAuditSink(1, () => ({ record: async () => {} })) });

    await expect(
      register(deps, { email: 'doomed@example.test', password: PASSWORD }),
    ).rejects.toThrow(/audit sink unavailable/);

    expect(await countUsers('doomed@example.test')).toBe(0);
    expect((await admin.query('SELECT 1 FROM user_tokens')).rowCount).toBe(0);
    expect(await platformEvents()).toEqual([]);
  });

  it('and the address is free afterwards — no ghost row blocks a retry', async () => {
    const failing = productionDeps({
      audit: failingAuditSink(1, () => ({ record: async () => {} })),
    });
    await expect(
      register(failing, { email: 'retry@example.test', password: PASSWORD }),
    ).rejects.toThrow();

    const { userId } = await register(productionDeps(), {
      email: 'retry@example.test',
      password: PASSWORD,
    });
    expect(userId).toBeDefined();
    expect(await countUsers('retry@example.test')).toBe(1);
  });
});

describe('multi-write sequences are all-or-nothing', () => {
  /**
   * `verifyEmail` consumes the token and then marks the address verified. Failing between
   * them used to leave a consumed token and an unverified user — an account that can never be
   * verified again, because the token it would need is spent.
   */
  it('a failed verification leaves the token unconsumed and the user unverified', async () => {
    const { userId, verificationToken } = await register(productionDeps(), {
      email: 'verify@example.test',
      password: PASSWORD,
    });
    await admin.query('DELETE FROM audit_events');
    await admin.query('DELETE FROM audit_chain_heads');

    const deps = productionDeps({ audit: failingAuditSink(1, () => ({ record: async () => {} })) });
    await expect(verifyEmail(deps, verificationToken)).rejects.toThrow(/audit sink unavailable/);

    const token = await admin.query<{ consumed_at: Date | null }>(
      'SELECT consumed_at FROM user_tokens WHERE user_id = $1',
      [userId],
    );
    expect(token.rows[0]?.consumed_at).toBeNull();
    const user = await admin.query<{ status: string }>('SELECT status FROM users WHERE id = $1', [
      userId,
    ]);
    expect(user.rows[0]?.status).toBe('pending_verification');

    // And the honest path still works: the token was never spent.
    expect(await verifyEmail(productionDeps(), verificationToken)).toBe('verified');
  });

  /**
   * `completePasswordReset` sets the hash AND revokes every session. Stopping after the hash
   * leaves the attacker's session live through the victim's password change.
   */
  it('a failed password reset changes neither the hash nor the sessions', async () => {
    const deps = productionDeps();
    const { userId, verificationToken } = await register(deps, {
      email: 'reset@example.test',
      password: PASSWORD,
    });
    await verifyEmail(deps, verificationToken);
    const signedIn = await signIn(deps, { email: 'reset@example.test', password: PASSWORD });
    expect(signedIn.outcome).toBe('authenticated');

    const before = await admin.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [userId],
    );
    const reset = await requestPasswordReset(deps, { email: 'reset@example.test' });
    if (reset === undefined) throw new Error('setup');

    const failing = productionDeps({
      audit: failingAuditSink(1, () => ({ record: async () => {} })),
    });
    await expect(
      completePasswordReset(failing, reset.token, 'a different correct horse staple'),
    ).rejects.toThrow(/audit sink unavailable/);

    const after = await admin.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [userId],
    );
    expect(after.rows[0]?.password_hash).toBe(before.rows[0]?.password_hash);
    const live = await admin.query(
      `SELECT 1 FROM sessions WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    expect(live.rowCount).toBe(1);
  });

  /**
   * `confirmTotpEnrolment` confirms the credential, flags the user and writes the recovery
   * codes. A partial apply leaves MFA half-on — the state that locks a user out or lets them
   * past a factor they think is protecting them.
   */
  it('a failed MFA confirmation leaves MFA entirely off', async () => {
    const deps = productionDeps();
    const { userId, verificationToken } = await register(deps, {
      email: 'mfa@example.test',
      password: PASSWORD,
    });
    await verifyEmail(deps, verificationToken);
    const enrolment = await startTotpEnrolment(deps, userId, 'mfa@example.test');

    const { base32Decode, generateTotp } = await import('@growth-os/authn');
    // The enrolment hands the USER a base32 string; the algorithm takes the bytes behind it.
    const code = generateTotp(base32Decode(enrolment.secretBase32), clock.now());

    const failing = productionDeps({
      audit: failingAuditSink(1, () => ({ record: async () => {} })),
    });
    await expect(confirmTotpEnrolment(failing, userId, code)).rejects.toThrow(
      /audit sink unavailable/,
    );

    const user = await admin.query<{ mfa_enabled: boolean }>(
      'SELECT mfa_enabled FROM users WHERE id = $1',
      [userId],
    );
    expect(user.rows[0]?.mfa_enabled).toBe(false);
    const confirmed = await admin.query(
      'SELECT 1 FROM mfa_credentials WHERE user_id = $1 AND confirmed_at IS NOT NULL',
      [userId],
    );
    expect(confirmed.rowCount).toBe(0);
  });
});
