# ADR-0015 — Meta as one auth core with three provider adapters

**Status:** Accepted · **Date:** 2026-09-10 · **Approved:** 2026-09-10

## Context
Instagram, Facebook and Threads are Tier 1/Tier 2 target platforms. They share Meta's Graph
API, app registration, OAuth flow, token model, webhook transport and — critically — a
**shared rate-limit budget metered against the app, not the surface**. They differ in content
rules, media constraints, insight metrics and engagement surfaces.

## Decision
`packages/integrations/meta-core` owns OAuth, token lifecycle, Graph transport, webhook
verification and the shared rate-limit bucket. `integrations/instagram`,
`integrations/facebook` and `integrations/threads` are separate adapters with separate
capability manifests that depend on it. Three `integration_providers` rows, three capability
sets, one credential, one budget.

The same pattern applies to any vendor spanning multiple surfaces — Google (YouTube, Google
Ads, Analytics) is the next instance.

## Alternatives considered
- **One "meta" adapter with a surface parameter.** Rejected: it forces
  `if (platform === 'instagram')` branching inside the adapter, which is exactly the
  scattering the provider abstraction exists to prevent, and it makes capability manifests —
  which drive the composer UI — impossible to express per surface.
- **Three fully independent adapters.** Rejected: triplicates OAuth, refresh, webhook
  verification and rate-limit code, and accounts the shared budget three times. That is not
  merely wasteful, it is **wrong** — three adapters each believing they have the full quota
  will collectively exceed it and get the app throttled.

## Consequences
**Positive:** one credential and one budget per Meta app, correctly accounted; a Meta-side
API change is fixed once; each surface keeps an honest capability manifest so the UI adapts
per platform.

**Negative:** a shared package between adapters is a coupling that must be kept narrow —
`meta-core` may contain transport and auth, never business or content logic. Enforced by
review and by the contract test suite, which each adapter runs independently.
