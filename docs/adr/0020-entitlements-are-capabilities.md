# ADR-0020 — Entitlements are capabilities resolved from scoped rules, not a plan tier

**Status:** Accepted · **Date:** 2026-09-19

## Context

Growth OS sells three products to one customer base, and the units it sells are not the same
kind of thing as each other. Some are switches ("can this organization use the marketplace"),
some are quotas that reset ("AI generations this month"), and some are ceilings on a
population that persists ("connected social accounts"). Agencies — the primary customer
([02-technology-stack.md](../architecture/02-technology-stack.md) context, and the approved
customer decision) — negotiate. A real agency deal adds one capability, raises one limit, and
keeps everything else on the standard plan.

The obvious model is `plan: 'free' | 'pro' | 'enterprise'` with checks like
`if (org.plan !== 'pro')`. It is wrong in a way that is cheap now and expensive later:

- Every negotiated exception becomes a new plan. A catalogue that grows a plan per deal stops
  being a catalogue, and pricing changes require a migration of customer rows.
- The check tells you the answer and nothing else. "Why can this workspace not publish?" has
  no answer beyond "their plan is not pro", which is not the question support is asking.
- It conflates a commercial fact (what was bought) with an access decision (what this actor
  may do right now), so the billing provider ends up on the authorization path.

Five concepts are routinely collapsed into this one field and must stay apart:
**authentication** (who is this), **authorization** (may this actor perform this action),
**permission** (the catalogue authorization consults), **entitlement** (what the paying
organization may use at all), and **billing** (what is owed and paid). Usage/consumption is a
sixth, and is the record behind the fourth.

## Decision

**An entitlement is a decision about a named capability, resolved from scoped rules, and it
always carries its own explanation.**

1. **A capability registry in code, not in the database.** `packages/platform/entitlements`
   declares every capability key with its module, its limit kind (`boolean` / `counter` /
   `gauge`), its scope (organization or workspace) and a fallback. `plan_features.capability_key`
   is deliberately NOT a foreign key: the catalogue is source, reviewed in a diff, and a
   database FK would make adding a capability a migration while making a typo in a plan row
   look like a schema error rather than a pricing error.

2. **`counter` and `gauge` are different kinds and are never interchangeable.** A counter is
   consumption within a period and resets; a gauge is a current population and does not.
   Resetting a gauge would silently forgive an over-limit state; metering a gauge as
   consumption would let deleting and recreating a social account exhaust the plan.

3. **Resolution is deterministic and explained.** Precedence, highest first:
   workspace override → organization override → plan feature → registry fallback. Every
   decision carries the `source` that supplied it and the `rule` that produced it. An
   override may disable as well as enable, and beats an enabling plan feature. There are no
   hidden fallbacks: the registry default is itself a named source.

4. **No cache sits on the gating path.** [01-overview.md](../architecture/01-overview.md) §5
   already fixes this: "Entitlement checks | Strong at check time | Read in the same
   transaction as the gated write." A cached decision would grant access after an entitlement
   was removed, for the length of the TTL, which is the one failure this subsystem must not
   have. This is a deliberate departure from the permission cache in
   [06-identity-and-access.md](../architecture/06-identity-and-access.md) §3, and the reason
   is the asymmetry: a stale permission is revoked by a session change we control, whereas a
   stale entitlement is revoked by a commercial event we do not.

5. **Consumption is settled by one conditional `UPDATE`.** The limit is a predicate on the
   statement that increments:
   `UPDATE ... SET used = used + $n WHERE ... AND ($limit IS NULL OR used + $n <= $limit)`.
   Zero rows updated is the denial. Check-then-increment is a race, and the race is a
   customer receiving more than they bought.

6. **Billing is consumed through a contract, never directly.** The resolver depends on
   `SubscriptionReader`, which returns a plan key and a period — not a provider object, not a
   price, not an invoice. The provider's subscription and our entitlement row go out of sync
   for entirely ordinary reasons (a webhook retried out of order, dunning in flight), which is
   exactly why a gating decision must not read the provider. `past_due` remains a live status;
   cutting a customer off on one failed charge turns a payment retry into their outage.

7. **Entitlement changes are audited.** Granting, replacing and revoking an override are three
   distinct audited actions gated by `billing.subscription:manage`. No payment instrument,
   amount or provider secret is ever recorded.

## Alternatives considered

**Plan tier enum.** Rejected above. Genuinely simpler, and for a single-product tool with no
negotiation it would be the right answer — which is worth saying plainly, because the
simplicity is real and the reason it fails here is the agency customer, not the pattern.

**Capabilities as rows in a `capabilities` table with an FK from `plan_features`.** Rejected:
it makes the catalogue data, so a capability can exist in one environment and not another, and
a resolver must then decide what an unknown key means at runtime. In code, an unknown key is a
type error in the diff that introduced it.

**Entitlements as permissions in the authorization catalogue.** Rejected, and it was the
closest call. Both answer "may this proceed", and merging them would remove a whole subsystem.
They differ in who the subject is and what changes them: a permission is about an *actor*
inside a tenant and changes when a role assignment changes; an entitlement is about the
*organization* and changes when a contract does. Merged, a plan downgrade would have to
rewrite every member's roles, and "the owner cannot do this" would be indistinguishable from
"you have not paid for this" in both the code and the error the customer sees.

**Caching resolved entitlements with a short TTL, mirroring the permission cache.** Rejected
per decision 4. Considered seriously because the read is on every gated write; measured
instead against the fact that the read is one indexed row in a transaction already open.

**Reading Stripe at check time.** Rejected: it puts a third-party HTTP call inside a database
transaction, which [01-overview.md](../architecture/01-overview.md) §4 forbids outright, and
makes the provider's availability a dependency of the product's availability.

## Consequences

**Positive.** A negotiated exception is one audited row with a mandatory `reason`, not a new
plan. Every denial can answer "what scope supplied this, and which rule produced it".
Marketplace and marketing capabilities are declared alongside social ones from the start, so
no product is retrofitted. The billing provider can be replaced without touching the resolver.

**Negative.** There is more machinery than a tier check: a registry, a resolver, overrides,
counters and consumption records, where one column would have done. Overrides are a standing
operational surface — a wrong one grants capability silently until someone reads the audit
log. Resolution touches several tables on the gating path with no cache to hide it. The
catalogue living in code means a pricing change ships with a deploy, which is slower than
editing a row and is the cost of it being reviewable.

**Mitigation.** `reason` is NOT NULL on every override and each change is audited, so the
standing surface is at least legible. The gating read is a small number of indexed lookups
inside a transaction that is already open. The registry is exhaustively enumerable, so a
structural test can assert that every key a plan references exists.

**Exit condition / trigger to revisit.** If entitlement resolution is measured on the gating
path as a material share of write latency, revisit decision 4 — but only with an invalidation
design that is driven by the entitlement write itself rather than by a TTL, because the
requirement that survives is "a stale cache must never grant access after removal", not the
absence of a cache. If the product ever ceases to negotiate per customer, decisions 1 and 3
are worth more than they cost and should be reconsidered.
