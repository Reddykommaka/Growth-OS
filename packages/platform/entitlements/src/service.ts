/**
 * The entitlement service: resolve, and consume.
 *
 * TWO OPERATIONS, DELIBERATELY DISTINCT.
 *
 *   `resolve` answers a question and changes nothing. A UI asking what to grey out, an
 *   operator asking why a customer is blocked.
 *
 *   `consume` is the GATE. It takes the units it is asking for and returns whether it got
 *   them, in one atomic step, because a resolve followed by a separate increment is the race
 *   this design exists to avoid.
 *
 * NO CACHE ON THE GATING PATH. 01-overview.md §5 states the guarantee: "Entitlement checks —
 * strong at check time — read in the same transaction as the gated write." A cached decision
 * would mean a revoked capability stays usable for the TTL, which is precisely the stale
 * privilege escalation a cache must not introduce. The resolution is two indexed reads
 * against a narrow row; the transaction the caller already holds is what makes it correct.
 * A read-only surface may cache what it displays — but what it displays is not what enforces.
 */

import { type Capability, capability } from './catalogue.js';
import type {
  ActiveSubscription,
  BillingPeriod,
  Clock,
  OverrideRepository,
  PlanFeatureReader,
  SubscriptionReader,
  UsageRepository,
} from './ports.js';
import {
  checkAllowance,
  type EntitlementDecision,
  type EntitlementVerdict,
  type ExpiringGrant,
  type FeatureGrant,
  resolveEntitlement,
} from './resolve.js';

export interface EntitlementDependencies {
  readonly subscriptions: SubscriptionReader;
  readonly planFeatures: PlanFeatureReader;
  readonly overrides: OverrideRepository;
  readonly usage: UsageRepository;
  readonly clock: Clock;
}

export interface EntitlementQuery {
  readonly organizationId: string;
  /**
   * Required for a workspace-scoped capability, ignored for an organization-scoped one.
   *
   * Ignored rather than rejected: a caller that passes a workspace for an organization meter
   * is not wrong, it is simply being more specific than the capability is measured at, and
   * failing there would push scope knowledge into every call site.
   */
  readonly workspaceId?: string | undefined;
  readonly capabilityKey: string;
}

/** The period a counter belongs to. Falls back to a calendar month with no subscription. */
function periodFor(subscription: { period: BillingPeriod } | undefined, now: Date): BillingPeriod {
  if (subscription !== undefined) return subscription.period;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

/**
 * An organization with no live subscription resolves to catalogue defaults.
 *
 * `past_due` deliberately still resolves: cutting a customer off the moment a card fails
 * turns a payment retry into an outage. Suspension is a dunning decision billing makes by
 * moving the subscription to `canceled` or by writing a disabling override — both of which
 * this resolver already honours.
 */
const LIVE_STATUSES = new Set(['trialing', 'active', 'past_due']);

export interface EntitlementService {
  resolve(query: EntitlementQuery): Promise<EntitlementDecision>;
  /** Resolve, then ask whether `quantity` units would be allowed. Changes nothing. */
  check(query: EntitlementQuery, quantity?: number): Promise<EntitlementVerdict>;
  /** THE GATE. Atomically takes the units, or refuses. */
  consume(input: ConsumeInput): Promise<EntitlementVerdict>;
}

export interface ConsumeInput extends EntitlementQuery {
  readonly quantity?: number | undefined;
  /** Attribution for the usage record — who spent it. */
  readonly actorUserId?: string | undefined;
  readonly actorApiKeyId?: string | undefined;
  /**
   * The live count, for a `gauge` capability.
   *
   * Supplied by the caller because only the owning module can count its own rows, and a
   * platform package that queried `connections` or `organization_members` directly would be
   * reaching across a module boundary the architecture forbids.
   */
  readonly currentCount?: number | undefined;
}

/** The declared capability, or a hard failure. An unknown key is a bug, not a denial. */
function declaredOr(capabilityKey: string): Capability {
  const declared = capability(capabilityKey);
  if (declared === undefined) throw new Error(`Unknown capability: ${capabilityKey}`);
  return declared;
}

/** The subscription that may supply a plan, or undefined. See LIVE_STATUSES. */
const liveSubscription = (
  subscription: ActiveSubscription | undefined,
): ActiveSubscription | undefined =>
  subscription !== undefined && LIVE_STATUSES.has(subscription.status) ? subscription : undefined;

/** The three rules that can decide a capability, read together. */
async function readRules(
  deps: EntitlementDependencies,
  organizationId: string,
  scopedWorkspace: string | null,
  declared: Capability,
  live: ActiveSubscription | undefined,
): Promise<{
  planFeature: FeatureGrant | undefined;
  organizationOverride: ExpiringGrant | undefined;
  workspaceOverride: ExpiringGrant | undefined;
}> {
  const [planFeature, organizationOverride, workspaceOverride] = await Promise.all([
    live === undefined
      ? Promise.resolve(undefined)
      : deps.planFeatures.featureFor(live.planId, declared.key),
    deps.overrides.find(organizationId, null, declared.key),
    scopedWorkspace === null
      ? Promise.resolve(undefined)
      : deps.overrides.find(organizationId, scopedWorkspace, declared.key),
  ]);
  return { planFeature, organizationOverride, workspaceOverride };
}

/** Only a counter has consumption to read; a boolean or a gauge has nothing to count. */
async function readUsed(
  deps: EntitlementDependencies,
  query: EntitlementQuery,
  declared: Capability,
  scopedWorkspace: string | null,
  periodStart: Date,
  usedOverride: number | undefined,
): Promise<number> {
  if (usedOverride !== undefined) return usedOverride;
  if (declared.limit !== 'counter') return 0;
  return deps.usage.currentUsage({
    organizationId: query.organizationId,
    workspaceId: scopedWorkspace,
    capabilityKey: declared.key,
    periodStart,
  });
}

interface Resolution {
  readonly decision: EntitlementDecision;
  readonly period: BillingPeriod;
  readonly scopedWorkspace: string | null;
}

/**
 * Reads every fact the resolver needs and resolves it. Changes nothing.
 *
 * `usedOverride` exists for a gauge, whose current count only the owning module can supply.
 */
async function decide(
  deps: EntitlementDependencies,
  query: EntitlementQuery,
  usedOverride?: number,
): Promise<Resolution> {
  const declared = declaredOr(query.capabilityKey);
  const now = deps.clock.now();
  const live = liveSubscription(await deps.subscriptions.activeFor(query.organizationId));
  const period = periodFor(live, now);

  // A workspace-scoped capability is measured per workspace; an organization-scoped one
  // ignores the workspace entirely, so its counter and its overrides are organization-wide.
  const scopedWorkspace = declared.scope === 'workspace' ? (query.workspaceId ?? null) : null;

  const rules = await readRules(deps, query.organizationId, scopedWorkspace, declared, live);
  const used = await readUsed(deps, query, declared, scopedWorkspace, period.start, usedOverride);

  const decision = resolveEntitlement({
    capability: declared,
    ...(rules.planFeature === undefined ? {} : { planFeature: rules.planFeature }),
    ...(rules.organizationOverride === undefined
      ? {}
      : { organizationOverride: rules.organizationOverride }),
    ...(rules.workspaceOverride === undefined
      ? {}
      : { workspaceOverride: rules.workspaceOverride }),
    used,
    now,
  });

  return { decision, period, scopedWorkspace };
}

/**
 * Settles a counter consumption against the database.
 *
 * Split out because it is the only part of the service that writes, and because the race it
 * loses safely is the whole reason the design is shaped this way: between the resolve above
 * and this statement another writer may take the remaining units, and the conditional UPDATE
 * is what turns that into a denial rather than an overrun.
 */
async function settleCounter(
  deps: EntitlementDependencies,
  input: ConsumeInput,
  resolution: Resolution,
  quantity: number,
): Promise<EntitlementVerdict> {
  const { decision, period, scopedWorkspace } = resolution;
  const total = await deps.usage.consume({
    organizationId: input.organizationId,
    workspaceId: scopedWorkspace,
    capabilityKey: input.capabilityKey,
    periodStart: period.start,
    quantity,
    limit: decision.limit.kind === 'bounded' ? decision.limit.value : null,
    period,
    actorUserId: input.actorUserId ?? null,
    actorApiKeyId: input.actorApiKeyId ?? null,
    at: deps.clock.now(),
  });

  if (total === undefined) {
    return { allowed: false, reason: 'would_exceed_limit', decision };
  }

  const settled: EntitlementDecision = {
    ...decision,
    used: total,
    ...(decision.limit.kind === 'bounded'
      ? { remaining: Math.max(decision.limit.value - total, 0) }
      : {}),
  };
  return { allowed: true, decision: settled };
}

export function createEntitlementService(deps: EntitlementDependencies): EntitlementService {
  return {
    async resolve(query) {
      return (await decide(deps, query)).decision;
    },

    async check(query, quantity = 1) {
      const { decision } = await decide(deps, query);
      return checkAllowance(decision, quantity);
    },

    async consume(input) {
      const quantity = input.quantity ?? 1;
      const declared = declaredOr(input.capabilityKey);
      const resolution = await decide(deps, input, input.currentCount);

      // A gauge is not consumed — it is held. Going over is checked against the count the
      // caller supplies, and there is nothing to increment.
      if (declared.limit !== 'counter') {
        return checkAllowance(resolution.decision, quantity);
      }

      // Refuse before touching the counter when the capability is off entirely: an
      // unentitled caller must not open a usage row for a capability it cannot use.
      const provisional = checkAllowance(resolution.decision, quantity);
      if (!provisional.allowed) return provisional;

      return settleCounter(deps, input, resolution, quantity);
    },
  };
}
