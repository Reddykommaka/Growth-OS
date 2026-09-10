# 03 — Repository & Application Structure

## 1. Layout

A pnpm workspace with Turborepo. Four deployable apps, and every line of business logic in
versioned internal packages.

```
growth-os/
├── apps/
│   ├── web/                      Next.js 16 — dashboard, storefront, public pages
│   ├── api/                      Fastify 5 — /v1 REST, webhook receivers
│   ├── worker/                   BullMQ consumers, scheduler, outbox relay, intelligence jobs
│   └── link/                     Tracked-link redirect service (p99 < 50ms, own uptime profile)
│
├── packages/
│   ├── platform/                 Cross-cutting foundations (no business rules)
│   │   ├── config/               Zod-validated env; server/client split
│   │   ├── types/                Branded ids, Money, Result, pagination primitives
│   │   ├── errors/               Error taxonomy → RFC 9457 problem+json
│   │   ├── logger/               pino, redaction, correlation context
│   │   ├── telemetry/            OpenTelemetry bootstrap, span helpers
│   │   ├── db/                   Drizzle client, tenant session, UnitOfWork, base repo
│   │   ├── events/               Domain-event registry, outbox writer, typed bus
│   │   ├── jobs/                 Queue port + BullMQ adapter + in-memory fake
│   │   ├── cache/                Cache port, Redis adapter, in-memory fake
│   │   ├── ratelimit/            Token buckets, per-key policies
│   │   ├── authn/                Sessions, password, OAuth, MFA, device trust
│   │   ├── authz/                Permission catalogue, roles, policy engine, ActorContext
│   │   ├── entitlements/         Plan features, quotas, metering
│   │   ├── audit/                Append-only, hash-chained audit writer
│   │   ├── notifications/        Channel-agnostic notification service
│   │   ├── files/                Storage port, S3 adapter, upload policy, scanning
│   │   ├── search/               Search port, Postgres FTS adapter
│   │   ├── i18n/                 Message catalogues, ICU formatting, timezone helpers
│   │   ├── health/               Liveness and readiness checks (added in Phase 0, 0.8)
│   │   └── automation/           Workflow definitions, runtime, step registry
│   │
│   ├── integrations/
│   │   ├── core/                 Ports, provider registry, credential vault,
│   │   │                         OAuth lifecycle, webhook verification, error taxonomy
│   │   ├── meta-core/            Shared Meta auth, Graph transport, webhooks, rate budget
│   │   ├── instagram/  facebook/  threads/        ← depend on meta-core (ADR-0015)
│   │   ├── youtube/  linkedin/  tiktok/  x/  pinterest/
│   │   ├── google-ads/  meta-ads/  linkedin-ads/
│   │   ├── stripe/  resend/  s3/
│   │   ├── anthropic/  openai/   ← ModelProviderPort adapters; the ONLY place model SDKs appear
│   │   └── testkit/              Recorded fixtures + contract-test suite every adapter runs
│   │
│   ├── modules/                  ← business domains; the real boundaries
│   │   ├── identity/             Users, sessions, credentials, profiles
│   │   ├── organization/         Orgs, workspaces, teams, members, invitations, settings
│   │   ├── billing/              Plans, subscriptions, invoices, usage
│   │   ├── social/               Accounts, content, calendar, publishing, inbox, listening
│   │   ├── marketing/            Strategy, campaigns, ads, landing pages, forms, email
│   │   ├── crm/                  Contacts, companies, deals, pipelines, activities
│   │   ├── marketplace/          Listings, catalogue, orders, payouts, reviews, disputes
│   │   ├── analytics/            Identity graph, touchpoints, attribution, metrics, reports
│   │   └── intelligence/         Knowledge graph, feature store, retrieval, AI capabilities,
│   │                             prompt/eval registries, recommendation engine
│   │
│   ├── ui/                       Design system: tokens, primitives, composites
│   ├── charts/                   visx-based chart library on design tokens
│   └── testing/                  PG cluster harness, factories, fixtures, authz matrix
│
├── db/
│   ├── migrations/               Numbered, immutable SQL migrations
│   ├── policies/                 RLS policy definitions (reviewed as security artefacts)
│   └── seeds/                    Deterministic dev/demo seed data
│
├── infra/
│   ├── terraform/                envs/{staging,production}, modules/
│   └── docker/                   Dockerfiles, compose for local optional services
│
├── docs/                         This document set + ADRs + runbooks
└── .github/workflows/            CI/CD pipelines
```

## 2. Anatomy of a business module

Every package under `packages/modules/` has the same four layers. Uniformity is what makes
a large codebase navigable by someone who has never opened it.

```
packages/modules/social/
├── src/
│   ├── contracts/            ← the ONLY public surface
│   │   ├── index.ts            Service interfaces, DTOs, permission literals
│   │   ├── events.ts           Domain events this module publishes (versioned)
│   │   └── errors.ts           Module-specific error types
│   │
│   ├── domain/               ← pure; zero I/O, zero framework imports
│   │   ├── entities/           SocialPost, ContentItem, PublishingAttempt …
│   │   ├── value-objects/      PostSlot, MediaRef, PlatformConstraints
│   │   ├── policies/           Business rules (e.g. per-platform content validation)
│   │   └── events.ts           Event constructors
│   │
│   ├── application/          ← use cases; orchestration only
│   │   ├── services/           SchedulePostService, PublishPostService …
│   │   ├── queries/            Read models for the UI (projection-shaped)
│   │   └── ports.ts            What this module needs from outside (interfaces)
│   │
│   └── infrastructure/       ← the only place Drizzle, Redis or SDKs appear
│       ├── schema.ts           Drizzle table definitions owned by this module
│       ├── repositories/
│       ├── subscribers/        Handlers for other modules' events
│       └── jobs/               Queue consumers this module registers
└── package.json              exports: { "./contracts": …, "./infrastructure": … }
```

### The dependency rule

```
domain  ←  application  ←  infrastructure
   ▲            ▲
   └── contracts (depends on nothing but platform/types)
```

`domain` imports nothing but `packages/platform/types`. `application` may import `domain`
and its own `ports.ts`. Only `infrastructure` may import Drizzle, Redis, SDKs, or another
module's `contracts`.

### How boundaries are actually enforced

Four independent mechanisms, because a convention nobody can violate is worth more than
one everybody agrees with:

1. **`package.json` `exports`** — deep paths are simply unresolvable. `import { x } from
   '@growth-os/social/domain/entities/post'` fails to build.
2. **pnpm strict node_modules** — a package can only import what it declares as a
   dependency. Accidental coupling fails at install/build, not at review.
3. **dependency-cruiser rules in CI** — encode the layering rule, the "apps may only import
   contracts" rule, and a no-cycles rule.
4. **Biome `noRestrictedImports`, scoped by path override** — bans `drizzle-orm`,
   `postgres`/`pg`, `ioredis`, `bullmq`, `stripe` and `@aws-sdk/*` from `domain/` and
   `application/`, and bans model-provider SDKs (`@anthropic-ai/sdk`, `openai`,
   `@google/generative-ai`) **everywhere except `packages/integrations/*`**
   ([ADR-0013](../adr/0013-model-provider-abstraction.md)). Biome also enforces the
   `noExplicitAny` and `noNonNullAssertion` bans and the complexity/function-length caps.

Each mechanism is itself tested: `boundaries.test.ts` holds deliberately illegal imports and
asserts each is rejected. A misconfigured rule that silently enforces nothing is worse than
no rule, because it is believed.

## 3. Inter-module communication — the two legal forms

**Synchronous:** module A imports module B's `contracts`, receives an implementation via
the composition root, and calls it. A never learns B's tables exist.

**Asynchronous:** module A publishes a domain event; module B subscribes. This is the
default for anything that crosses product boundaries, because it keeps write paths short
and lets products evolve independently.

```ts
// packages/modules/social/src/contracts/events.ts
export const SocialPostPublished = defineEvent('social.post.published', 1, z.object({
  organizationId: OrganizationId,
  workspaceId:    WorkspaceId,
  postId:         SocialPostId,
  contentItemId:  ContentItemId.nullable(),
  campaignId:     CampaignId.nullable(),   // the attribution seam
  platform:       PlatformSlug,
  publishedAt:    z.coerce.date(),
  permalink:      z.string().url().nullable(),
}));
```

`analytics` subscribes to open a touchpoint stream; `marketing` subscribes to update
campaign state; `automation` subscribes to fire triggers. None of them import `social`'s
tables, and adding a fourth subscriber changes no existing code.

**Event versioning:** the version number is part of the event identity. A breaking change
publishes `v2` alongside `v1` until every subscriber has migrated; the registry fails CI if
a `v1` payload schema changes after first release.

## 4. The composition root

Wiring lives in exactly one place per app (`apps/*/src/bootstrap/`). It constructs
adapters, injects them into module factories, registers event subscribers and job
consumers, and returns a typed container. Nothing else in the codebase constructs an
adapter, which is what makes every service testable with fakes.

## 5. Anti-patterns this structure makes impossible

| Anti-pattern | Why it can't happen here |
| --- | --- |
| Business logic in a React component | `apps/web` cannot import `domain/` or `infrastructure/` |
| Marketplace querying CRM tables directly | Table definitions are not exported; no shared schema module |
| A "utils" package that everything depends on | `platform/` packages are single-purpose and reviewed; a generic `utils` package is rejected in review |
| A 3,000-line service file | Lint caps file length (400 lines) and function length; use cases are one file each |
| An AI SDK call inside a React component | Model SDKs are lint-banned outside `integrations/*`; product code sees only `IntelligencePort` |
| A prompt as an inline string | Prompts live in the versioned registry; a capability referencing an unregistered prompt fails to build |
| Circular module dependencies | dependency-cruiser no-cycle rule fails CI |
| Silent `any` | `strict` + explicit-any lint rule |
