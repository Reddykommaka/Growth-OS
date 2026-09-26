/**
 * The relay against a real database, running as the relay role.
 *
 * Every property here is a concurrency or privilege property, so none of them can be tested
 * against a fake: per-organization ordering depends on PostgreSQL advisory locks, at-least-once
 * depends on the order of a publish and a commit, and the relay's reach depends on grants.
 */
import {
  acquireTestDatabase,
  setTenantContext,
  stopSharedCluster,
  type TestDatabase,
} from '@growth-os/testing';
import { Client, Pool, type PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createOutboxPublisher } from './outbox.js';
import {
  type EventSink,
  type RelayQueryable,
  type RelayTransactor,
  readOutboxLag,
  relayOnce,
  type StagedEvent,
  tryClaimOrganization,
} from './relay.js';

let db: TestDatabase;
let admin: Client;
let relayPool: Pool;

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

beforeAll(async () => {
  db = await acquireTestDatabase();
  admin = new Client({ connectionString: db.adminUrl });
  await admin.connect();
  relayPool = new Pool({ connectionString: db.relayUrl, max: 5 });
}, 120_000);

afterAll(async () => {
  await relayPool?.end();
  await admin?.end();
  await db?.close();
  await stopSharedCluster();
});

afterEach(async () => {
  await admin.query('DELETE FROM outbox_events');
});

/** A transactor over the relay pool, as apps/worker will supply. */
function transactorOn(pool: Pool): RelayTransactor {
  return {
    async run(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client as unknown as RelayQueryable);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

/** Records what it was handed, and can be told to fail for named events. */
function recordingSink(failFor: (event: StagedEvent) => boolean = () => false): {
  sink: EventSink;
  seen: StagedEvent[];
} {
  const seen: StagedEvent[] = [];
  return {
    seen,
    sink: {
      async publish(event) {
        if (failFor(event)) throw new Error(`sink refused ${event.name}`);
        seen.push(event);
      },
    },
  };
}

async function stage(
  organizationId: string,
  names: readonly string[],
  startAt = Date.parse('2026-09-20T10:00:00Z'),
): Promise<void> {
  const client: PoolClient = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await setTenantContext(client, { organizationId, workspaceIds: [] });
    await createOutboxPublisher(client).stageAll(
      names.map((name, index) => ({
        name,
        organizationId,
        payload: { name },
        // Distinct instants, ascending, so ordering is a real assertion rather than an
        // accident of insertion order.
        occurredAt: new Date(startAt + index * 1000),
      })),
    );
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

const stateOf = async (): Promise<
  { event_name: string; published: boolean; attempts: number; dead: boolean }[]
> => {
  const r = await admin.query<{
    event_name: string;
    published: boolean;
    attempts: number;
    dead: boolean;
  }>(
    `SELECT event_name, published_at IS NOT NULL AS published, attempts,
            dead_lettered_at IS NOT NULL AS dead
       FROM outbox_events ORDER BY occurred_at, id`,
  );
  return r.rows;
};

describe('a healthy pass', () => {
  it('publishes every pending event and marks it', async () => {
    await stage(ORG_A, ['social.post.published', 'social.post.metric_recorded']);
    const { sink, seen } = recordingSink();
    const pass = await relayOnce(transactorOn(relayPool), sink);

    expect(pass).toEqual({ published: 2, failed: 0, deadLettered: 0, contended: 0 });
    expect(seen.map((e) => e.name)).toEqual([
      'social.post.published',
      'social.post.metric_recorded',
    ]);
    expect((await stateOf()).every((r) => r.published)).toBe(true);
  });

  it('is a no-op on an empty outbox', async () => {
    const { sink, seen } = recordingSink();
    expect(await relayOnce(transactorOn(relayPool), sink)).toEqual({
      published: 0,
      failed: 0,
      deadLettered: 0,
      contended: 0,
    });
    expect(seen).toEqual([]);
  });

  it('does not republish what it already published', async () => {
    await stage(ORG_A, ['social.post.published']);
    const first = recordingSink();
    await relayOnce(transactorOn(relayPool), first.sink);
    const second = recordingSink();
    await relayOnce(transactorOn(relayPool), second.sink);
    expect(second.seen).toEqual([]);
  });

  it('carries the event identity a consumer dedupes on', async () => {
    await stage(ORG_A, ['social.post.published']);
    const { sink, seen } = recordingSink();
    await relayOnce(transactorOn(relayPool), sink);
    // At-least-once delivery is only tolerable because the consumer can recognise a repeat,
    // and the id is what it recognises it by.
    expect(seen[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[0]?.organizationId).toBe(ORG_A);
    expect(seen[0]?.attempts).toBe(0);
  });

  it('respects the batch size, leaving the rest in order for the next pass', async () => {
    await stage(ORG_A, ['a.b.one', 'a.b.two', 'a.b.three']);
    const first = recordingSink();
    await relayOnce(transactorOn(relayPool), first.sink, { batchSize: 2 });
    expect(first.seen.map((e) => e.name)).toEqual(['a.b.one', 'a.b.two']);
    const second = recordingSink();
    await relayOnce(transactorOn(relayPool), second.sink, { batchSize: 2 });
    expect(second.seen.map((e) => e.name)).toEqual(['a.b.three']);
  });
});

describe('ordering', () => {
  /**
   * THE GUARANTEE 08 §2 MAKES. Not global ordering — per-organization ordering. A consumer may
   * rely on seeing an organization's events in the order they happened, and on nothing more.
   */
  it('publishes one organization events in occurred_at order', async () => {
    await stage(ORG_A, ['a.b.first', 'a.b.second', 'a.b.third']);
    const { sink, seen } = recordingSink();
    await relayOnce(transactorOn(relayPool), sink);
    expect(seen.map((e) => e.name)).toEqual(['a.b.first', 'a.b.second', 'a.b.third']);
  });

  it('stops an organization at its first failure rather than skipping past it', async () => {
    await stage(ORG_A, ['a.b.first', 'a.b.poison', 'a.b.third']);
    const { sink, seen } = recordingSink((e) => e.name === 'a.b.poison');
    const pass = await relayOnce(transactorOn(relayPool), sink);

    // Publishing `third` would put it ahead of an event that has not been delivered, which is
    // exactly the reordering the ordering guarantee forbids.
    expect(seen.map((e) => e.name)).toEqual(['a.b.first']);
    expect(pass.published).toBe(1);
    expect(pass.failed).toBe(1);
    const state = await stateOf();
    expect(state.map((r) => [r.event_name, r.published, r.attempts])).toEqual([
      ['a.b.first', true, 0],
      ['a.b.poison', false, 1],
      ['a.b.third', false, 0],
    ]);
  });

  it('does not let one organization failure hold up another', async () => {
    await stage(ORG_A, ['a.b.poison']);
    await stage(ORG_B, ['a.b.fine']);
    const { sink, seen } = recordingSink((e) => e.name === 'a.b.poison');
    const pass = await relayOnce(transactorOn(relayPool), sink);
    expect(seen.map((e) => e.name)).toEqual(['a.b.fine']);
    expect(pass).toMatchObject({ published: 1, failed: 1 });
  });

  /**
   * Row-level SKIP LOCKED alone does NOT give per-organization ordering: worker A locks event
   * 1, worker B skips it and publishes event 2 first. The advisory lock is what prevents that,
   * and this is the test that would catch its removal.
   */
  it('gives one organization to one worker at a time', async () => {
    await stage(ORG_A, ['a.b.first', 'a.b.second']);

    // Hold ORG_A's advisory lock from outside, as a second relay worker would.
    const holder = await relayPool.connect();
    try {
      await holder.query('BEGIN');
      // The relay's own claim function, so the test cannot drift from what the relay does.
      expect(await tryClaimOrganization(holder as unknown as RelayQueryable, ORG_A)).toBe(true);

      const { sink, seen } = recordingSink();
      const pass = await relayOnce(transactorOn(relayPool), sink);
      expect(seen).toEqual([]);
      expect(pass.contended).toBe(1);
      await holder.query('ROLLBACK');
    } finally {
      holder.release();
    }

    // …and once the lock is released the batch relays in order.
    const { sink, seen } = recordingSink();
    await relayOnce(transactorOn(relayPool), sink);
    expect(seen.map((e) => e.name)).toEqual(['a.b.first', 'a.b.second']);
  });
});

describe('dead-lettering', () => {
  it('quarantines an event past the attempt threshold so its organization drains', async () => {
    await stage(ORG_A, ['a.b.poison', 'a.b.behind_it']);
    const { sink } = recordingSink((e) => e.name === 'a.b.poison');
    const transactor = transactorOn(relayPool);

    for (let attempt = 0; attempt < 3; attempt++) {
      await relayOnce(transactor, sink, { maxAttempts: 3 });
    }

    const state = await stateOf();
    expect(state[0]).toMatchObject({ event_name: 'a.b.poison', dead: true, attempts: 3 });
    // The point of the quarantine: the organization is no longer blocked.
    expect(state[1]).toMatchObject({ event_name: 'a.b.behind_it', published: false });

    const after = recordingSink();
    await relayOnce(transactor, after.sink, { maxAttempts: 3 });
    expect(after.seen.map((e) => e.name)).toEqual(['a.b.behind_it']);
  });

  it('never marks a dead-lettered event published', async () => {
    await stage(ORG_A, ['a.b.poison']);
    const { sink } = recordingSink(() => true);
    await relayOnce(transactorOn(relayPool), sink, { maxAttempts: 1 });
    const r = await admin.query<{ published_at: Date | null; dead_lettered_at: Date | null }>(
      'SELECT published_at, dead_lettered_at FROM outbox_events',
    );
    // A published timestamp would claim a delivery that never happened, which makes "was this
    // delivered" unanswerable — the one question this table exists to answer.
    expect(r.rows[0]?.published_at).toBeNull();
    expect(r.rows[0]?.dead_lettered_at).not.toBeNull();
  });

  it('records the failure reason, truncated', async () => {
    await stage(ORG_A, ['a.b.poison']);
    const long = 'x'.repeat(5000);
    const sink: EventSink = {
      publish() {
        return Promise.reject(new Error(long));
      },
    };
    await relayOnce(transactorOn(relayPool), sink, { maxAttempts: 5 });
    const r = await admin.query<{ last_error: string }>('SELECT last_error FROM outbox_events');
    // Unbounded, one pathological error message turns into table bloat on a queue.
    expect(r.rows[0]?.last_error.length).toBe(1000);
    expect(r.rows[0]?.last_error.startsWith('Error: xxx')).toBe(true);
  });
});

describe('lag', () => {
  it('reports pending count, age and dead-letter depth separately', async () => {
    await stage(ORG_A, ['a.b.one'], Date.parse('2026-09-20T10:00:00Z'));
    const before = await readOutboxLag(relayPool as unknown as RelayQueryable);
    expect(before.pending).toBe(1);
    expect(before.oldestSeconds).toBeGreaterThan(0);
    expect(before.deadLettered).toBe(0);

    const { sink } = recordingSink();
    await relayOnce(transactorOn(relayPool), sink);
    const after = await readOutboxLag(relayPool as unknown as RelayQueryable);
    expect(after.pending).toBe(0);
    // Null, not zero: "no backlog" and "a backlog keeping up" are different states, and a
    // dashboard that cannot tell them apart reports an incident that is not happening.
    expect(after.oldestSeconds).toBeNull();
  });

  it('excludes dead-lettered rows from lag, so the lag alert stays meaningful', async () => {
    await stage(ORG_A, ['a.b.poison']);
    const { sink } = recordingSink(() => true);
    await relayOnce(transactorOn(relayPool), sink, { maxAttempts: 1 });
    const lag = await readOutboxLag(relayPool as unknown as RelayQueryable);
    // Counting them would leave the lag alert permanently firing, and a permanently firing
    // alert is how a real backlog goes unnoticed.
    expect(lag.pending).toBe(0);
    expect(lag.deadLettered).toBe(1);
  });
});

describe('the relay role is bounded', () => {
  it('cannot insert an event', async () => {
    // A relay that could write events could manufacture side effects for any tenant, with
    // BYPASSRLS meaning no policy would stop it.
    await expect(
      relayPool.query(
        `INSERT INTO outbox_events (organization_id, event_name, payload)
         VALUES ($1, 'a.b.c', '{}'::jsonb)`,
        [ORG_A],
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('cannot read tenant data outside the tables it relays', async () => {
    for (const table of ['organizations', 'users', 'audit_events', 'api_keys']) {
      await expect(relayPool.query(`SELECT 1 FROM ${table} LIMIT 1`), table).rejects.toThrow(
        /permission denied/,
      );
    }
  });

  it('cannot create anything in the schema', async () => {
    await expect(relayPool.query('CREATE TABLE relay_should_not (id int)')).rejects.toThrow(
      /permission denied/,
    );
  });

  it('prunes only published rows', async () => {
    await stage(ORG_A, ['a.b.published', 'a.b.pending']);
    const { sink } = recordingSink((e) => e.name === 'a.b.pending');
    await relayOnce(transactorOn(relayPool), sink);

    // Zero grace: everything published is eligible.
    const removed = await relayPool.query<{ prune_published_outbox_events: string }>(
      "SELECT prune_published_outbox_events(interval '0 seconds')",
    );
    expect(Number(removed.rows[0]?.prune_published_outbox_events)).toBe(1);
    const left = await stateOf();
    // An unpublished row survives. A pruner that could remove one would make silent event loss
    // a one-argument mistake.
    expect(left.map((r) => r.event_name)).toEqual(['a.b.pending']);
  });

  it('refuses a non-positive prune batch size', async () => {
    await expect(
      relayPool.query("SELECT prune_published_outbox_events(interval '0 seconds', 0)"),
    ).rejects.toThrow(/batch_size must be positive/);
  });
});
