# 09 — Analytics & Attribution Architecture

## 1. The problem this must solve

The directive requires the system to eventually answer:

```
Social activity → Content → Campaign → Lead → Opportunity → Customer → Revenue
```

Most products in this category cannot answer it, and the reason is always the same: they
store **per-channel metrics** (impressions here, form fills there, deals somewhere else)
and then try to join them after the fact on nothing. Follower counts and post reach are
vanity metrics precisely because they are recorded without a link to anything downstream.

The chain is only answerable if three things exist **from the first line of code**:

1. A **person** who can be recognised across anonymous and known states → the identity graph.
2. An **interaction record** carrying its source, its campaign and its content → touchpoints.
3. A **link mechanism** that survives the jump from a social platform to our web property →
   tracked links.

Without (3) in particular, "which post generated revenue?" is structurally unanswerable
regardless of how good the reporting UI is. It is therefore built in Phase 4, not deferred.

## 2. The identity graph

```
identities ──< identity_keys      (email | phone | cookie | device | platform_user | crm_contact)
     │
     └──< identity_merges         (auditable, reversible)
```

- Anonymous first touch creates an identity with a `cookie` key.
- A form submission adds an `email` key → the anonymous history is now attributable to a
  known person, retroactively.
- CRM qualification links `crm_contact`; a marketplace purchase links `buyer`.
- Merges are recorded so a bad merge (shared device, shared inbox) is reversible.
- Keys are stored as `key_value_hash` (for lookup, indexed) plus `key_value_encrypted`
  (for display), so the lookup index never contains plaintext PII.
- Identity is **workspace-scoped**: the same person in two workspaces is two identities.
  Cross-workspace identity resolution would leak one client's audience to another — for an
  agency tenant that is a serious breach, so the boundary is structural.

## 3. Tracked links — the social-to-revenue bridge

Every outbound link we publish is rewritten through our own short-link service:

```
tracked_links ( short_code, destination_url, campaign_id, content_item_id, ad_id,
                social_account_id, workspace_id )

GET /l/:code
  1. resolve (Redis-cached)
  2. set / read first-party identity cookie on our domain
  3. write a `link_click` row  →  becomes a touchpoint
  4. 302 to destination + UTM parameters
```

The destination carries UTMs **and** an opaque click id. When that visitor later submits a
form, the click id ties the submission to the exact post, campaign and account that
produced it. The short domain is a separate origin from the app, cookies are first-party to
it, and the redirect target is validated against an allowlist to prevent open redirect.

Latency budget: p99 < 50ms. Click writes are buffered and flushed in batches; a click is
never allowed to slow a redirect.

## 4. The fact model

Three fact tables, all partitioned monthly, all in the workspace's tenant scope:

| Fact | Grain | Sources |
| --- | --- | --- |
| `touchpoints` | One interaction by one identity at one time | Link clicks, page views, form views, ad clicks/impressions, email opens/clicks, social engagements, marketplace listing views |
| `conversions` | One value-bearing outcome | `marketing.lead.captured`, `crm.contact.qualified`, `crm.deal.won`, `marketplace.order.completed` |
| `cost_facts` | Spend at (date, channel, source) | `ad_spend_facts`, marketplace fees, tool costs entered manually |

Every touchpoint carries `source_type` + `source_id` (content item, ad, email step, listing)
and, critically, `campaign_id`. Campaign is what lets a number roll up across three
products.

All facts are written by **event subscribers**, never by the module that produced the
event. `analytics` is never on a write path's critical section, so a slow analytics write
can never slow a publish or a checkout.

## 5. Attribution

`attribution_results` stores one row per `(conversion, model, touchpoint)` carrying
`credit_fraction`, `credited_value_minor`, and — critically — the **context that produced
it**: `model`, `model_version`, `lookback_window`, `computation_id` and an `evidence`
record.

Storing the result of *every* model, with its full context, rather than computing one on the
fly is deliberate:

- Reports are **reproducible** — the number in last quarter's board deck can be regenerated
  exactly, because the model version and lookback window that produced it are on the row.
- Models are **comparable** side by side, which is how a marketer builds trust in the data.
- Changing a model or a window is a **recomputation job**, not a schema migration, and it
  does not silently rewrite history.
- A restated number is **explicable**: `attribution_computations` records which run produced
  which rows, what triggered it, over what input range, at what code version.

### Source evidence

`evidence` holds the specific facts that supported the credit assignment: the touchpoint
chain considered, which were inside and outside the window and why, the identity-resolution
links traversed (and their confidence), any touchpoints excluded and the reason, and the
weights the model applied.

This is what makes drill-down *trustworthy* rather than merely available. "This €40,000 deal
is credited 40% to that LinkedIn post" is an assertion; the evidence record is the argument
for it — and an agency presenting these numbers to their client will be asked for the
argument. Without it, the first challenged number costs more trust than the feature ever
built. It is append-only and never rewritten; a recomputation writes new rows under a new
`computation_id`.

Models shipped: first-touch, last-touch, last-non-direct, linear, time-decay (configurable
half-life), position-based (40/20/40). Data-driven attribution is a later addition and slots
in as another `model` value — no structural change.

Lookback windows are configurable per workspace (default 90 days click, 1 day view) and
stored **with the result**, so a later window change does not silently alter history.

Credit fractions for a given `(conversion, model)` are asserted to sum to 1.0 — a property
test, not a hope ([11](11-testing-architecture.md) §5).

Recomputation is incremental (only conversions whose lookback contains a changed touchpoint)
and always possible from scratch, because facts are never mutated.

## 6. The metric registry

CPL, CAC, ROAS and ROI are defined **once**, in `packages/modules/analytics/metrics`, as
data:

```ts
export const costPerLead = defineMetric({
  key: 'cost_per_lead',
  label: 'Cost per lead',
  unit: 'currency',
  formula: divide(sum('cost_facts.spend_minor'), count('conversions', { type: 'lead' })),
  dimensions: ['campaign', 'channel', 'content', 'workspace', 'date'],
  requires: ['cost_facts', 'conversions'],
});
```

Every dashboard widget, scheduled export and API response resolves through the registry.
This prevents the failure every mature analytics product eventually suffers: three surfaces
showing three different values for "conversion rate" because each re-implemented it.

A metric definition change is versioned and appears in the UI as an annotation on the
affected date range, so a step change in a chart is explained rather than mysterious.

## 7. Query path and rollups

```
raw facts (partitioned)
   └─▶ incremental rollups  metric_rollups(org, workspace, date, grain, dimension, metric, value)
          └─▶ report queries (dashboards, exports, API)
```

- Rollups are **incremental**, keyed by `(organization, workspace, date, grain, dimension)`
  and upserted by a job as facts arrive. Materialized views were rejected: a full refresh
  cost grows with total history rather than with new data, which fails exactly when the
  customer becomes valuable.
- Rollups are a cache, never a source of truth — a full rebuild from facts is always
  available and is exercised in CI so it does not rot.
- Ad-hoc exploration queries hit facts directly with partition pruning, on a read replica,
  with a statement timeout and a row cap.
- Every headline number is **drillable to its rows**. A metric a user cannot explain is a
  metric they will not act on.

## 8. Questions the model answers, and how

| Question | Query path |
| --- | --- |
| Which content generated leads? | `conversions(type=lead)` → `attribution_results` → `touchpoints.source_type='content_item'` → group by content |
| Which campaigns generated customers? | `conversions(type IN (deal_won, order))` → attribution → group by `campaign_id` |
| Which channels generate revenue? | Same, grouped by `touchpoints.channel`, summing `credited_value_minor` |
| Cost per lead | `cost_facts.spend` ÷ lead conversions, by campaign/channel/date |
| Customer acquisition cost | `cost_facts.spend` ÷ new-customer conversions over the same window |
| Conversion rate | Conversions ÷ distinct identities entering the stage, from `deal_stage_history` and touchpoints |
| Revenue by campaign / channel | `sum(credited_value_minor)` grouped, per attribution model |
| ROI | (attributed revenue − cost) ÷ cost, from the registry, per model |
| Time to conversion | `conversions.occurred_at − first touchpoint`, distribution |
| Which social account drives pipeline? | Touchpoints joined to `social_account_id` → attribution → deal value |

## 9. Feeding the intelligence layer

Attribution is what makes intelligence specific rather than generic. Because
`attribution_results` links revenue back to individual content, campaigns, channels and
accounts — with evidence — the intelligence layer can ground its recommendations in the
tenant's own measured outcomes rather than in prior knowledge about marketing in general.

The contract between the two is deliberately narrow: `intelligence` reads facts, rollups and
attribution results through the `AnalyticsQueryPort`, and reads nothing else from
`analytics`. It does not share tables, and it does not sit on any analytics write path. See
[16-intelligence-architecture.md](16-intelligence-architecture.md).

## 10. Storage evolution

Postgres first — partitioned facts plus incremental rollups handle a very long way, and a
second datastore introduces dual-write consistency, a second operational surface and a
second query language.

All report reads go through an **`AnalyticsQueryPort`** from day one. When fact volume
genuinely outgrows Postgres, `touchpoints`/`conversions` move to ClickHouse behind that same
port, fed from the same event stream, with no change to product code. The trigger is a
measured threshold (p95 report latency, or fact-table size), not a hunch.
[ADR-0008](../adr/0008-analytics-storage.md).

## 11. Failure modes

| Failure | Behaviour |
| --- | --- |
| Analytics consumer is down | Events queue; facts are backfilled on recovery; no upstream impact |
| Duplicate event delivery | Facts are upserted on `(event_id)`; no double counting |
| Identity merged incorrectly | `identity_merges` is reversible; attribution recomputes for affected conversions |
| Rollup job fails | Rollups are stale, not wrong; staleness is displayed in the UI; a rebuild is idempotent |
| Provider restates historical metrics | Snapshots upsert on `(entity, captured_at, granularity)`; rollups recompute for the affected dates |
| Attribution model changed | New rows under a new `model`; prior results retained and comparable |
| Report query too heavy | Statement timeout + row cap; the user is offered a scheduled export instead |
| Late-arriving touchpoint | Incremental recompute revisits conversions whose lookback window covers it |
