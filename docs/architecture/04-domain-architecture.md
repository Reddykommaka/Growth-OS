# 04 — Domain & Module Architecture

## 1. Module map

Nine business modules on nineteen platform packages. Each module owns its tables, its
events and its permissions, and nothing else may write to them.

```
  ┌───────────────────────── PLATFORM (shared, no business rules) ──────────────────────────┐
  │ config · types · errors · logger · telemetry · db · events · jobs · cache · ratelimit    │
  │ authn · authz · entitlements · audit · notifications · files · search · i18n · automation│
  └──────────────────────────────────────────────────────────────────────────────────────────┘
                                            ▲ used by all
  ┌─────────────────────────────── TENANCY & COMMERCE CORE ────────────────────────────────┐
  │   identity  ──▶  organization (org → teams → workspaces)  ──▶  billing                   │
  └──────────────────────────────────────────────────────────────────────────────────────────┘
                                            ▲
  ┌───────────── SOCIAL GROWTH OS ─────────┬────── MARKETING OS ──────┬───── MARKETPLACE ────┐
  │ social                                  │ marketing      crm       │ marketplace          │
  └─────────────────────────────────────────┴──────────────────────────┴──────────────────────┘
                                            │ all emit domain events
                                            ▼
  ┌───────────────────────────────────── analytics ─────────────────────────────────────────┐
  │  identity graph · touchpoints · conversions · attribution · metric registry · reports    │
  └────────────────────────────────────────┬─────────────────────────────────────────────────┘
                                            │ facts + attributed outcomes
                                            ▼
  ┌──────────────────────────────────── intelligence ───────────────────────────────────────┐
  │  knowledge graph · feature store · retrieval · recommendation engine · AI capabilities   │
  │  (reads via other modules' contracts and analytics; writes only proposals)               │
  └──────────────────────────────────────────────────────────────────────────────────────────┘
```

`analytics` is deliberately downstream of everything and upstream of nothing. It subscribes;
it is never called synchronously by a write path. That is what keeps a slow report from
being able to slow down a publish.

`intelligence` sits below even analytics. It reads; it emits recommendations and proposals;
it never writes another module's data directly. A model provider being slow, expensive or
unavailable must never be able to block a publish, a checkout or a login — so nothing on a
critical path may call it synchronously.

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
Owns the tenant, and the three-level hierarchy the agency persona requires:

```
Organization                     ← tenant + billing boundary (the agency, or the business)
  └── Team                       ← staffing and access grouping (a pod, a department, a practice)
        └── Workspace            ← the resource boundary (Client A, Client B, Internal)
```

Owns organizations, teams, workspaces, memberships, team memberships, role assignments at
all three scopes, invitations, settings at each level, API keys, and custom roles.

**Why three levels, and why Team is the middle one.** The primary customer is a marketing
or social agency managing many clients. Such an agency has staff grouped into pods that
each serve a set of clients; a pod lead needs access to *their* clients and to none of the
others, and that access must survive a client being added to the pod without anyone
re-granting it person by person.

- **Organization** is the tenant and the billing boundary. One contract, one invoice.
- **Team** is an *access and organisation* layer. Granting a role at team scope grants it
  across every workspace that team owns — including workspaces added later.
- **Workspace** remains the **resource boundary**. Every business record belongs to a
  workspace, and RLS predicates are written against `workspace_id`, never `team_id`.

That last point is the load-bearing design choice: teams add an expressive access layer
**without** adding a level to the isolation predicate ([ADR-0003](../adr/0003-tenancy-model.md)).
A workspace is owned by at most one team (`workspaces.team_id`, nullable — a workspace may
sit directly under the organization), and additional teams can be granted access through
`team_workspace_access`, which covers the real case of a specialist team (paid media,
creative, analytics) working across several pods' clients.

**Direct businesses are natively supported, not a degraded case.** A single business is one
organization with one default team and one or more workspaces (by brand, region or product
line). Onboarding asks which shape applies and provisions accordingly, and the hierarchy is
never *shown* as three levels of chrome to a customer who only has one team — the team layer
collapses in the UI when it carries no information.

Emits: `organization.created`, `organization.team.created`, `organization.member.added`,
`organization.member.removed`, `organization.team_member.changed`,
`organization.workspace.created`, `organization.workspace.moved`, `organization.role.changed`.

### `billing`
Plans, plan features, subscriptions, subscription items, invoices, payment methods, usage
records, dunning state. Owns the Stripe Billing relationship for **platform subscriptions**
only — marketplace money is `marketplace`'s concern and uses Stripe Connect.
Feeds `platform/entitlements`, which is the read surface every other module gates on.

**Agency billing shape.** The subscription belongs to the organization; the *meters* are
workspace- and seat-aware (connected accounts per workspace, scheduled posts per workspace,
AI credits per organization with per-workspace attribution), so an agency's bill scales with
clients served rather than with an arbitrary flat tier. `subscription_items` carry an
optional `workspace_id`, which is what makes per-client cost reporting — and eventually
client rebilling — a query rather than a spreadsheet. Entitlement checks resolve at the org
level and, where a feature is metered per workspace, at the workspace level.
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

Marketplace is a **first-class architectural domain from the foundation phases**, not a
deferred project. Its full architecture is specified in
[17-marketplace-architecture.md](17-marketplace-architecture.md); its money primitives
(`Money`, the double-entry ledger, the `PaymentPort`) and its extensibility model land in
Phases 0–2 with the rest of the platform.

Emits: `marketplace.listing.published`, `marketplace.order.placed`,
`marketplace.order.completed`, `marketplace.order.refunded`, `marketplace.payout.paid`,
`marketplace.review.submitted`, `marketplace.dispute.opened`.

### `analytics`
Identity resolution graph, touchpoints, conversions, cost facts, attribution results,
the metric registry, saved reports, dashboards, scheduled exports.
Consumes events from every other module; emits only `analytics.report.generated` and
`analytics.attribution.recomputed`.

### `intelligence`
The cross-product intelligence layer. Owns the knowledge graph that relates business,
audience, offers, content, campaigns, ads, leads, customers and revenue; the feature store
that turns facts into model inputs; retrieval and grounding; the recommendation engine; the
AI capability catalogue (generation, transformation, research, trend analysis, listening
summarisation, campaign planning, lead scoring, analytics explanation, workflow
intelligence); prompt and evaluation registries; and the provenance, cost and governance
records for every model invocation.

Its architecture is specified in
[16-intelligence-architecture.md](16-intelligence-architecture.md). Two rules define its
relationship to everything else: it **reads through other modules' contracts and analytics
facts**, never their tables; and it **emits proposals, never direct writes** — a
recommendation is applied by a human or by an explicitly-configured automation, through the
same application services and authorization as any other change.

Emits: `intelligence.recommendation.created`, `intelligence.recommendation.applied`,
`intelligence.recommendation.dismissed`, `intelligence.insight.detected`,
`intelligence.generation.completed`, `intelligence.budget.threshold_reached`.

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
   can instantiate a real campaign in `marketing` — a `marketplace.order.completed` event
   with a `template` listing type triggers a provisioning job. The products compound
   rather than merely coexist.
6. **Intelligence closes the loop.** Because `analytics` knows which content, campaign and
   channel produced revenue, and `intelligence` reads those attributed outcomes, its
   recommendations are grounded in the tenant's own measured results rather than in
   generic advice. That is the difference between "here is a caption" and "posts in this
   pillar, at this time, on this account, produced 3.2× the pipeline of your average —
   here are three more like them." It is also why the intelligence layer had to be
   downstream of attribution rather than bolted onto the composer.
7. **Marketplace supply is intelligence-routed.** When the recommendation engine identifies
   a capability gap (no video creative, no paid-search competence), it can surface a
   Marketplace listing — a template, a playbook or an expert. This is the mechanism that
   makes Marketplace a demand-generating part of the ecosystem rather than a separate
   storefront, and it depends on the intelligence layer being cross-product by design.
