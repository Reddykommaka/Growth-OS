# 17 — Marketplace Architecture

*Implements Decision 7. Marketplace is a first-class architectural domain from the
foundation phases; only its feature implementation follows the commercial order.*

## 1. What "first-class from the beginning" means concretely

Marketplace ships third. That is a sequencing decision, not an architectural one. Five
things land in Phases 0–2, alongside the platform, because retrofitting them later would
mean reworking data that already exists in production:

| Lands early | Why it cannot wait |
| --- | --- |
| The `Money` branded type + migration lint banning float money | A single float money column shipped elsewhere becomes a correctness bug that must be migrated with live data |
| The double-entry `ledger_entries` model and posting API | Platform subscription billing posts to it too. Introducing double-entry after a year of mutable balances means reconstructing history that was never recorded |
| `PaymentPort` and the Stripe adapter | Billing (Phase 2) needs it; Marketplace extends the same port with Connect |
| Marketplace domain contracts, events and permission literals | Other modules subscribe to `marketplace.*` events; the intelligence layer references listings. Contracts define the seams before implementations exist |
| The listing-type extensibility model in the schema design | It shapes how categories, attributes and search are modelled — a decision, not code |

Everything else — catalogue UI, checkout, payouts, disputes, moderation — is Phase 7 work
against interfaces that already exist and are already tested.

## 2. Participants

| Participant | Modelled as |
| --- | --- |
| **Buyer** | An organization. Any Growth OS tenant can buy; no separate buyer account exists |
| **Seller** | An organization with a `seller_profile` and completed Stripe Connect onboarding |
| **Agency-as-seller** | The same organization that manages clients can sell services — one of the strongest reasons Marketplace belongs in this ecosystem rather than beside it |
| **Expert / creator** | A seller organization (possibly of one person) whose listings are service- or digital-product-typed |
| **Platform** | Us: takes commission, holds the ledger, moderates, arbitrates disputes |

An organization is buyer and seller simultaneously without duplication, because both roles
are attributes of an organization rather than separate account types. That is what makes
an agency selling a playbook while buying a video editor a single natural flow.

## 3. Catalogue extensibility

The requirement is new categories without restructuring the database
([ADR-0011](../adr/0011-marketplace-extensibility.md)).

```
 listing_types ─────< attribute_definitions
      │                        │
      └──< listings ───────────┴──< listing_attribute_values   (typed columns)
                │
                ├──< listing_pricing_plans   (one_time | subscription | usage | hourly | quote)
                ├──< listing_media
                └──< listing_versions        (moderation + change history)
```

Launch types — software/tools, templates, content packs, playbooks, campaign templates,
automation workflows, services, experts, agencies, creators, digital products — are **rows**,
each declaring its attribute schema and permitted pricing models. A new category is
configuration plus a moderation policy, never a migration.

Attribute values live in typed columns (`value_text`, `value_numeric`, `value_boolean`,
`value_timestamp`, `value_json`) so price, delivery time, rating and experience-level facets
are real range queries with real indexes, not string comparisons over a JSON blob.

**Where a dedicated table is still right:** service engagements have SLAs, scope, milestones
and revision limits; digital products have files, licences and version history. When a type's
domain is genuinely rich, it gets a detail table alongside its attributes. The extensibility
model exists so that *most* categories need no schema change — not to forbid modelling the
few that deserve it.

## 4. Order lifecycle

```
 cart → order(pending_payment) → payment authorised → order(paid)
   → fulfilment ─┬─ digital delivery (licence + short-lived presigned download)
                 ├─ entitlement provisioning (a template instantiates a real campaign)
                 └─ service engagement (milestones, acceptance)
   → order(completed) → review window opens → payout eligible after hold
```

Every transition emits a domain event and posts ledger entries. Two rules protect the money
path:

- **Amounts are always resolved server-side** from the listing and its pricing plan at order
  time, then snapshotted onto `order_items`. The client never supplies a price. A later
  price change never rewrites an existing order.
- **Commission rate is snapshotted onto the order** (`rate_bps`), not read live at payout
  time. Otherwise changing the platform fee silently restates every unpaid order.

## 5. Money

Stripe Connect handles seller onboarding, KYC, payment collection, transfers and regulatory
compliance. We do not build any of that. What we own is the **book**.

```
 order placed        Dr Buyer receivable        Cr Platform payable to seller
                                                Cr Platform commission revenue
 payment captured    Dr Cash                    Cr Buyer receivable
 refund issued       Dr Platform payable        Cr Cash          (reversing entries)
 payout executed     Dr Platform payable        Cr Cash
```

Every movement posts balanced entries to append-only `ledger_entries`. A seller balance is a
**query over the ledger**, never a mutable column. Corrections are reversing entries; rows
are never updated or deleted ([ADR-0012](../adr/0012-money-and-ledger.md)).

This is what makes reconciliation against Stripe a scheduled query with a diff report rather
than an investigation, and it is why the ledger is built in Phase 2 rather than Phase 7 —
platform billing posts to the same book.

Multi-currency: amounts are stored in their transaction currency with the FX rate and its
timestamp recorded on the entry. Reporting converts at query time using the stored rate, so
a historical report does not change when today's rate moves.

## 6. Trust and safety

| Concern | Control |
| --- | --- |
| Fake reviews | `reviews.order_id UNIQUE` — a review requires a completed order. Velocity and graph anomaly detection; moderation queue |
| Malicious listing content | Server-side sanitisation on write, moderation before first publish, `listing_versions` for re-review on edit |
| Malicious files | Scanned before availability; served from the isolated user-content origin via short-lived presigned URLs; never rendered or executed by us |
| Seller fraud | Stripe Connect KYC; payout hold for new sellers; dispute workflow; ledger makes exposure exactly computable |
| Price/commission tampering | Server-side resolution and snapshotting (§4) |
| Cross-tenant leakage | Published listings are cross-tenant-readable **by explicit RLS policy**, never by disabling RLS. Drafts, orders, payouts and seller financials are not. An order is visible to exactly the buyer and seller organizations. This is the one place cross-tenant reads are legal, so it carries the heaviest authorization test suite ([11](11-testing-architecture.md) §4) |
| Scraping | Rate limits, pagination caps, non-sequential ids, bot detection on discovery |

## 7. Discovery

Postgres-first: `tsvector` generated columns with GIN for text, typed attribute columns for
facets, `pg_trgm` for fuzzy matching, and a materialised facet-count table refreshed
incrementally. All reads go through `SearchPort` from the first implementation, so moving to
OpenSearch later is an adapter swap rather than a rewrite.

Ranking blends text relevance, rating (Bayesian-averaged so a single 5-star review does not
outrank a well-reviewed listing), completion and dispute rates, recency and — later —
personalisation from the intelligence layer.

## 8. How Marketplace connects to the rest of Growth OS

This is why it belongs in the ecosystem rather than as a separate storefront:

1. **Purchases provision real objects.** A campaign template becomes an actual `marketing`
   campaign; an automation workflow becomes an `automation_definition`; a content pack
   becomes `content_items` in the media library. A `marketplace.order.completed` event with
   a provisioning-capable listing type triggers a job that instantiates the artefact through
   the owning module's normal application service — with its normal authorization.
2. **Intelligence routes demand.** When the recommendation engine detects a capability gap,
   it can surface a listing ([16](16-intelligence-architecture.md) §6). Marketplace becomes
   demand-generating rather than a destination users must remember to visit.
3. **Agencies monetise their own assets.** The playbooks and templates an agency builds for
   clients become listings without leaving the platform.
4. **Marketplace activity is attributed.** Listing views and clicks are touchpoints; orders
   are conversions. Seller ROI is answerable by the same attribution spine as everything else
   ([09](09-analytics-architecture.md)).

## 9. Failure modes

| Failure | Behaviour |
| --- | --- |
| Payment authorised, our write failed | Stripe webhook is the source of truth; reconciliation job replays from `inbound_webhook_events` and posts the missing entries idempotently |
| Duplicate Stripe webhook | `UNIQUE(provider, provider_event_id)`; ignored idempotently |
| Payout fails at Stripe | Payout enters `failed`, ledger entries reverse, seller notified, retried on the next cycle |
| Ledger does not balance | Nightly assertion that every reference nets to zero; a non-zero result pages, because it means money is unaccounted for |
| Digital delivery fails after payment | Fulfilment is a retryable job; the buyer's entitlement is granted on payment, not on download success |
| Seller deletes a listing with open orders | Listings are archived, never hard-deleted, while orders reference them; `ON DELETE RESTRICT` |
| Dispute raised | Order enters `disputed`; payout held; ledger records the contingency; resolution posts the final entries |
