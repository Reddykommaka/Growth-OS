/**
 * @growth-os/entitlements — what an organization has, as distinct from what an actor may do.
 *
 * A protected operation passes the PERMISSION check (authz: may this actor?) and the
 * ENTITLEMENT check (here: does this organization have the capability, and any left?).
 * Neither implies the other.
 */
export {
  type EntitlementAdminDependencies,
  type GrantOverrideInput,
  grantOverride,
  removeOverride,
} from './administration.js';
export {
  CAPABILITIES,
  type Capability,
  type CapabilityScope,
  capability,
  capabilityKeys,
  type LimitKind,
  unknownCapabilityKeys,
} from './catalogue.js';
export type {
  ActiveSubscription,
  BillingPeriod,
  Clock,
  OverrideRepository,
  OverrideRow,
  PlanFeatureReader,
  SubscriptionReader,
  UsageKey,
  UsageRepository,
} from './ports.js';
export {
  createOverrideRepository,
  createPlanFeatureReader,
  createSubscriptionReader,
  createUsageRepository,
  type Queryable,
} from './repositories.js';
export {
  checkAllowance,
  type DenialReason,
  type EntitlementDecision,
  type EntitlementSource,
  type EntitlementVerdict,
  type ExpiringGrant,
  type FeatureGrant,
  type LimitDecision,
  resolveEntitlement,
} from './resolve.js';
export {
  type ConsumeInput,
  createEntitlementService,
  type EntitlementDependencies,
  type EntitlementQuery,
  type EntitlementService,
} from './service.js';
