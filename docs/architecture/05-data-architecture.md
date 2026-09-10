# 05 — Data Architecture

This document answers, in order, the twelve questions the directive requires to be settled
before implementation.

## 1. Conventions (applied to every table without exception)

| Convention | Rule | Reason |
| --- | --- | --- |
| Primary keys | `uuid` v7, generated in the application | Time-ordered → index locality of a sequence, with the non-enumerability of a UUID. Sequential integers leak tenant volume and invite IDOR. |
| Tenant column | `organization_id uuid NOT NULL` on every tenant-scoped table | The RLS predicate. Also the first column of nearly every index. |
| Workspace column | `workspace_id uuid NOT NULL` where the resource is workspace-scoped | Second isolation level |
| Timestamps | `created_at`, `updated_at` — `timestamptz NOT NULL DEFAULT now()` | UTC always; `timestamp without time zone` is rejected by migration lint |
| Soft delete | `deleted_at timestamptz NULL` on user-recoverable entities only | Financial and audit records are never soft-deleted |
| Money | `amount_minor bigint NOT NULL` + `currency char(3) NOT NULL` | Never floating point. A `Money` branded type enforces this in code |
| Enums | Postgres `text` + `CHECK` constraint, or a lookup table | Native `enum` types cannot have values removed and lock on `ALTER` |
| Naming | `snake_case`, plural tables, `<table>_<cols>_idx`, `fk_<child>_<parent>` | Predictable, greppable |
| Extensibility | `metadata jsonb NOT NULL DEFAULT '{}'` on customer-facing entities | For genuinely open-ended annotation only — never for data we query or constrain |
| Concurrency | `version integer NOT NULL DEFAULT 0` on entities with contended edits | Optimistic locking on calendar slots, deals, listings |

**On JSON:** `jsonb` is permitted in exactly six places, each justified below —
marketplace listing attribute values (schema-driven, per-category), automation definition
graphs (user-authored documents), raw provider payloads (`inbound_webhook_events.payload`,
`provider_metric_snapshots.raw`), attribution and recommendation **evidence** (a
heterogeneous, append-only record of what supported a conclusion), AI structured outputs and
feature snapshots (shape varies by capability and model version), and `metadata`. Everywhere
else, relational modelling wins. A `jsonb` column that gets filtered or aggregated in a
product query is a modelling bug, and migration review treats it as one.

`evidence` and `features` are the honest cases: their schema is *defined by the model or
attribution version that produced them*, they are written once and never updated, and they
are read for display and audit rather than filtered in aggregate queries.

## 2. Entity inventory

Organised by owning module. `→` denotes a foreign key; `⇢` denotes a *reference by id
without a foreign key* (a cross-module reference, resolved at the application layer).

### Platform / tenancy

| Table | Key columns | Notes |
| --- | --- | --- |
| `users` | `email citext UNIQUE`, `password_hash`, `status`, `locale`, `timezone`, `mfa_enabled` | Not tenant-scoped — a user may belong to many orgs |
| `user_identities` | `user_id →users`, `provider`, `provider_user_id` | `UNIQUE(provider, provider_user_id)` |
| `sessions` | `user_id →users`, `token_hash UNIQUE`, `expires_at`, `ip`, `user_agent`, `revoked_at` | Opaque tokens; only the SHA-256 hash is stored |
| `mfa_credentials` | `user_id →users`, `type`, `secret_encrypted`, `confirmed_at` | TOTP / WebAuthn |
| `organizations` | `slug UNIQUE`, `name`, `status`, `kind` (`agency`\|`business`), `billing_email`, `default_timezone`, `data_region` | The tenant root |
| `teams` | `organization_id →organizations`, `slug`, `name`, `is_default` | `UNIQUE(organization_id, slug)`. The access/staffing layer |
| `workspaces` | `organization_id →organizations`, `team_id →teams NULL`, `slug`, `name`, `timezone`, `kind` (`client`\|`internal`\|`brand`), `client_reference` | `UNIQUE(organization_id, slug)`. **The resource boundary** |
| `team_workspace_access` | `team_id →teams`, `workspace_id →workspaces`, `access_level` | Additional teams granted access to a workspace (specialist pods) |
| `organization_members` | `organization_id`, `user_id →users`, `status` | `UNIQUE(organization_id, user_id)` |
| `team_members` | `team_id →teams`, `organization_member_id →organization_members` | `UNIQUE(team_id, organization_member_id)` |
| `roles` | `organization_id NULL`, `slug`, `scope` (`organization`\|`team`\|`workspace`), `is_system` | `NULL` org = system role; per-org rows = custom roles |
| `role_permissions` | `role_id →roles`, `permission` | Permission literals from the catalogue |
| `role_assignments` | `organization_member_id`, `role_id`, `team_id NULL`, `workspace_id NULL` | Scope is org-wide, team-wide, or a single workspace. `CHECK` enforces at most one of `team_id`/`workspace_id` |
| `resource_grants` | `subject_type/id`, `resource_type`, `resource_id`, `permission` | Fine-grained per-resource sharing |
| `invitations` | `organization_id`, `email`, `role_id`, `token_hash`, `expires_at`, `accepted_at` | |
| `api_keys` | `organization_id`, `name`, `prefix`, `key_hash`, `scopes text[]`, `last_used_at`, `expires_at` | Secret shown once; only the hash persists |
| `audit_events` | `organization_id`, `actor_type/id`, `action`, `resource_type/id`, `before/after jsonb`, `ip`, `request_id`, `prev_hash`, `hash` | Append-only, hash-chained, monthly partitions |
| `outbox_events` | `id`, `organization_id`, `event_name`, `event_version`, `payload jsonb`, `occurred_at`, `published_at NULL`, `attempts` | The transactional event spine |
| `inbound_webhook_events` | `provider`, `provider_event_id`, `signature_valid`, `payload jsonb`, `received_at`, `processed_at` | `UNIQUE(provider, provider_event_id)` — replay protection |
| `notifications` | `organization_id`, `recipient_user_id`, `type`, `payload jsonb`, `read_at` | |
| `files` | `organization_id`, `workspace_id`, `storage_key`, `mime_type`, `size_bytes`, `checksum`, `scan_status`, `uploaded_by` | Metadata only; bytes in object storage |
| `job_executions` | `queue`, `job_name`, `organization_id`, `status`, `attempts`, `error`, `duration_ms` | Observability for background work; monthly partitions |
| `feature_flags` / `flag_overrides` | `key`, `rules jsonb` / `organization_id` | Rollout control, distinct from entitlements |

### Billing & entitlements

`plans`, `plan_features` (`feature_key`, `limit_value`, `is_unlimited`), `subscriptions`
(`organization_id`, `plan_id`, `status`, `current_period_start/end`, `stripe_subscription_id`),
`subscription_items`, `invoices`, `payment_methods`, `usage_records` (`organization_id`,
`feature_key`, `quantity`, `recorded_at`; monthly partitions),
`entitlement_overrides` (per-org grants outside the plan — how enterprise deals get honoured
without inventing a plan per customer).

### Integrations

| Table | Notes |
| --- | --- |
| `integration_providers` | Registry rows: slug, category, capabilities, auth type |
| `connections` | `organization_id`, `workspace_id`, `provider_slug`, `external_account_id`, `status`, `scopes text[]`, `connected_by`, `last_synced_at`, `health` |
| `integration_credentials` | `connection_id`, `access_token_encrypted`, `refresh_token_encrypted`, `expires_at`, `key_version` — **separate table, envelope-encrypted, never selected by default** |
| `sync_cursors` | `connection_id`, `resource`, `cursor`, `last_run_at` — incremental ingestion state |
| `provider_rate_limit_state` | `connection_id`, `bucket`, `remaining`, `reset_at` |

### Social Growth OS

`social_accounts` (⇢`connection_id`, `platform`, `handle`, `account_type`, `follower_count`),
`content_items` (the platform-agnostic idea: `title`, `body`, `status`, `brief`, ⇢`campaign_id`),
`content_variants` (per-platform rendering: `platform`, `body`, `media_ids`, `first_comment`),
`content_media` (→`files`), `content_approvals` (`step`, `approver_id`, `decision`, `comment`),
`content_pillars`, `calendar_slots` (`workspace_id`, `starts_at`, `platform`, `content_item_id`),
`scheduled_posts` (`content_variant_id`, `social_account_id`, `scheduled_at_utc`,
`scheduled_local_at`, `scheduled_timezone`, `status`, `idempotency_key UNIQUE`),
`publishing_attempts` (`scheduled_post_id`, `attempt`, `status`, `provider_error_code`,
`response jsonb`), `published_posts` (`provider_post_id`, `permalink`, `published_at`),
`post_metric_snapshots` (`published_post_id`, `captured_at`, `impressions`, `reach`,
`engagements`, `clicks`, `video_views`; monthly partitions),
`account_metric_snapshots`, `conversations` (`social_account_id`, `type`, `participant`,
`status`, `assigned_to`, `sla_due_at`), `conversation_messages`, `mentions`,
`saved_replies`, `listening_monitors`, `listening_signals`, `competitor_profiles`,
`competitor_metric_snapshots`.

### Marketing OS

`positionings`, `icps`, `audience_segments`, `offers`, `research_notes`,
`campaigns` (`workspace_id`, `name`, `objective`, `status`, `starts_at`, `ends_at`,
`budget_minor`, `currency`, `goal_metric`, `goal_value`) — **the cross-product spine**,
`campaign_channels`, `ad_accounts` (⇢`connection_id`), `ad_campaigns`, `ad_sets`, `ads`,
`ad_creatives` (→`files`), `budgets`, `ad_spend_facts` (`date`, `ad_id`, `spend_minor`,
`impressions`, `clicks`, `conversions`; **daily-grain, monthly partitions** — the source of
truth for CPL/CAC), `landing_pages`, `landing_page_versions`, `forms`, `form_fields`,
`form_submissions`, `tracked_links` (`short_code UNIQUE`, `destination_url`,
⇢`campaign_id`, ⇢`content_item_id`, ⇢`ad_id`), `link_clicks` (partitioned),
`email_sequences`, `email_steps`, `email_sends`, `email_events`.

### CRM

`contacts` (`workspace_id`, `email citext`, `phone`, `lifecycle_stage`, `owner_id`,
`score`, ⇢`primary_company_id`), `companies`, `contact_company_roles`,
`pipelines`, `pipeline_stages` (`position`, `probability`),
`deals` (`contact_id`, `pipeline_stage_id`, `amount_minor`, `currency`,
`expected_close_date`, `status`, ⇢`campaign_id`, `closed_at`),
`deal_stage_history` (every transition, for velocity analysis),
`activities`, `notes`, `custom_field_definitions`, `custom_field_values`,
`assignment_rules`.

### Marketplace

| Table | Notes |
| --- | --- |
| `listing_types` | `slug`, `name`, `attribute_schema jsonb`, `pricing_models text[]` — **new categories are rows, not migrations** |
| `categories` | Nested set / `ltree` path for fast subtree queries |
| `listings` | `seller_organization_id`, `listing_type_id`, `slug`, `status`, `title`, `summary`, `category_id`, `rating_avg`, `rating_count`, `published_at` |
| `attribute_definitions` | `listing_type_id`, `key`, `data_type`, `is_filterable`, `is_required`, `options jsonb` |
| `listing_attribute_values` | `listing_id`, `attribute_definition_id`, + typed columns `value_text/value_numeric/value_boolean/value_timestamp/value_json` | Filterable facets per category **without a schema change per category** |
| `listing_pricing_plans` | `pricing_model` (one_time / subscription / usage / hourly / quote), `amount_minor`, `currency`, `interval` |
| `listing_media`, `listing_versions` | Change history for moderation |
| `carts`, `cart_items` | |
| `orders` | `buyer_organization_id`, `seller_organization_id`, `status`, `subtotal_minor`, `fee_minor`, `tax_minor`, `total_minor`, `currency`, `placed_at` |
| `order_items` | `listing_id`, `pricing_plan_id`, `quantity`, `unit_amount_minor` |
| `fulfilments` | Digital delivery / engagement milestones for services |
| `payments`, `refunds` | `stripe_payment_intent_id`, `status` |
| `commissions` | `order_id`, `rate_bps`, `amount_minor` |
| `payouts`, `payout_items` | `seller_organization_id`, `stripe_transfer_id`, `status` |
| `ledger_entries` | `account`, `direction`, `amount_minor`, `currency`, `reference_type/id`, `posted_at` — **double-entry**; every order/commission/refund/payout posts balanced entries |
| `reviews` | `order_id UNIQUE`, `rating`, `body`, `status` — reviews require a verified order |
| `moderation_cases`, `disputes`, `seller_profiles`, `seller_verifications` | |

**Double-entry is not over-engineering here.** A marketplace that tracks money with
mutable balance columns cannot answer "why is this seller's balance wrong?" six months
later. An append-only ledger can, and reconciliation against Stripe becomes a query
instead of an investigation.

### Analytics

| Table | Notes |
| --- | --- |
| `identities` | `organization_id`, `workspace_id`, `primary_email citext`, `first_seen_at` — the resolved person |
| `identity_keys` | `identity_id`, `key_type` (email/phone/cookie/device/platform_user), `key_value_hash`, `key_value_encrypted` | `UNIQUE(organization_id, key_type, key_value_hash)` |
| `identity_merges` | Audit of graph merges, so a bad merge is reversible |
| `touchpoints` | `organization_id`, `workspace_id`, `identity_id NULL`, `occurred_at`, `channel`, `interaction`, `source_type`, `source_id`, ⇢`campaign_id`, `cost_minor NULL`, `session_id` | **Partitioned monthly by `occurred_at`** |
| `conversions` | `identity_id`, `conversion_type` (lead/qualified/deal_won/order), `value_minor`, `currency`, `occurred_at`, `source_type/id` | Partitioned monthly |
| `attribution_results` | `conversion_id`, `model`, `model_version`, `lookback_window`, `touchpoint_id`, `credit_fraction numeric(9,8)`, `credited_value_minor`, `evidence jsonb`, `computed_at`, `computation_id` | One row per (conversion, model, touchpoint). **Model, version, lookback window and source evidence are stored with the result**, so any number is reproducible and explicable months later |
| `attribution_computations` | `computation_id`, `organization_id`, `trigger`, `input_range`, `code_version`, `started_at`, `finished_at`, `row_count` | The run that produced a set of results — the audit record behind a restated number |
| `cost_facts` | `date`, `channel`, `source_type/id`, ⇢`campaign_id`, `spend_minor` | Unifies ad spend and other costs for CPL/CAC |
| `metric_rollups` | `organization_id`, `workspace_id`, `date`, `grain`, `dimension_type/id`, `metric_key`, `value_numeric` | Incremental; always rebuildable from facts |
| `reports`, `dashboards`, `dashboard_widgets`, `scheduled_exports` | Saved definitions |

### Intelligence

| Table | Notes |
| --- | --- |
| `ai_capabilities` | Registry: capability key, category, default model policy, required entitlement, cost class |
| `prompt_templates` / `prompt_versions` | Versioned, immutable prompt bodies with a declared input schema. A prompt change is a deployable, reviewable, evaluable artefact — never an inline string |
| `ai_invocations` | `organization_id`, `workspace_id`, `capability`, `prompt_version_id`, `provider`, `model`, `input_hash`, `input_tokens`, `output_tokens`, `cost_minor`, `latency_ms`, `status`, `grounding_ref`, `actor_id` — **the provenance and cost ledger**; monthly partitions |
| `ai_outputs` | `invocation_id`, `content`, `structured jsonb`, `citations jsonb`, `safety_flags`, `human_verdict` | Kept separate from the invocation so outputs age on a different retention clock |
| `ai_feedback` | `output_id`, `actor_id`, `rating`, `edited_result`, `reason` — the evaluation signal |
| `knowledge_nodes` | `organization_id`, `workspace_id`, `node_type` (business, audience, offer, content, campaign, ad, channel, lead, customer, listing), `source_type/id`, `label`, `attributes jsonb` |
| `knowledge_edges` | `from_node_id`, `to_node_id`, `relation`, `weight`, `evidence jsonb`, `observed_at` — the cross-product relationship graph |
| `content_embeddings` | `organization_id`, `workspace_id`, `source_type/id`, `model`, `embedding vector(N)` — `pgvector`, HNSW index, tenant-scoped |
| `feature_snapshots` | `entity_type/id`, `feature_set`, `computed_at`, `features jsonb`, `code_version` — point-in-time model inputs. **Storing features as they were at scoring time is what makes a score reproducible and prevents training/serving skew** |
| `recommendations` | `organization_id`, `workspace_id`, `kind`, `subject_type/id`, `rationale`, `evidence jsonb`, `expected_impact`, `confidence`, `status` (`open`/`applied`/`dismissed`/`expired`), `applied_by`, `applied_at` |
| `ai_budgets` | `organization_id`, `workspace_id NULL`, `period`, `limit_minor`, `consumed_minor`, `hard_stop` — cost control as data, checked before invocation |

## 3. Ownership and tenant boundaries

Three isolation levels, chosen per table and never mixed:

1. **Global** — `users`, `plans`, `integration_providers`, `listing_types`. No RLS.
2. **Organization-scoped** — `organization_id NOT NULL`; RLS predicate
   `organization_id = current_setting('app.organization_id')::uuid`.
3. **Workspace-scoped** — additionally `workspace_id NOT NULL`; RLS adds membership of the
   workspace via the actor's accessible-workspace set.

**Teams are deliberately absent from this list.** The hierarchy is
organization → team → workspace, but the *isolation predicate* is written against
`organization_id` and `workspace_id` only. Team membership is resolved in the application
layer into the actor's accessible-workspace set, which is passed to the database as
`app.workspace_ids`.

This is a considered trade. Putting `team_id` into the RLS predicate would mean a
three-way join inside every policy on every query, and it would break the moment a
workspace is served by two teams — which `team_workspace_access` exists to support.
Keeping the predicate two-level means teams can grow in expressiveness (nested teams,
cross-team grants, time-boxed client access) without ever touching a policy or a migration.
Team scope is an access-*expansion* mechanism, and expansion belongs in the authorization
layer; the database keeps the hard, narrow boundary. See
[06](06-identity-and-access.md) §4.

**Marketplace is the deliberate exception** and is designed as such: published listings are
readable across tenants. This is expressed as an explicit, reviewed RLS policy —
`status = 'published' AND deleted_at IS NULL` for read, `seller_organization_id = current
org` for write — rather than by disabling RLS. An order is visible to exactly two orgs
(buyer and seller), which is a policy with an `OR`, not an exception to the model. Because
this is the one place cross-tenant reads are legal, it gets the most authorization tests
([11](11-testing-architecture.md) §4).

## 4. Relationships, keys and deletion behaviour

| Relationship class | FK behaviour | Rationale |
| --- | --- | --- |
| Child within one aggregate (`order_items`→`orders`) | `ON DELETE CASCADE` | The child has no meaning alone |
| Reference to a tenant root (`*`→`organizations`) | `ON DELETE RESTRICT` | Deleting an org is a deliberate, orchestrated workflow, never a cascade |
| Reference to a person (`deals.owner_id`→`users`) | `ON DELETE SET NULL` | Records outlive employees |
| Financial records (`payments`, `ledger_entries`, `invoices`) | `ON DELETE RESTRICT`, **no soft delete** | Legally retained; corrections are reversing entries |
| Cross-module reference (`content_items.campaign_id`) | **No FK** — id + application-layer resolution | An FK would couple module schemas and block later extraction. Integrity is asserted by the owning service and a nightly consistency check |
| Audit / outbox | No FK to subjects | They must survive the deletion of what they describe |

**Deleting an organization** is a multi-step, auditable saga: mark `status = 'closing'` →
revoke sessions and API keys → disconnect integrations and revoke provider tokens →
cancel subscription → export data on request → 30-day recovery window → hard-delete
tenant-scoped rows in dependency order → retain `audit_events`, `invoices` and
`ledger_entries` per legal retention with the tenant pseudonymised.

## 5. Lifecycle states

State machines are explicit, stored as `text` + `CHECK`, and transitions are enforced in
domain code (never by the UI). The illegal-transition test is generated from the machine
definition, so adding a state adds tests automatically.

| Entity | States |
| --- | --- |
| `content_items` | `draft → in_review → changes_requested → approved → scheduled → publishing → published` ∣ `failed`, `archived` |
| `scheduled_posts` | `pending → claimed → publishing → published` ∣ `failed → retrying`, `canceled` |
| `connections` | `pending → active → degraded → expired → revoked` ∣ `disconnected` |
| `orders` | `pending_payment → paid → fulfilling → completed` ∣ `canceled`, `refunded`, `disputed` |
| `deals` | `open → won` ∣ `lost` (stage transitions recorded in `deal_stage_history`) |
| `subscriptions` | `trialing → active → past_due → canceled` ∣ `paused` |
| `automation_runs` | `pending → running → waiting → running → succeeded` ∣ `failed`, `canceled`, `timed_out` |
| `listings` | `draft → in_review → published` ∣ `rejected`, `suspended`, `archived` |

## 6. Indexing strategy

Rules rather than a list, because a list goes stale:

1. **Every tenant-scoped index leads with `organization_id`** (then `workspace_id` where
   applicable). This makes every query a range scan inside one tenant's slice.
2. **Every foreign key has a covering index** — Postgres does not create one, and its
   absence turns parent deletes and joins into sequential scans.
3. **Partial indexes for hot filtered paths**, e.g.
   `WHERE status='pending' AND scheduled_at_utc <= now()` on `scheduled_posts` — the
   publisher's poll query is the highest-frequency query in the system.
4. **Time-series tables**: `(organization_id, occurred_at DESC)` inside each partition.
5. **Search**: `tsvector` generated columns with GIN for listings and content;
   `pg_trgm` for fuzzy contact/company lookup.
6. **Uniqueness that must survive soft delete** uses partial unique indexes:
   `UNIQUE (organization_id, slug) WHERE deleted_at IS NULL`.
7. **Indexes are created `CONCURRENTLY`** in their own migration, outside a transaction.
8. Every index must be justified in its migration's PR description by the query it serves;
   `pg_stat_user_indexes` is reviewed quarterly and unused indexes are dropped.

## 7. Partitioning and growth

Partitioned by `RANGE (occurred_at)`, monthly, from day one — retrofitting partitioning
onto a large live table is an outage:

`touchpoints`, `conversions`, `link_clicks`, `email_events`, `post_metric_snapshots`,
`account_metric_snapshots`, `ad_spend_facts`, `audit_events`, `job_executions`,
`usage_records`, `inbound_webhook_events`, `ai_invocations`.

A scheduled job pre-creates partitions 3 months ahead and detaches/archives those past
retention. Detached partitions go to object storage as Parquet before being dropped.

## 8. Time, timezones and localization

- All storage is `timestamptz` in UTC. No exceptions.
- **User-intent times additionally store the intent**: `scheduled_posts` holds
  `scheduled_local_at`, `scheduled_timezone` (IANA) **and** the derived
  `scheduled_at_utc`. "Every Tuesday at 09:00 in Europe/Berlin" must stay 09:00 across a
  DST boundary — a UTC-only column silently drifts by an hour twice a year, and for a
  publishing product that is a visible product defect.
- Recurring schedules store the rule (RFC 5545 RRULE) plus the timezone, and materialise
  occurrences forward; a timezone database update triggers re-materialisation.
- Every org and user has a `timezone` and `locale`. Reports are computed in the
  **workspace's** timezone — a "daily" number must mean the customer's day.
- No user-facing string is hard-coded; all go through ICU catalogues from the first
  component. Currency and number formatting is locale-aware via `Intl`.
- `citext` for emails; Unicode-safe collation; no assumptions about name structure.

## 9. Audit requirements

Every mutation through an application service writes an `audit_events` row **in the same
transaction as the change**. Guaranteed fields: actor (user, API key or system), action,
resource, before/after diff (PII-redacted by field policy), request id, IP, user agent.

Rows are hash-chained per organization (`hash = H(prev_hash ‖ canonical(row))`) so silent
tampering is detectable. The table is append-only: the application role holds `INSERT` and
`SELECT` and no `UPDATE`/`DELETE` grant at all — enforced by Postgres privileges, not
convention.

## 10. Data retention and classification

| Class | Examples | Retention | Handling |
| --- | --- | --- | --- |
| Credentials | Provider tokens, MFA secrets | Life of connection | Envelope-encrypted, separate table, never logged |
| PII | Contact emails/phones, identity keys | Life of tenant + 30d | Encrypted at rest; erasure workflow; redacted in logs |
| Financial | Invoices, ledger, payouts | 7 years (jurisdictional) | Immutable; never deleted with the tenant |
| Audit | `audit_events` | 2 years hot, 7 years archived | Append-only, hash-chained |
| Operational | Job executions, webhook payloads | 90 days | Partition drop |
| Raw provider payloads | `inbound_webhook_events.payload` | 30 days | Partition drop after processing |
| Analytics facts | Touchpoints, conversions | 25 months hot, archived beyond | Partition detach → Parquet |
| Derived | Rollups, attribution results | Recomputable | May be dropped and rebuilt |
| AI provenance | `ai_invocations` (model, cost, tokens, hashes) | 25 months | Partitioned; the cost and governance record |
| AI content | `ai_outputs` (generated text, structured results) | 12 months, tenant-configurable | Separate table so it ages independently of provenance |
| Embeddings | `content_embeddings` | Life of source | Recomputable; invalidated and rebuilt on model change |

**GDPR erasure** pseudonymises rather than deletes: identity keys are cleared, PII columns
redacted, and a tombstone retained so aggregate analytics stay correct and the erasure
itself is auditable. Export produces a machine-readable archive of everything tied to the
subject.

## 11. Migration strategy

- **Expand/contract, always.** Add nullable → backfill in batches → dual-write → switch
  reads → stop writing old → drop in a later release. Every migration must be safe against
  the *previous* application version, because deploys are rolling.
- **Forward-only.** No `down` migrations in production; a mistake is corrected by a new
  migration. `down` exists only for local development.
- **Immutable once merged.** An applied migration is never edited.
- Long-running operations (index builds, backfills) run `CONCURRENTLY` or as chunked jobs,
  never as blocking DDL inside a deploy.
- `lock_timeout` and `statement_timeout` are set on the migration connection so a blocked
  DDL fails fast rather than queueing behind it and stalling the application.
- **CI gates:** every migration runs forward against a production-shaped schema; a lint pass
  rejects `timestamp` without zone, float money, `enum` types, unindexed FKs, missing RLS on
  tenant tables, and blocking `ALTER`s on large tables.
- RLS policies live in `db/policies/` and are reviewed as security artefacts by a second
  reviewer, separately from feature review.

## 12. Scaling path (in the order it will actually be needed)

1. Connection pooling (PgBouncer, transaction mode) — required before any horizontal app
   scaling, because `SET LOCAL` inside a transaction is pooler-safe while session-level
   `SET` is not. This constraint is why tenant context uses `SET LOCAL`.
2. Read replicas for reports and exports, routed by an explicit `readOnly` flag on the unit
   of work — never inferred.
3. Partition pruning + rollups absorb analytics growth (already designed in).
4. Archive cold partitions to object storage; query them through the `AnalyticsQueryPort`.
5. If fact-table volume outgrows Postgres, move `touchpoints`/`conversions` to ClickHouse
   behind that same port. **Not before** — introducing a second datastore early costs more
   than it saves. [ADR-0008](../adr/0008-analytics-storage.md).
6. Extract a module to its own service only when its load profile genuinely diverges; the
   event spine is the seam.
