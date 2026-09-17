/**
 * Identity under concurrent load, and the tenant-context boundary.
 *
 * Split from the atomicity suite for length. These are the cases the database settles rather
 * than the application: a unique index deciding which concurrent registration wins, a
 * conditional UPDATE deciding which verification consumes the token, and `SET LOCAL`
 * deciding that no tenant context survives a pooled connection.
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
import { changePassword, register, verifyEmail } from '../application/index.js';
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
function _failingAuditSink(failOnCall: number, inner: (c: AuditQueryable) => AuditSink) {
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

async function _platformEvents() {
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

describe('concurrency', () => {
  it('concurrent registration of one address yields exactly one user', async () => {
    const deps = productionDeps();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        register(deps, { email: 'race@example.test', password: PASSWORD }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await countUsers('race@example.test')).toBe(1);
  });

  it('concurrent verification of one token lets exactly one win', async () => {
    const deps = productionDeps();
    const { verificationToken } = await register(deps, {
      email: 'once@example.test',
      password: PASSWORD,
    });
    // The service reports an OUTCOME rather than throwing, so every promise resolves. What
    // must be true is that exactly one reports 'verified' — the conditional UPDATE in
    // `consume` is what decides, and the losers see 'already_used'.
    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () => verifyEmail(deps, verificationToken)),
    );
    expect(outcomes.filter((o) => o === 'verified')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'already_used')).toHaveLength(3);
  });

  it('concurrent password changes leave one hash and a verifiable chain', async () => {
    const deps = productionDeps();
    const { userId, verificationToken } = await register(deps, {
      email: 'concurrent@example.test',
      password: PASSWORD,
    });
    await verifyEmail(deps, verificationToken);

    await Promise.allSettled([
      changePassword(deps, {
        userId,
        currentPassword: PASSWORD,
        newPassword: 'first replacement passphrase',
      }),
      changePassword(deps, {
        userId,
        currentPassword: PASSWORD,
        newPassword: 'second replacement passphrase',
      }),
    ]);

    const rows = await admin.query('SELECT 1 FROM users WHERE id = $1', [userId]);
    expect(rows.rowCount).toBe(1);
    const events = await withPlatformScope(
      async (c) => await createAuditReader(c).chainSlice(PLATFORM_ORGANIZATION_ID, 1, 200),
    );
    expect(verifyChain(PLATFORM_ORGANIZATION_ID, events)).toMatchObject({ valid: true });
  });
});

describe('tenant context does not leak through the pool', () => {
  /**
   * The identity unit of work sets no `app.*` settings — identity tables are global. The risk
   * is the reverse direction: a connection that carried tenant context earlier being handed
   * back with it still set. `SET LOCAL` is what prevents that, and this asserts it across the
   * boundary rather than trusting it.
   */
  it('a connection used for identity work carries no tenant context', async () => {
    await register(productionDeps(), { email: 'ctx@example.test', password: PASSWORD });

    // Exhaust and re-check several connections: the leak, if it existed, would be on
    // whichever one the previous transaction used.
    for (let i = 0; i < 5; i++) {
      const client = await db.pool.connect();
      try {
        const r = await client.query<{ org: string | null; scope: string | null }>(
          `SELECT current_setting('app.organization_id', true) AS org,
                  current_setting('app.workspace_scope', true) AS scope`,
        );
        expect(r.rows[0]?.org ?? '').toBe('');
        expect(r.rows[0]?.scope ?? '').toBe('');
      } finally {
        client.release();
      }
    }
  });
});
