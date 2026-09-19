/**
 * Entitlement resolution.
 *
 * Pure. Given the facts — the capability, the plan's feature row, any overrides, the current
 * usage — it produces a decision and the reason for it. No database, no clock beyond what is
 * passed in, no fallback that is not stated in the result.
 *
 * WHY THE RESULT CARRIES ITS OWN EXPLANATION. "Why can this customer not schedule a post?"
 * is a support question asked daily, and answering it by reading code and guessing which
 * branch ran is how an entitlement system becomes something nobody will change. Every
 * decision names the SOURCE that produced it and the RULE that decided it, so the answer is
 * in the response rather than in a debugger.
 */

import type { Capability, CapabilityScope } from './catalogue.js';

/** Where a decision came from, in precedence order — highest first. */
export type EntitlementSource = 'workspace_override' | 'organization_override' | 'plan' | 'default';

export type LimitDecision =
  | { readonly kind: 'unlimited' }
  | { readonly kind: 'bounded'; readonly value: number }
  /** The capability is limited to nothing: present in the catalogue, granted zero. */
  | { readonly kind: 'none' };

export interface EntitlementFacts {
  readonly capability: Capability;
  /** The feature row from the organization's active plan, if the plan declares one. */
  readonly planFeature?: FeatureGrant | undefined;
  readonly organizationOverride?: ExpiringGrant | undefined;
  readonly workspaceOverride?: ExpiringGrant | undefined;
  /** Consumption so far: the counter for a `counter`, the live count for a `gauge`. */
  readonly used?: number | undefined;
  readonly now: Date;
}

export interface FeatureGrant {
  readonly enabled: boolean;
  readonly limitValue?: number | undefined;
  readonly isUnlimited: boolean;
}

export interface ExpiringGrant extends FeatureGrant {
  readonly expiresAt?: Date | null | undefined;
  readonly reason: string;
}

export interface EntitlementDecision {
  readonly capabilityKey: string;
  readonly scope: CapabilityScope;
  readonly enabled: boolean;
  readonly limit: LimitDecision;
  readonly used: number;
  /** Undefined when the limit is unlimited or the capability is boolean. */
  readonly remaining?: number | undefined;
  readonly source: EntitlementSource;
  /** One sentence, safe to show an operator. Never contains commercial terms or secrets. */
  readonly rule: string;
}

/** An expired override is not an override. Checked here so precedence cannot skip it. */
function live(grant: ExpiringGrant | undefined, now: Date): FeatureGrant | undefined {
  if (grant === undefined) return undefined;
  if (grant.expiresAt != null && grant.expiresAt <= now) return undefined;
  return grant;
}

function limitFrom(grant: FeatureGrant): LimitDecision {
  if (!grant.enabled) return { kind: 'none' };
  if (grant.isUnlimited) return { kind: 'unlimited' };
  if (grant.limitValue === undefined) return { kind: 'unlimited' };
  return grant.limitValue === 0 ? { kind: 'none' } : { kind: 'bounded', value: grant.limitValue };
}

/**
 * Resolves one capability.
 *
 * Precedence, highest first, with no step skipped and no step implicit:
 *
 *   1. a live workspace override   — the narrowest grant wins, so one client can be given
 *                                    something the rest of the organization does not have
 *   2. a live organization override
 *   3. the plan's feature row
 *   4. the catalogue fallback
 *
 * A DISABLING override beats an enabling plan feature. That direction matters: revoking a
 * capability for a specific customer (abuse, non-payment, a legal hold) must not require
 * moving them off their plan.
 */
export function resolveEntitlement(facts: EntitlementFacts): EntitlementDecision {
  const { capability, now } = facts;
  const workspace = live(facts.workspaceOverride, now);
  const organization = live(facts.organizationOverride, now);

  const [grant, source, rule]: [FeatureGrant, EntitlementSource, string] =
    workspace !== undefined
      ? [workspace, 'workspace_override', `a workspace override for ${capability.key}`]
      : organization !== undefined
        ? [organization, 'organization_override', `an organization override for ${capability.key}`]
        : facts.planFeature !== undefined
          ? [facts.planFeature, 'plan', `the organization's plan grants ${capability.key}`]
          : [
              {
                enabled: capability.fallback.enabled,
                ...(capability.fallback.limit === undefined
                  ? {}
                  : { limitValue: capability.fallback.limit }),
                isUnlimited: false,
              },
              'default',
              `no plan feature or override applies, so the catalogue default for ${capability.key}`,
            ];

  const limit = limitFrom(grant);
  const used = facts.used ?? 0;
  const remaining = limit.kind === 'bounded' ? Math.max(limit.value - used, 0) : undefined;

  return {
    capabilityKey: capability.key,
    scope: capability.scope,
    enabled: grant.enabled && limit.kind !== 'none',
    limit,
    used,
    ...(remaining === undefined ? {} : { remaining }),
    source,
    rule,
  };
}

export type DenialReason =
  | 'not_entitled'
  | 'limit_reached'
  | 'would_exceed_limit'
  | 'unknown_capability';

export type EntitlementVerdict =
  | { readonly allowed: true; readonly decision: EntitlementDecision }
  | {
      readonly allowed: false;
      readonly reason: DenialReason;
      readonly decision: EntitlementDecision;
    };

/**
 * Whether a request for `quantity` units is allowed against a decision.
 *
 * Separated from resolution because the same decision answers many questions: a UI asks
 * "is this enabled at all" (quantity 0) while a write asks "may I take 5". Folding the two
 * together would make every read pretend to be a consumption.
 */
export function checkAllowance(decision: EntitlementDecision, quantity = 1): EntitlementVerdict {
  if (!decision.enabled) return { allowed: false, reason: 'not_entitled', decision };
  if (decision.limit.kind !== 'bounded') return { allowed: true, decision };
  if (decision.used >= decision.limit.value) {
    return { allowed: false, reason: 'limit_reached', decision };
  }
  if (decision.used + quantity > decision.limit.value) {
    return { allowed: false, reason: 'would_exceed_limit', decision };
  }
  return { allowed: true, decision };
}
