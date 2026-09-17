/**
 * Writing audit events.
 *
 * TRANSACTIONAL BY CONSTRUCTION. The recorder is handed the SAME client the business
 * mutation is running on, so the event and the change it describes commit together or not at
 * all (05-data-architecture.md §9). There is no queue, no fire-and-forget and no `.catch()`
 * — an audit write that fails must fail the action, because the alternative is a mutation
 * that happened with no record that it did.
 *
 * WHY NOT THE OUTBOX. ADR-0007's outbox exists so that an effect in ANOTHER system (a queue,
 * an email) is not lost when the transaction it belongs to commits. Audit has no other
 * system: the record lives in the same database as the change, so the transaction already
 * gives it exactly the guarantee the outbox would be reconstructing. Routing it through the
 * outbox would make the audit record ASYNCHRONOUS — a window in which the change is visible
 * and unrecorded — which is strictly worse. Domain events about audited actions still go
 * through the outbox; the audit row itself does not need to.
 */

import { randomUUID } from 'node:crypto';
import { genesisHash, hashEvent } from './canonical.js';
import type { AuditActor, AuditEventInput, AuditEventRecord } from './event.js';
import { redactMetadata } from './redact.js';

/** The subset of `pg` this needs; a PoolClient satisfies it. */
export interface AuditQueryable {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

export interface AuditRecorder {
  record(event: AuditEventInput): Promise<AuditEventRecord>;
}

export interface RecorderOptions {
  readonly now?: () => Date;
}

/**
 * Claims the next position in an organization's chain.
 *
 * `FOR UPDATE` is what makes concurrent writers safe. Without it two transactions read the
 * same tip, both chain from it, and the log forks — two events at the same sequence, each
 * claiming the other's predecessor. The lock is taken on ONE narrow row keyed by
 * organization, so writers in different tenants never contend; the serialization is per
 * organization, which is what a per-organization chain means.
 *
 * The insert-then-lock shape handles the first event of an organization, where there is no
 * row to lock yet. Two concurrent first writers both attempt the insert; one wins, the other
 * does nothing and then finds the winner's row.
 */
async function claimNextPosition(
  db: AuditQueryable,
  organizationId: string,
): Promise<{ sequence: number; prevHash: Buffer }> {
  await db.query(
    `INSERT INTO audit_chain_heads (organization_id, last_sequence, last_hash)
       VALUES ($1, 0, $2)
     ON CONFLICT (organization_id) DO NOTHING`,
    [organizationId, genesisHash(organizationId)],
  );

  const head = await db.query<{ last_sequence: string; last_hash: Buffer }>(
    `SELECT last_sequence, last_hash FROM audit_chain_heads
      WHERE organization_id = $1
      FOR UPDATE`,
    [organizationId],
  );
  const row = head.rows[0];
  if (row === undefined) {
    // The head is created above and never deleted (no DELETE grant), so this is
    // unreachable — unless the row is invisible, which means the tenant context does not
    // match the organization being audited. Failing loudly beats writing an unchained event.
    throw new Error(`No audit chain head is visible for organization ${organizationId}`);
  }

  return { sequence: Number(row.last_sequence) + 1, prevHash: row.last_hash };
}

function normaliseActor(actor: AuditActor): AuditActor {
  return {
    type: actor.type,
    ...(actor.userId === undefined ? {} : { userId: actor.userId }),
    ...(actor.apiKeyId === undefined ? {} : { apiKeyId: actor.apiKeyId }),
    ...(actor.impersonatorUserId === undefined
      ? {}
      : { impersonatorUserId: actor.impersonatorUserId }),
  };
}

/**
 * Builds a recorder bound to one transaction.
 *
 * Bound rather than pooled deliberately: a recorder that could reach a different connection
 * is a recorder that can write an audit event for a transaction which then rolls back.
 */
export function createAuditRecorder(
  db: AuditQueryable,
  options: RecorderOptions = {},
): AuditRecorder {
  const now = options.now ?? (() => new Date());

  return {
    async record(input) {
      const { sequence, prevHash } = await claimNextPosition(db, input.organizationId);

      const unsealed = {
        id: randomUUID(),
        organizationId: input.organizationId,
        sequence,
        occurredAt: input.occurredAt ?? now(),
        actor: normaliseActor(input.actor),
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        workspaceId: input.workspaceId ?? null,
        result: input.result,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        requestId: input.requestId ?? null,
        // Redacted BEFORE hashing, so what the chain commits to is what is stored. Hashing
        // the raw value would make the stored row fail its own verification.
        metadata: redactMetadata(input.metadata),
      } satisfies Omit<AuditEventRecord, 'hash' | 'prevHash'>;

      const hash = hashEvent(unsealed, prevHash);

      await db.query(
        `INSERT INTO audit_events
           (id, organization_id, sequence, occurred_at, actor_type, actor_user_id,
            actor_api_key_id, impersonator_user_id, action, resource_type, resource_id,
            workspace_id, result, ip, user_agent, request_id, metadata, prev_hash, hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
                 $17, $18, $19)`,
        [
          unsealed.id,
          unsealed.organizationId,
          unsealed.sequence,
          unsealed.occurredAt,
          unsealed.actor.type,
          unsealed.actor.userId ?? null,
          unsealed.actor.apiKeyId ?? null,
          unsealed.actor.impersonatorUserId ?? null,
          unsealed.action,
          unsealed.resourceType,
          unsealed.resourceId,
          unsealed.workspaceId,
          unsealed.result,
          unsealed.ip,
          unsealed.userAgent,
          unsealed.requestId,
          JSON.stringify(unsealed.metadata),
          prevHash,
          hash,
        ],
      );

      await db.query(
        `UPDATE audit_chain_heads
            SET last_sequence = $2, last_hash = $3, updated_at = now()
          WHERE organization_id = $1`,
        [unsealed.organizationId, unsealed.sequence, hash],
      );

      return { ...unsealed, prevHash, hash };
    },
  };
}
