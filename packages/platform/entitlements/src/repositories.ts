/**
 * PostgreSQL-backed repositories.
 *
 * Every query runs under RLS as growth_os_app, so the tenant predicate is enforced twice:
 * once by the `organization_id = $1` written here, and once by the policy. The redundancy is
 * the point — a query that forgets its filter returns nothing rather than another tenant's
 * rows.
 */

import { randomUUID } from 'node:crypto';
import type {
  ActiveSubscription,
  OverrideRepository,
  OverrideRow,
  PlanFeatureReader,
  SubscriptionReader,
  UsageKey,
  UsageRepository,
} from './ports.js';
import type { FeatureGrant } from './resolve.js';

export interface Queryable {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

/** bigint arrives from pg as a string; NULL stays NULL. */
function toNumber(value: string | number | null): number | undefined {
  if (value === null) return undefined;
  return typeof value === 'number' ? value : Number(value);
}

export function createSubscriptionReader(db: Queryable): SubscriptionReader {
  return {
    async activeFor(organizationId) {
      const r = await db.query<{
        plan_id: string;
        plan_key: string;
        status: ActiveSubscription['status'];
        current_period_start: Date;
        current_period_end: Date;
      }>(
        `SELECT s.plan_id, p.key AS plan_key, s.status,
                s.current_period_start, s.current_period_end
           FROM subscriptions s
           JOIN plans p ON p.id = s.plan_id
          WHERE s.organization_id = $1
            AND s.status IN ('trialing', 'active', 'past_due')
          LIMIT 1`,
        [organizationId],
      );
      const row = r.rows[0];
      if (row === undefined) return undefined;
      return {
        planId: row.plan_id,
        planKey: row.plan_key,
        status: row.status,
        period: { start: row.current_period_start, end: row.current_period_end },
      };
    },
  };
}

export function createPlanFeatureReader(db: Queryable): PlanFeatureReader {
  return {
    async featureFor(planId, capabilityKey) {
      const r = await db.query<{
        enabled: boolean;
        limit_value: string | null;
        is_unlimited: boolean;
      }>(
        `SELECT enabled, limit_value, is_unlimited FROM plan_features
          WHERE plan_id = $1 AND capability_key = $2`,
        [planId, capabilityKey],
      );
      const row = r.rows[0];
      if (row === undefined) return undefined;
      const limit = toNumber(row.limit_value);
      return {
        enabled: row.enabled,
        isUnlimited: row.is_unlimited,
        ...(limit === undefined ? {} : { limitValue: limit }),
      } satisfies FeatureGrant;
    },

    async allCapabilityKeys() {
      const r = await db.query<{ capability_key: string }>(
        'SELECT DISTINCT capability_key FROM plan_features',
      );
      return r.rows.map((row) => row.capability_key);
    },
  };
}

const OVERRIDE_COLUMNS =
  'id, organization_id, workspace_id, capability_key, enabled, limit_value, is_unlimited, ' +
  'reason, expires_at';

interface OverrideDbRow {
  id: string;
  organization_id: string;
  workspace_id: string | null;
  capability_key: string;
  enabled: boolean;
  limit_value: string | null;
  is_unlimited: boolean;
  reason: string;
  expires_at: Date | null;
}

function toOverride(row: OverrideDbRow): OverrideRow {
  const limit = toNumber(row.limit_value);
  return {
    id: row.id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    capabilityKey: row.capability_key,
    enabled: row.enabled,
    isUnlimited: row.is_unlimited,
    ...(limit === undefined ? {} : { limitValue: limit }),
    reason: row.reason,
    expiresAt: row.expires_at,
  };
}

export function createOverrideRepository(db: Queryable): OverrideRepository {
  return {
    async find(organizationId, workspaceId, capabilityKey) {
      // `IS NOT DISTINCT FROM` rather than `=`: the organization-scoped case has a NULL
      // workspace, and `NULL = NULL` is NULL, so a plain equality silently finds nothing.
      const r = await db.query<OverrideDbRow>(
        `SELECT ${OVERRIDE_COLUMNS} FROM entitlement_overrides
          WHERE organization_id = $1
            AND workspace_id IS NOT DISTINCT FROM $2
            AND capability_key = $3`,
        [organizationId, workspaceId, capabilityKey],
      );
      const row = r.rows[0];
      return row === undefined ? undefined : toOverride(row);
    },

    async upsert(input) {
      // Two partial unique indexes cover the NULL and non-NULL workspace cases separately,
      // so ON CONFLICT cannot name one constraint. Delete-then-insert inside the caller's
      // transaction gives the same result with one code path.
      await db.query(
        `DELETE FROM entitlement_overrides
          WHERE organization_id = $1 AND workspace_id IS NOT DISTINCT FROM $2
            AND capability_key = $3`,
        [input.organizationId, input.workspaceId, input.capabilityKey],
      );
      const id = randomUUID();
      await db.query(
        `INSERT INTO entitlement_overrides
           (id, organization_id, workspace_id, capability_key, enabled, limit_value,
            is_unlimited, reason, expires_at, granted_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          id,
          input.organizationId,
          input.workspaceId,
          input.capabilityKey,
          input.enabled,
          input.limitValue ?? null,
          input.isUnlimited,
          input.reason,
          input.expiresAt,
          input.grantedBy,
        ],
      );
      return id;
    },

    async remove(organizationId, workspaceId, capabilityKey) {
      const r = await db.query(
        `DELETE FROM entitlement_overrides
          WHERE organization_id = $1 AND workspace_id IS NOT DISTINCT FROM $2
            AND capability_key = $3`,
        [organizationId, workspaceId, capabilityKey],
      );
      return (r.rowCount ?? 0) > 0;
    },

    async listForOrganization(organizationId) {
      const r = await db.query<OverrideDbRow>(
        `SELECT ${OVERRIDE_COLUMNS} FROM entitlement_overrides
          WHERE organization_id = $1 ORDER BY capability_key`,
        [organizationId],
      );
      return r.rows.map(toOverride);
    },
  };
}

export function createUsageRepository(db: Queryable): UsageRepository {
  return {
    async currentUsage(key: UsageKey) {
      const r = await db.query<{ used: string }>(
        `SELECT used FROM entitlement_usage
          WHERE organization_id = $1 AND workspace_id IS NOT DISTINCT FROM $2
            AND capability_key = $3 AND period_start = $4`,
        [key.organizationId, key.workspaceId, key.capabilityKey, key.periodStart],
      );
      return toNumber(r.rows[0]?.used ?? null) ?? 0;
    },

    /**
     * THE ATOMIC CONSUME.
     *
     * Three statements, and the middle one is the whole mechanism:
     *
     *   1. open the period's counter if it does not exist yet (`ON CONFLICT DO NOTHING`, so
     *      two writers opening it at once do not collide);
     *   2. `UPDATE ... SET used = used + $n WHERE used + $n <= $limit` — the check and the
     *      increment are ONE statement, so there is no window between them. PostgreSQL
     *      re-evaluates the predicate against the committed row when two writers contend, so
     *      the second sees the first's total. Zero rows means the limit would have been
     *      exceeded;
     *   3. append the usage record, in the same transaction, so the counter and its history
     *      can never disagree and the counter can be rebuilt by summing the period.
     */
    async consume(input) {
      await db.query(
        `INSERT INTO entitlement_usage
           (id, organization_id, workspace_id, capability_key, period_start, period_end, used)
         VALUES ($1, $2, $3, $4, $5, $6, 0)
         ON CONFLICT DO NOTHING`,
        [
          randomUUID(),
          input.organizationId,
          input.workspaceId,
          input.capabilityKey,
          input.period.start,
          input.period.end,
        ],
      );

      const updated = await db.query<{ used: string }>(
        `UPDATE entitlement_usage
            SET used = used + $5, updated_at = now()
          WHERE organization_id = $1 AND workspace_id IS NOT DISTINCT FROM $2
            AND capability_key = $3 AND period_start = $4
            AND ($6::bigint IS NULL OR used + $5 <= $6::bigint)
          RETURNING used`,
        [
          input.organizationId,
          input.workspaceId,
          input.capabilityKey,
          input.period.start,
          input.quantity,
          input.limit,
        ],
      );

      const row = updated.rows[0];
      if (row === undefined) return undefined;

      await db.query(
        `INSERT INTO usage_records
           (id, organization_id, workspace_id, capability_key, quantity,
            actor_user_id, actor_api_key_id, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          randomUUID(),
          input.organizationId,
          input.workspaceId,
          input.capabilityKey,
          input.quantity,
          input.actorUserId,
          input.actorApiKeyId,
          input.at,
        ],
      );

      return toNumber(row.used) ?? 0;
    },
  };
}
