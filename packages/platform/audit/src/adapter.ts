/**
 * The production `AuditSink` — the bridge between the port application services write
 * through and the hash-chained recorder.
 *
 * Until this existed, `createAuditRecorder` was constructed only in tests: the table, the
 * chain, the policies and the port were all in place and none of them were connected, so no
 * invitation, key, sign-in or MFA action actually left a row.
 *
 * ATOMICITY IS THE CALLER'S TO GIVE. The sink writes through whatever `Queryable` it is
 * handed:
 *
 *   - handed a TRANSACTION CLIENT, the audit row commits with the change it describes, which
 *     is what 05-data-architecture.md §9 requires and what every organization service does;
 *   - handed a POOL, each write is its own implicit transaction. The row still lands, is
 *     still chained and is still verifiable, but it is no longer coupled to the mutation.
 *
 * The second form is not a shortcut to reach for. It exists because a service without a unit
 * of work has no transaction to join, and dropping its security events entirely would be
 * worse than recording them independently. `requireTransaction` refuses it outright for
 * callers that can guarantee better.
 */

import type { AuditActor } from './event.js';
import type { AuditQueryable, AuditRecorder } from './recorder.js';
import { createAuditRecorder } from './recorder.js';
import { type AuditEntry, type AuditSink, PLATFORM_ORGANIZATION_ID } from './sink.js';

export interface AuditSinkOptions {
  readonly now?: (() => Date) | undefined;
  /**
   * Refuses to write outside a transaction.
   *
   * A caller that HAS a unit of work should set this: it turns "the audit row quietly
   * committed on its own" into a loud failure, which is the difference between a bug found
   * in review and one found during an incident.
   */
  readonly requireTransaction?: boolean | undefined;
}

/**
 * Whether this client is inside an explicit transaction block.
 *
 * Asked of PostgreSQL, not inferred. `SAVEPOINT` is only legal inside a transaction block and
 * raises 25P01 (`no_active_sql_transaction`) outside one, which makes it the one probe that
 * cannot be fooled by connection state or by how the client was constructed.
 *
 * `transaction_timestamp()` was the obvious alternative and is wrong: it equals
 * `statement_timestamp()` on the first statement of a transaction, so it reports "no
 * transaction" exactly when a transaction has just opened — the common case here.
 *
 * Only run when the caller opted into `requireTransaction`, so the normal path pays nothing.
 */
async function inTransaction(db: AuditQueryable): Promise<boolean> {
  try {
    await db.query('SAVEPOINT audit_transaction_probe');
    await db.query('RELEASE SAVEPOINT audit_transaction_probe');
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === '25P01') return false;
    throw error;
  }
}

function actorFor(entry: AuditEntry): AuditActor {
  return entry.actor;
}

/**
 * Builds a sink bound to one client.
 *
 * Bound rather than pooled deliberately, mirroring the recorder: a sink that could reach a
 * different connection is a sink that can record an event for a transaction which then rolls
 * back — the dual-write failure, reintroduced one layer up.
 */
export function createAuditSink(db: AuditQueryable, options: AuditSinkOptions = {}): AuditSink {
  const recorder: AuditRecorder = createAuditRecorder(db, {
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  return {
    async record(entry) {
      if (options.requireTransaction === true && !(await inTransaction(db))) {
        throw new Error(
          'This audit sink requires a transaction: the caller declared one and none is open.',
        );
      }

      await recorder.record({
        // An entry with no organization is a security event that PRECEDES any tenant — a
        // failed sign-in against an address belonging to nobody. It joins the reserved
        // platform chain rather than being dropped, because a log that is silent exactly
        // when an intrusion is most active is not a log.
        organizationId: entry.organizationId ?? PLATFORM_ORGANIZATION_ID,
        actor: actorFor(entry),
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        result: entry.result,
        ...(entry.workspaceId === undefined ? {} : { workspaceId: entry.workspaceId }),
        ...(entry.ip === undefined ? {} : { ip: entry.ip }),
        ...(entry.userAgent === undefined ? {} : { userAgent: entry.userAgent }),
        ...(entry.requestId === undefined ? {} : { requestId: entry.requestId }),
        ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
      });
    },
  };
}
