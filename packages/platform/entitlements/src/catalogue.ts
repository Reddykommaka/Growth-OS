/**
 * The capability catalogue.
 *
 * A capability is something an ORGANIZATION has, bought or granted. It is not a permission —
 * permissions say whether an ACTOR may perform an operation, and the two are independent in
 * both directions:
 *
 *   an owner holds every permission in their organization, and still cannot run an AI agent
 *   on a plan that does not include `ai.agents`;
 *
 *   a plan that includes `ai.agents` does not let a `viewer` start one.
 *
 * A protected operation passes BOTH checks or it does not happen.
 *
 * WHY A CODE CATALOGUE AND NOT A TABLE. The set of capabilities the software can offer is a
 * property of the software, exactly as `PERMISSIONS` is. A table that could disagree with the
 * code about which capabilities exist is a second source of truth, and the disagreement shows
 * up as a plan granting something no code path consults — or worse, as a typo'd key that
 * silently denies. `plan_features.capability_key` is therefore deliberately NOT a foreign
 * key, and a structural test asserts every stored key is one the catalogue declares.
 */

/**
 * How a capability is limited.
 *
 * `boolean` — you have it or you do not. No counting.
 * `counter` — a quantity consumed within a billing period and reset with it (scheduled
 *             posts, AI credits, automation runs). Consumption is enforced atomically.
 * `gauge`   — a quantity held at a point in time, not consumed (connected accounts, team
 *             members, workspaces). Going over is impossible to "use up"; the check is
 *             against the CURRENT count, which the caller supplies because only the owning
 *             module knows how to count its own rows.
 *
 * The distinction is load-bearing. A counter that is reset per period and a gauge that is
 * not cannot share an enforcement path: resetting a gauge would silently forgive an
 * over-limit state, and metering a gauge as consumption would let deleting and recreating a
 * social account exhaust the plan.
 */
export type LimitKind = 'boolean' | 'counter' | 'gauge';

/** Where a capability is measured. Teams are deliberately absent — see `EntitlementScope`. */
export type CapabilityScope = 'organization' | 'workspace';

export interface Capability {
  readonly key: string;
  readonly module: string;
  readonly limit: LimitKind;
  readonly scope: CapabilityScope;
  /**
   * What an organization gets with NO plan feature and NO override.
   *
   * Stated per capability rather than assumed, because "the default" is exactly the hidden
   * fallback that makes an entitlement system unexplainable. Every resolution reports which
   * of these four sources produced it, and `default` is one of them.
   */
  readonly fallback: { readonly enabled: boolean; readonly limit?: number | undefined };
  readonly description: string;
}

/**
 * Every capability the platform can gate on.
 *
 * The modules below are largely unbuilt; the ENTITLEMENT CONTRACT for them is not. Declaring
 * the keys now is what lets each module gate on its own capability the day it lands, instead
 * of that module inventing a parallel scheme and the platform growing two.
 */
export const CAPABILITIES: readonly Capability[] = [
  // ---- social ------------------------------------------------------------------------
  cap(
    'social.accounts',
    'social',
    'gauge',
    'workspace',
    { enabled: true, limit: 2 },
    'Connected social accounts held per workspace.',
  ),
  cap(
    'social.publishing',
    'social',
    'boolean',
    'workspace',
    { enabled: true },
    'Publishing a post to a connected account.',
  ),
  cap(
    'social.scheduling',
    'social',
    'counter',
    'workspace',
    { enabled: true, limit: 30 },
    'Posts scheduled within the billing period.',
  ),
  cap(
    'social.analytics',
    'social',
    'boolean',
    'workspace',
    { enabled: false },
    'Post and account performance reporting.',
  ),
  cap(
    'social.inbox',
    'social',
    'boolean',
    'workspace',
    { enabled: false },
    'Unified comment and message inbox.',
  ),
  cap(
    'social.team.collaboration',
    'social',
    'boolean',
    'organization',
    { enabled: false },
    'Approval workflows and multi-user review.',
  ),

  // ---- marketing ---------------------------------------------------------------------
  cap(
    'marketing.campaigns',
    'marketing',
    'counter',
    'workspace',
    { enabled: false, limit: 0 },
    'Campaigns created within the billing period.',
  ),
  cap(
    'marketing.ads',
    'marketing',
    'boolean',
    'workspace',
    { enabled: false },
    'Paid advertising management.',
  ),
  cap(
    'marketing.leads',
    'marketing',
    'gauge',
    'workspace',
    { enabled: false, limit: 0 },
    'Leads held per workspace.',
  ),
  cap(
    'marketing.automation',
    'marketing',
    'counter',
    'organization',
    { enabled: false, limit: 0 },
    'Automation runs executed within the billing period.',
  ),
  cap(
    'marketing.analytics',
    'marketing',
    'boolean',
    'workspace',
    { enabled: false },
    'Attribution and campaign reporting.',
  ),

  // ---- ai ----------------------------------------------------------------------------
  cap(
    'ai.chat',
    'ai',
    'counter',
    'organization',
    { enabled: false, limit: 0 },
    'Assistant messages within the billing period.',
  ),
  cap(
    'ai.content',
    'ai',
    'counter',
    'organization',
    { enabled: false, limit: 0 },
    'Generated content pieces within the billing period.',
  ),
  cap(
    'ai.research',
    'ai',
    'boolean',
    'organization',
    { enabled: false },
    'Research and enrichment capabilities.',
  ),
  cap(
    'ai.agents',
    'ai',
    'counter',
    'organization',
    { enabled: false, limit: 0 },
    'Autonomous agent invocations within the billing period.',
  ),
  cap(
    'ai.image',
    'ai',
    'counter',
    'organization',
    { enabled: false, limit: 0 },
    'Image generations within the billing period.',
  ),
  cap(
    'ai.video',
    'ai',
    'counter',
    'organization',
    { enabled: false, limit: 0 },
    'Video generations within the billing period.',
  ),
  cap(
    'ai.automation',
    'ai',
    'boolean',
    'organization',
    { enabled: false },
    'AI steps inside automation workflows.',
  ),

  // ---- marketplace -------------------------------------------------------------------
  cap(
    'marketplace.buying',
    'marketplace',
    'boolean',
    'organization',
    { enabled: true },
    'Purchasing listings.',
  ),
  cap(
    'marketplace.selling',
    'marketplace',
    'boolean',
    'organization',
    { enabled: false },
    'Publishing listings for sale.',
  ),
  cap(
    'marketplace.payments',
    'marketplace',
    'boolean',
    'organization',
    { enabled: true },
    'Taking payment for an order.',
  ),
  cap(
    'marketplace.payouts',
    'marketplace',
    'boolean',
    'organization',
    { enabled: false },
    'Receiving payouts as a seller.',
  ),

  // ---- platform ----------------------------------------------------------------------
  cap(
    'platform.workspaces',
    'platform',
    'gauge',
    'organization',
    { enabled: true, limit: 1 },
    'Workspaces held by the organization.',
  ),
  cap(
    'platform.members',
    'platform',
    'gauge',
    'organization',
    { enabled: true, limit: 3 },
    'Organization members held.',
  ),
  cap(
    'platform.api_requests',
    'platform',
    'counter',
    'organization',
    { enabled: true, limit: 10_000 },
    'API requests within the billing period.',
  ),
  cap(
    'platform.storage_bytes',
    'platform',
    'gauge',
    'organization',
    { enabled: true, limit: 1_073_741_824 },
    'Stored file bytes held.',
  ),
  cap(
    'platform.integrations',
    'platform',
    'gauge',
    'organization',
    { enabled: true, limit: 3 },
    'Active third-party connections held.',
  ),
];

function cap(
  key: string,
  module: string,
  limit: LimitKind,
  scope: CapabilityScope,
  fallback: { enabled: boolean; limit?: number },
  description: string,
): Capability {
  return {
    key,
    module,
    limit,
    scope,
    fallback: fallback.limit === undefined ? { enabled: fallback.enabled } : fallback,
    description,
  };
}

const BY_KEY: ReadonlyMap<string, Capability> = new Map(CAPABILITIES.map((c) => [c.key, c]));

/** The capability a key names, or undefined. Callers must treat undefined as a hard error. */
export function capability(key: string): Capability | undefined {
  return BY_KEY.get(key);
}

export function capabilityKeys(): readonly string[] {
  return CAPABILITIES.map((c) => c.key);
}

/** Keys the catalogue does not declare. Used by the structural check over stored rows. */
export function unknownCapabilityKeys(keys: readonly string[]): readonly string[] {
  return [...new Set(keys.filter((k) => !BY_KEY.has(k)))];
}
