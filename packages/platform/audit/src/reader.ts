/**
 * Reading audit events.
 *
 * Audit records are themselves sensitive — they name who did what to whom — so reading is
 * authorised twice, by design:
 *
 *   1. the caller must hold `organization.audit_log:read`, which is declared
 *      ORGANIZATION-scoped, so no workspace-scoped role (editor, client_guest) carries it;
 *   2. every query runs under RLS, whose policy applies the tenant predicate AND the
 *      accessible-workspace set to any event tagged with a workspace.
 *
 * Neither is a substitute for the other. The permission stops a client_guest asking; the
 * policy stops a bug in the permission layer turning that into an answer.
 */

import type { AuditActorType, AuditEventRecord, AuditResult } from './event.js';
import type { AuditQueryable } from './recorder.js';

export interface AuditQuery {
  readonly organizationId: string;
  readonly workspaceId?: string | undefined;
  readonly actorUserId?: string | undefined;
  readonly action?: string | undefined;
  readonly resourceType?: string | undefined;
  readonly resourceId?: string | undefined;
  readonly occurredFrom?: Date | undefined;
  readonly occurredTo?: Date | undefined;
  /** Page size. Bounded below, so a caller cannot ask for the whole table in one query. */
  readonly limit?: number | undefined;
  /**
   * Keyset cursor: the sequence to continue BEFORE, descending.
   *
   * Not an offset. An offset over an append-only table re-reads rows that shifted when new
   * events arrived mid-pagination, so a page can repeat or skip entries — in an audit log
   * that reads as evidence going missing.
   */
  readonly before?: number | undefined;
}

export interface AuditPage {
  readonly events: readonly AuditEventRecord[];
  /** Pass as `before` to fetch the next page. Absent when the page is the last one. */
  readonly nextCursor?: number | undefined;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

interface Row {
  id: string;
  organization_id: string;
  sequence: string;
  occurred_at: Date;
  actor_type: string;
  actor_user_id: string | null;
  actor_api_key_id: string | null;
  impersonator_user_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string;
  workspace_id: string | null;
  result: string;
  ip: string | null;
  user_agent: string | null;
  request_id: string | null;
  metadata: Record<string, unknown>;
  prev_hash: Buffer;
  hash: Buffer;
}

const COLUMNS =
  'id, organization_id, sequence, occurred_at, actor_type, actor_user_id, actor_api_key_id, ' +
  'impersonator_user_id, action, resource_type, resource_id, workspace_id, result, ' +
  'host(ip) AS ip, user_agent, request_id, metadata, prev_hash, hash';

function toRecord(row: Row): AuditEventRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    sequence: Number(row.sequence),
    occurredAt: row.occurred_at,
    actor: {
      type: row.actor_type as AuditActorType,
      ...(row.actor_user_id === null ? {} : { userId: row.actor_user_id }),
      ...(row.actor_api_key_id === null ? {} : { apiKeyId: row.actor_api_key_id }),
      ...(row.impersonator_user_id === null
        ? {}
        : { impersonatorUserId: row.impersonator_user_id }),
    },
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    workspaceId: row.workspace_id,
    result: row.result as AuditResult,
    ip: row.ip,
    userAgent: row.user_agent,
    requestId: row.request_id,
    metadata: row.metadata,
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

export interface AuditReader {
  /** Newest first, keyset-paginated. */
  list(query: AuditQuery): Promise<AuditPage>;
  /**
   * Ascending by sequence, for verification.
   *
   * A separate method because the direction is not a preference: verification must walk the
   * chain forwards, and a descending page cannot be checked without being reversed — which
   * is where an off-by-one silently turns a broken chain into a valid-looking one.
   */
  chainSlice(
    organizationId: string,
    fromSequence: number,
    limit: number,
  ): Promise<readonly AuditEventRecord[]>;
}

/**
 * Turns the query into a WHERE clause and its bound parameters.
 *
 * Every filter is a bound parameter, never interpolated: the column names are fixed
 * literals in this file and the values never reach the SQL text.
 */
function buildFilter(query: AuditQuery): { where: string[]; params: unknown[] } {
  const where = ['organization_id = $1'];
  const params: unknown[] = [query.organizationId];

  const add = (clause: string, value: unknown): void => {
    params.push(value);
    where.push(clause.replace('$n', `$${params.length}`));
  };

  const filters: ReadonlyArray<readonly [string, unknown]> = [
    ['workspace_id = $n', query.workspaceId],
    ['actor_user_id = $n', query.actorUserId],
    ['action = $n', query.action],
    ['resource_type = $n', query.resourceType],
    ['resource_id = $n', query.resourceId],
    ['occurred_at >= $n', query.occurredFrom],
    ['occurred_at < $n', query.occurredTo],
    ['sequence < $n', query.before],
  ];
  for (const [clause, value] of filters) {
    if (value !== undefined) add(clause, value);
  }

  return { where, params };
}

export function createAuditReader(db: AuditQueryable): AuditReader {
  return {
    async list(query) {
      const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
      const { where, params } = buildFilter(query);

      // One extra row, to tell "this page is full" from "there is more" without a count.
      params.push(limit + 1);
      const result = await db.query<Row>(
        `SELECT ${COLUMNS} FROM audit_events
          WHERE ${where.join(' AND ')}
          ORDER BY sequence DESC
          LIMIT $${params.length}`,
        params,
      );

      const events = result.rows.slice(0, limit).map(toRecord);
      const last = events.at(-1);
      return result.rows.length > limit && last !== undefined
        ? { events, nextCursor: last.sequence }
        : { events };
    },

    async chainSlice(organizationId, fromSequence, limit) {
      const result = await db.query<Row>(
        `SELECT ${COLUMNS} FROM audit_events
          WHERE organization_id = $1 AND sequence >= $2
          ORDER BY sequence ASC
          LIMIT $3`,
        [organizationId, fromSequence, Math.min(Math.max(limit, 1), MAX_LIMIT)],
      );
      return result.rows.map(toRecord);
    },
  };
}
