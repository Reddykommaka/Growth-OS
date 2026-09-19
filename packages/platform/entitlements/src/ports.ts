/**
 * Ports.
 *
 * THE BILLING BOUNDARY is the important one here. Entitlements read a COMMERCIAL FACT — which
 * plan is in force for this organization, and for what period — and nothing else. They do not
 * know that Stripe exists, and adding a second payment provider must not require touching a
 * line of entitlement logic (the same reasoning ADR-0013 applies to model providers).
 *
 * That is why `SubscriptionReader` returns a plan key and a period, not a provider object,
 * not a price, and not an invoice. Billing owns the provider relationship, dunning and the
 * money; entitlements own what the resulting plan permits. The seam is deliberately narrow
 * enough that the billing module can be built, replaced or re-provisioned behind it.
 */

import type { FeatureGrant } from './resolve.js';

/** A billing period. Usage counters are keyed by it and reset with it. */
export interface BillingPeriod {
  readonly start: Date;
  readonly end: Date;
}

export interface ActiveSubscription {
  readonly planId: string;
  readonly planKey: string;
  readonly status: 'trialing' | 'active' | 'past_due' | 'canceled' | 'paused';
  readonly period: BillingPeriod;
}

/**
 * The only thing entitlements ask of billing.
 *
 * Returns undefined when an organization has no live subscription — a trial that lapsed, a
 * self-serve signup that never subscribed. That is not an error: resolution then falls
 * through to the catalogue defaults, which is what "free tier" means without a free plan
 * having to exist as a row.
 */
export interface SubscriptionReader {
  activeFor(organizationId: string): Promise<ActiveSubscription | undefined>;
}

export interface PlanFeatureReader {
  /** The plan's grant for one capability, or undefined when the plan does not mention it. */
  featureFor(planId: string, capabilityKey: string): Promise<FeatureGrant | undefined>;
  /** Every capability key any plan row names. Used by the catalogue drift check. */
  allCapabilityKeys(): Promise<readonly string[]>;
}

export interface OverrideRow extends FeatureGrant {
  readonly id: string;
  readonly organizationId: string;
  readonly workspaceId: string | null;
  readonly capabilityKey: string;
  readonly reason: string;
  readonly expiresAt: Date | null;
}

export interface OverrideRepository {
  find(
    organizationId: string,
    workspaceId: string | null,
    capabilityKey: string,
  ): Promise<OverrideRow | undefined>;
  upsert(input: Omit<OverrideRow, 'id'> & { readonly grantedBy: string | null }): Promise<string>;
  remove(
    organizationId: string,
    workspaceId: string | null,
    capabilityKey: string,
  ): Promise<boolean>;
  listForOrganization(organizationId: string): Promise<readonly OverrideRow[]>;
}

export interface UsageRepository {
  /** The counter for a period, or 0 when none has been opened yet. */
  currentUsage(input: UsageKey): Promise<number>;

  /**
   * Consumes `quantity` atomically, refusing if it would exceed `limit`.
   *
   * ONE statement, not a read followed by a write. A check-then-increment loses under
   * concurrency however carefully the check is written, so the check IS the increment and
   * the database decides. Returns the new total, or undefined when the limit would have been
   * exceeded.
   */
  consume(
    input: UsageKey & {
      readonly quantity: number;
      readonly limit: number | null;
      readonly period: BillingPeriod;
      readonly actorUserId: string | null;
      readonly actorApiKeyId: string | null;
      readonly at: Date;
    },
  ): Promise<number | undefined>;
}

export interface UsageKey {
  readonly organizationId: string;
  readonly workspaceId: string | null;
  readonly capabilityKey: string;
  readonly periodStart: Date;
}

export interface Clock {
  now(): Date;
}
