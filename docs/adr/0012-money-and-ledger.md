# ADR-0012 — Integer minor units and a double-entry ledger

**Status:** Accepted · **Date:** 2026-09-10 · **Approved:** 2026-09-10

## Context
The marketplace moves money between buyers, the platform and sellers: order totals, platform
commissions, refunds, payouts and disputes, across currencies.

## Decision
All monetary values are `bigint` minor units plus an ISO-4217 `currency` code, wrapped in a
branded `Money` type; floating point is banned by migration lint. Every money movement posts
balanced entries to an append-only `ledger_entries` table (double-entry). Mutable balance
columns are not the source of truth — a balance is a query over the ledger.

## Alternatives considered
- **`numeric` columns with mutable balances.** Rejected: a balance that disagrees with
  history cannot be explained or corrected reliably, and reconciliation against Stripe
  becomes an investigation rather than a query.
- **Floating point.** Rejected outright — representation error in money is a correctness bug.
- **Delegating all accounting to Stripe.** Rejected as the sole record: Stripe does not model
  our commission structure, marketplace-specific adjustments, or non-Stripe value movements,
  and we must be able to reconcile *against* it from our own books.

## Consequences
**Positive:** exact arithmetic; every balance is explainable from its history; corrections
are reversing entries, not edits; Stripe reconciliation is a query; the audit story is strong.

**Negative:** more rows and more discipline per transaction; developers must understand
double-entry basics. Mitigated by a small ledger API that only exposes balanced posting, and
property-based tests asserting every randomised order/refund/payout sequence nets to zero.
