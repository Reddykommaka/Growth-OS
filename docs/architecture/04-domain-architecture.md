# 04 — Domain & Module Architecture

## 1. Module map

Eight business modules on eighteen platform packages. Each module owns its tables, its
events and its permissions, and nothing else may write to them.

```
  ┌───────────────────────── PLATFORM (shared, no business rules) ──────────────────────────┐
  │ config · types · errors · logger · telemetry · db · events · jobs · cache · ratelimit    │
  │ authn · authz · entitlements · audit · notifications · files · search · i18n · automation│
  └──────────────────────────────────────────────────────────────────────────────────────────┘
                                            ▲ used by all
  ┌─────────────────────────────── TENANCY & COMMERCE CORE ────────────────────────────────┐
  │   identity  ──▶  organization  ──▶  billing                                             │
  └──────────────────────────────────────────────────────────────────────────────────────────┘
                                            ▲
  ┌───────────── SOCIAL GROWTH OS ─────────┬────── MARKETING OS ──────┬───── MARKETPLACE ────┐
  │ social                                  │ marketing      crm       │ marketplace          │
  └─────────────────────────────────────────┴──────────────────────────┴──────────────────────┘
                                            │ all emit domain events
                                            ▼
  ┌───────────────────────────────────── analytics ─────────────────────────────────────────┐
  │  identity graph · touchpoints · conversions · attribution · metric registry · reports    │
  └──────────────────────────────────────────────────────────────────────────────────────────┘
```

`analytics` is deliberately downstream of everything and upstream of nothing. It subscribes;
it is never called synchronously by a write path. That is what keeps a slow report from
being able to slow down a publish.

## 2. Module responsibilities

### `identity`
Owns the human. Users, credentials (Argon2id), sessions, MFA enrolments, trusted devices,
email verification, password reset, OAuth identities, per-user preferences (locale,
timezone, notification settings).
Deliberately **does not** own membership or roles — a user exists independently of any
organization, which is what makes multi-org membership and invitations clean.
Emits: `identity.user.registered`, `identity.user.email_verified`, `identity.session.created`,
`identity.mfa.enrolled`, `identity.password.changed`.

### `organization`
Owns the tenant. Organizations (billing/tenant boundary), workspaces (operational
container — a brand, a client, a market), teams, memberships, role assignments,
invitations, org/workspace settings, API keys, custom roles.

**Why organizations *and* workspaces:** agencies are a primary segment for this product. An
agency is one organization (one contract, one bill, one set of staff) managing many client
brands (workspaces) that must not see each other's data. A single-level tenancy model
forces agencies into either one account per client (unbillable, unmanageable) or shared
visibility (unacceptable). The two-level model is not speculative generality — it is the
difference between serving that segment and not.

Emits: `organization.created`, `organization.member.added`, `organization.member.removed`,
`organization.workspace.created`, `organization.role.changed`.

### `billing`
Plans, plan features, subscriptions, subscription items, invoices, payment methods, usage
records, dunning state. Owns the Stripe Billing relationship for **platform subscriptions**
only — marketplace money is `marketplace`'s concern and uses Stripe Connect.
Feeds `platform/entitlements`, which is the read surface every other module gates on.
Emits: `billing.subscription.activated`, `billing.subscription.past_due`,
`billing.subscription.canceled`, `billing.plan.changed`, `billing.usage.threshold_reached`.

### `social` — Social Growth OS
| Sub-domain | Owns |
| --- | --- |
| Accounts | Connected social profiles/pages per workspace, their capabilities and health |
| Content | Content items, variants per platform, media references, hashtags, briefs |
| Planning | Campaign-linked plans, content pillars, editorial calendar, slots |
| Workflow | Draft → in review → approved → scheduled → publishing → published/failed, with approval chains |
| Publishing | Scheduled jobs, publishing attempts, per-platform validation, retries, results |
| Engagement | Unified inbox: comments, DMs, mentions; assignment, saved replies, SLA timers |
| Listening | Keyword/competitor/trend monitors and their captured signals |
| Measurement | Per-post and per-account metric snapshots pulled from providers |

Emits: `social.content.approved`, `social.post.scheduled`, `social.post.published`,
`social.post.failed`, `social.engagement.received`, `social.account.disconnected`,
`social.metrics.ingested`.

### `marketing` — Marketing OS
| Sub-domain | Owns |
| --- | --- |
| Strategy | Positioning, ICPs, audience segments, offers, competitor and market research records |
| Campaigns | The cross-channel campaign entity — the spine every other module references |
| Advertising | Ad accounts, ad campaigns, ad sets, ads, creatives, budgets, spend facts |
| Web capture | Landing pages, forms, form submissions, tracked links |
| Lifecycle | Email/messaging sends, sequences, follow-up cadences |

**`campaigns` is the join key of the whole product.** A social post, an ad set, an email
send, a landing page and a marketplace order can all reference a campaign, which is what
makes cross-channel ROI a query rather than a guess. Campaign is therefore owned by
`marketing` and referenced by id (never by FK across modules) elsewhere.

Emits: `marketing.campaign.launched`, `marketing.campaign.completed`,
`marketing.lead.captured`, `marketing.ad_spend.ingested`, `marketing.email.delivered`,
`marketing.email.clicked`, `marketing.landing_page.published`.

### `crm`
Contacts, companies, deals, pipelines and stages, activities/tasks, notes, custom fields
and their definitions, lead scoring, lifecycle stage, ownership and assignment rules.
Emits: `crm.contact.created`, `crm.contact.qualified`, `crm.deal.created`,
`crm.deal.stage_changed`, `crm.deal.won`, `crm.deal.lost`.

`crm.deal.won` carries `amount`, `currency` and `contactId` — it is the event that closes
the attribution chain in `analytics`.

### `marketplace`
| Sub-domain | Owns |
| --- | --- |
| Catalogue | Listings, listing types, categories, attribute definitions and values, media |
| Commerce | Carts, orders, order items, fulfilment, entitlements granted by digital purchases |
| Money | Payments, refunds, commissions, seller payouts, double-entry ledger |
| Trust | Reviews, ratings, seller verification, moderation queue, disputes |
| Discovery | Search, facets, ranking, curated collections |

Emits: `marketplace.listing.published`, `marketplace.order.placed`,
`marketplace.order.completed`, `marketplace.order.refunded`, `marketplace.payout.paid`,
`marketplace.review.submitted`, `marketplace.dispute.opened`.

### `analytics`
Identity resolution graph, touchpoints, conversions, cost facts, attribution results,
the metric registry, saved reports, dashboards, scheduled exports.
Consumes events from every other module; emits only `analytics.report.generated` and
`analytics.attribution.recomputed`.

## 3. The architectural questionnaire, answered once for the whole platform

The directive requires every feature to answer nine questions. Answering them
per-feature is how they get answered inconsistently. Instead they are answered
**structurally**, so a feature inherits the answers by construction:

| Question | Structural answer |
| --- | --- |
| What domain owns this? | Exactly one module owns each table; ownership is checked in migration review. A feature that seems to need two owners needs an event, not a shared table. |
| What data does it create? | Declared in the module's `schema.ts` and its migration; the entity inventory in [05](05-data-architecture.md) is the register. |
| Who can access it? | A permission literal in the module's `contracts`, mapped to roles in `platform/authz`. Nothing is accessible without one. |
| How is it secured? | `authz.assert()` in the application service **and** an RLS policy on the table. Both, always. |
| How is it tested? | Domain rules → unit; service + RLS → integration against real Postgres; workflow → E2E. The authz matrix test covers every permission automatically. |
| How does it scale? | Tenant-scoped indexes lead with `organization_id`; unbounded growth tables are partitioned; heavy work is a job, not a request. |
| How does it integrate? | It publishes domain events. Other modules subscribe. No direct table access, ever. |
| How is it observed? | Every service call is a span; every job records duration and outcome; every module exposes queue-depth and error-rate metrics under a common naming scheme. |
| What happens when it fails? | Documented per subsystem (see the failure tables in [07](07-integration-architecture.md), [08](08-automation-architecture.md), [12](12-devops-architecture.md)). Every retryable operation is idempotent by construction. |

## 4. Where the three products actually meet

This is the integration story, stated concretely so it can be verified later:

1. **Campaign as the spine.** `social` content, `marketing` ads, `crm` deals and
   `marketplace` orders all carry an optional `campaign_id`.
2. **Tracked links as the bridge from social to lead.** A social post's link is rewritten
   through our own link service ([09](09-analytics-architecture.md) §3), so a click becomes a
   touchpoint carrying `content_item_id` and `campaign_id`. Without this, "which post
   generated revenue?" is unanswerable — it is the single most important mechanism in the
   analytics design.
3. **Identity resolution as the bridge from anonymous to customer.** A cookie id observed on
   a landing page is linked to an email on form submit, and to a CRM contact on
   qualification, and to a marketplace buyer on purchase.
4. **Events as the only coupling.** `analytics` reconstructs the entire chain from the event
   stream. If a module is later extracted into a service, the chain is unaffected.
5. **Marketplace purchases feed Marketing OS.** Buying a campaign template in Marketplace
   can instantiate a real campaign in `marketing` — an `marketplace.order.completed` event
   with a `template` listing type triggers a provisioning job. The products compound
   rather than merely coexist.
