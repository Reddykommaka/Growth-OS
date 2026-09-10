# 07 — Integration Architecture

## 1. Ports and adapters

The core product never imports a vendor SDK. It depends on **capability ports**; each
provider ships an **adapter** that implements the ports it can honestly support.

```
packages/modules/social/application
        │  depends on
        ▼
packages/integrations/core          ← ports, registry, credential vault,
        │                             rate limiter, error taxonomy, webhook verifier
        ▼  implemented by
packages/integrations/{meta,linkedin,x,tiktok,youtube,google-ads,stripe,resend,s3,…}
```

### Port catalogue

| Port | Responsibilities |
| --- | --- |
| `SocialPublishingPort` | validate, publish, schedule-native, delete, fetch permalink |
| `SocialInsightsPort` | account metrics, post metrics, audience demographics |
| `SocialEngagementPort` | list/stream comments & messages, reply, hide, delete |
| `SocialListeningPort` | keyword and mention search |
| `AdPlatformPort` | account/campaign/adset/ad CRUD, creative upload, budgets, **spend & performance facts** |
| `CrmSyncPort` | contact/company/deal read & upsert (for external CRM sync) |
| `EmailPort` | transactional and bulk send, delivery/engagement webhooks, suppression list |
| `MessagingPort` | WhatsApp/SMS send, template management, inbound messages |
| `PaymentPort` | charges, refunds, subscriptions, connected accounts, transfers |
| `StoragePort` | presigned upload/download, delete, copy, signed public URL |
| `SearchPort` | index, delete, query with facets |
| `ModelProviderPort` | completion, structured output, streaming, embedding, tool use — consumed **only** by the intelligence layer ([16](16-intelligence-architecture.md)), never by product code |
| `CalendarPort` | free/busy, event CRUD |
| `EnterpriseIdentityPort` | SAML/OIDC assertion exchange, SCIM user/group sync |

### Capability manifests

A provider declares what it can do, in data. The product reads capabilities and adapts —
it never branches on a provider name.

```ts
export const linkedinProvider: ProviderManifest = {
  slug: 'linkedin',
  category: 'social',
  auth: { type: 'oauth2', pkce: true, scopes: [...], refreshable: true, refreshWindowSec: 3600 },
  capabilities: {
    'social.publish':    { formats: ['text','image','video','document','carousel'],
                           maxTextLength: 3000, maxMedia: 20, nativeScheduling: false },
    'social.insights':   { granularity: 'daily', historyDays: 365, lagHours: 24 },
    'social.engagement': { comments: true, directMessages: false },
  },
  rateLimits: [{ bucket: 'default', limit: 100, windowSec: 86400, scope: 'connection' }],
  webhooks:   { supported: false },
};
```

**Consequence:** the composer UI derives its character counter, media limits and warnings
from the manifest. Adding a platform means adding a package and a manifest row — it does
not mean editing the composer, the scheduler or the validator. This is what the directive
means by "not scattered throughout the application", made concrete.

The **provider registry** resolves `(provider, capability) → adapter`, and a service that
asks for an unsupported capability gets a typed `CapabilityUnsupportedError`, not a runtime
surprise.

### Platform coverage and tiers

Provider work is sequenced by commercial priority, but the *architecture* is designed for
all of them from the start — adding a tier-2 platform must not require touching core code.

| Tier | Platforms | Notes |
| --- | --- | --- |
| **Tier 1** | Instagram, Facebook, YouTube, LinkedIn, TikTok | Full publishing, insights, engagement and (where offered) listening |
| **Tier 2** | X, Pinterest, Threads | Same ports; capability manifests declare narrower support |

**The Meta family is one auth core with three provider identities.** Instagram, Facebook and
Threads share Meta's Graph API, app registration, OAuth flow, token model, webhook transport
and rate-limit accounting — but they are genuinely different products with different content
rules, media constraints, insight metrics and engagement surfaces.

Modelling them as one provider would force `if (platform === 'instagram')` branching inside a
single adapter — exactly the scattering this architecture exists to prevent. Modelling them
as three unrelated adapters would triplicate the OAuth, token-refresh, webhook-verification
and rate-limit code, and the shared rate-limit budget would be accounted three times, which
is not merely wasteful but *wrong*: Meta meters the app, not the surface.

So: `integrations/meta-core` owns auth, token lifecycle, the Graph transport, webhook
verification and the **shared** rate-limit bucket; `integrations/instagram`,
`integrations/facebook` and `integrations/threads` are separate adapters with separate
manifests that depend on it. Three `integration_providers` rows, three sets of capabilities,
one credential and one budget. [ADR-0015](../adr/0015-meta-provider-family.md).

The same pattern applies wherever a vendor spans surfaces — Google (YouTube, Google Ads,
Analytics) is the next instance, and the pattern is already in place when we reach it.

**Capability degradation is required, not optional.** Platforms remove capabilities with
little notice (a listening endpoint deprecated, a metric withdrawn, a scope narrowed at app
review). Because the UI is driven by the manifest rather than by hard-coded assumptions, a
withdrawn capability becomes a disabled control with an explanation and a paused automation
— not a runtime error. A manifest change is the entire remediation for a whole class of
platform-side change.

## 2. Connection lifecycle

```
  initiate ──▶ pending ──▶ active ──▶ degraded ──▶ expired ──▶ revoked
     │                        │  ▲         │           │
     │                        │  └─ heal ──┘           │
     └── user cancels         └──────── disconnect ────┘
```

- **`initiate`** — server generates `state` (bound to org, workspace and user, stored with a
  10-minute TTL) and PKCE verifier. The callback rejects any mismatch. Without this,
  connection CSRF lets an attacker attach *their* social account to *your* workspace.
- **`active`** — tokens encrypted and stored; granted scopes recorded so the UI can prompt
  for re-consent when a feature needs a scope the connection lacks.
- **`degraded`** — repeated provider errors trip a circuit breaker; the workspace sees a
  banner and affected automations pause rather than silently failing.
- **`expired` / `revoked`** — refresh failed, or the user revoked access at the provider.
  Scheduled work is held (not dropped), the workspace is notified with a reconnect link,
  and the queue does not burn retries on a credential that cannot succeed.

**Token refresh** runs in a dedicated worker, ahead of expiry (at 75% of lifetime), under a
per-connection distributed lock so concurrent jobs cannot race and invalidate each other's
refresh token — a classic and very hard-to-debug production failure. Refresh failure
transitions the connection, never the job.

## 3. Credential handling

| Control | Implementation |
| --- | --- |
| Storage | Separate `integration_credentials` table, never joined into general queries |
| Encryption | Envelope: per-record AES-256-GCM data key, wrapped by a KMS master key. `key_version` column enables rotation without downtime |
| Access | A single `CredentialVault` service; direct repository access is lint-blocked |
| Exposure | Never serialised into any DTO. Contract types have no token field, so a token *cannot* reach an API response — the compiler prevents it |
| Logging | Redaction list in the logger; `token`, `secret`, `authorization`, `refresh_token` keys are stripped at the serializer, before any transport |
| Client | Zero credential material ever reaches the browser. OAuth callbacks land on the server; the browser only ever sees a connection id |
| Rotation | Re-encrypt job walks records by `key_version`; old keys retained until the walk completes |

## 4. Outbound calls — the standard pipeline

Every provider call goes through one composed pipeline. Adapters implement transport;
they do not each reinvent resilience:

```
 authorize (fresh token) → rate-limit gate → circuit breaker → timeout →
 request (with idempotency key) → normalize response → normalize error →
 record metrics + span → persist attempt
```

- **Rate limiting** — Redis token bucket per `(provider, connection, bucket)`, seeded from
  the manifest and *corrected from provider response headers*, which are the real limit.
  Jobs wait on the bucket rather than failing.
- **Retries** — only on `ProviderUnavailable`, `RateLimited` and network faults.
  Exponential backoff with full jitter, capped attempts, honouring `Retry-After`.
  `InvalidRequest` and `PermissionDenied` are **never** retried — retrying them wastes the
  budget and, on some platforms, accelerates suspension.
- **Idempotency** — an idempotency key is persisted **before** the call. On retry the
  adapter first checks whether the entity already exists at the provider (by key, or by
  provider-side dedup) and reconciles instead of double-posting. Publishing the same post
  twice is a customer-visible failure, so this is treated as a correctness requirement.
- **Timeouts** — every call has one. No unbounded waits.

### Normalized error taxonomy

Providers report the same conditions in wildly different ways. Adapters translate into a
closed set so the core reacts uniformly:

`RateLimited(retryAfter)` · `AuthExpired` · `PermissionRevoked(scope)` ·
`ProviderUnavailable` · `InvalidRequest(field, message)` · `QuotaExceeded` ·
`ContentRejected(reason)` · `Conflict` · `NotFound` · `CapabilityUnsupported`

The mapping is where each adapter's real complexity lives — and the contract test suite
([11](11-testing-architecture.md) §5) asserts each adapter produces the right taxonomy member
from recorded provider responses.

## 5. Inbound webhooks

```
POST /v1/webhooks/:provider
  1. read RAW body (never the parsed body — re-serialisation breaks HMAC)
  2. verify signature + timestamp window (≤5 min) in constant time
  3. reject replays: UNIQUE (provider, provider_event_id)
  4. INSERT into inbound_webhook_events  (raw payload retained 30 days)
  5. return 200 immediately  ── target p99 < 100ms
  6. enqueue for asynchronous processing
```

Acknowledging fast and processing later is what keeps a provider from disabling our
endpoint during a traffic spike or a slow database. Unverified payloads are recorded with
`signature_valid = false` and never processed — they are evidence, and a spike in them is
an alert. Because raw events are stored, **replay is a first-class operation**: a
processing bug is fixed by redeploying and reprocessing, not by asking the provider to
resend.

## 6. Ingestion (pulling data in)

Incremental and cursor-based, never full re-sync:

- `sync_cursors` stores the last position per `(connection, resource)`.
- Jobs are chunked with a bounded page budget per run and reschedule themselves — so a
  large account cannot monopolise a worker.
- Backfill on first connect is a separate, lower-priority queue with an explicit window
  (e.g. 90 days), visible to the user as progress.
- Metric snapshots are **upserted by `(entity, captured_at, granularity)`** because
  providers restate recent numbers for days after the fact. Insert-only ingestion produces
  duplicated, drifting metrics — a very common and very expensive mistake in this category
  of product.

## 7. Failure modes

| Failure | Detection | Response |
| --- | --- | --- |
| Access token expired | 401 from provider | Refresh under lock; retry once; else → `expired` + notify |
| Refresh token revoked | Refresh returns invalid_grant | → `revoked`, hold scheduled work, prompt reconnect |
| Provider rate limit hit | 429 / headers | Bucket absorbs; job delayed to `reset_at`; not counted as a failure |
| Provider outage | Error rate over window | Circuit opens; connection → `degraded`; jobs deferred; status banner |
| Provider changes its API | Contract tests fail against recorded fixtures; error-rate alert | Adapter fixed in isolation; no core change |
| Webhook signature invalid | Verification step | Record, alert on rate, never process |
| Duplicate webhook | Unique constraint | Ignored idempotently |
| Publish succeeded but our write failed | Reconciliation job compares `publishing_attempts` against provider state | Reconcile rather than re-post |
| Adapter bug returns wrong taxonomy | Contract test | Blocked in CI |

## 8. Adding a new provider — the whole checklist

1. `packages/integrations/<slug>` with a `ProviderManifest`.
2. Implement only the ports it genuinely supports.
3. Map its errors into the taxonomy.
4. Record HTTP fixtures; the shared contract suite runs automatically against them.
5. Insert an `integration_providers` row (migration).
6. Add scopes, callback URL and credentials to environment/secret configuration.
7. Document setup and required app permissions in `docs/integrations/<slug>.md`.

**No core file is edited.** If a change to a core file is needed, the abstraction is wrong,
and that is the signal to fix the abstraction rather than special-case the provider.
