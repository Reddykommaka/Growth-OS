# Integration — <Provider>

Per-provider setup and operational notes. Written when the adapter is built, not after
someone has had to reverse-engineer it from the code.

See [07-integration-architecture.md](../architecture/07-integration-architecture.md) for the
ports-and-adapters design this fits into.

## At a glance

| | |
| --- | --- |
| Package | `packages/integrations/<slug>` |
| Category | social / advertising / email / messaging / payment / storage / model |
| Ports implemented | `SocialPublishingPort`, … |
| Auth type | OAuth 2.0 + PKCE / API key / signed request |
| Shares an auth core? | e.g. `meta-core` ([ADR-0015](../adr/0015-meta-provider-family.md)) |
| App review required? | Yes — start it in Phase N; it is calendar time that cannot be compressed |

## Capabilities

What the manifest declares and, more usefully, **what it deliberately does not**. A
capability the provider technically has but we do not support is worth recording, with the
reason.

| Capability | Supported | Limits |
| --- | --- | --- |
| `social.publish` | yes | formats, max length, max media, native scheduling |
| `social.insights` | yes | granularity, history window, reporting lag |
| `social.engagement` | partial | comments yes, DMs no |

## Setup

1. Where to register the application, and which account owns it.
2. Exact scopes requested, **and why each one is needed**. A reviewer will ask, and so will
   the provider's app review.
3. Redirect URIs per environment.
4. Which secrets to set, by name. Never a value.
5. Anything that must be requested from the provider and waited for.

## Rate limits

The documented limits, the bucket they apply to (app, account, endpoint), and — importantly
— what the response headers actually report, since that is what the limiter corrects against.

## Error mapping

How this provider's failures map onto the normalized taxonomy
([07](../architecture/07-integration-architecture.md) §4). Providers report the same
condition in wildly different ways; this table is where that complexity lives.

| Provider error | Taxonomy | Retry? |
| --- | --- | --- |
| HTTP 429 / code N | `RateLimited` | yes, honour `Retry-After` |
| code N | `AuthExpired` | refresh, then once |
| code N | `ContentRejected` | no — surface to the user |

## Webhooks

Signature scheme, the exact bytes signed, timestamp tolerance, and the field carrying the
provider event id used for replay protection.

## Gotchas

The things that cost someone a day. Undocumented behaviour, silent truncation, restated
metrics, sandbox differences. This section is the most valuable one in the file.
