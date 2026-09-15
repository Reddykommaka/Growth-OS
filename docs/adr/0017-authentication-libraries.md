# ADR-0017 — Replace the unmaintained authentication libraries

**Status:** Accepted · **Date:** 2026-09-15 · **Amends:** [ADR-0006](0006-own-identity.md)

## Context

[ADR-0006](0006-own-identity.md) decided that we own the identity tables and assemble
authentication from three focused libraries: `arctic` for OAuth flows, `oslo` for crypto
primitives, and `@node-rs/argon2` for password hashing. That decision stands. This ADR
changes only *which* libraries, because two of the three are no longer maintained.

Verified against the registry on 2026-09-15, not inferred:

| Package | Registry status | Last publish |
| --- | --- | --- |
| `oslo` | **"Package is no longer supported. Please see https://oslojs.dev for the successor project."** | 2025-01-20 |
| `arctic` | **"Package no longer supported."** | — |
| `@node-rs/argon2` | actively maintained | current |

An unmaintained dependency is tolerable in many places. Inside the authentication layer it
is not: a vulnerability disclosed against it has no upstream fix, and the blast radius is
every credential in the system. This is the "genuine security, maintenance or
production-support concern" that justifies replacing a security primitive.

`oslo`'s own author points at a successor (`@oslojs/*`), which is a viable path. We are not
taking it for the parts we can satisfy from the standard library, for the reason in the
decision below.

## Decision

**Password hashing: unchanged.** `@node-rs/argon2` at Argon2id m=64MiB, t=3, p=4.

**Crypto primitives: `node:crypto`, not a library.** Token generation, SHA-256 hashing,
constant-time comparison and HMAC are all standard-library calls in Node 22. TOTP (RFC 6238)
is implemented directly — roughly forty lines of HMAC plus a truncation — and verified
against the **official RFC 6238 Appendix B test vectors** across SHA1, SHA256 and SHA512,
with base32 verified against the RFC 4648 §10 vectors.

This is deliberately *not* "rolling our own crypto", which [ADR-0006](0006-own-identity.md)
rejects without qualification. No primitive is invented: HMAC and SHA-256 come from OpenSSL
via `node:crypto`. What is implemented is the RFC's *composition* of those primitives, and
it is checked against the standard's own published vectors — stronger assurance than
trusting an abandoned package, which is verified against nothing at all.

**OAuth: `openid-client`, replacing `arctic`.** Version 6.x, actively maintained by the
author of `jose`, implementing OAuth 2.0 and OpenID Connect with PKCE, `state` and `nonce`
validation. OAuth is the one place where writing it ourselves *would* be rolling our own
security protocol: discovery, PKCE, nonce binding, ID-token signature verification and JWKS
rotation are a large surface with a long history of subtle, exploitable mistakes.

The requirement from [06 §2](../architecture/06-identity-and-access.md) is unchanged and
binding: PKCE, `state` and `nonce` all verified, and an OAuth identity linked to a user
**only after email ownership is proven**.

## Alternatives considered

- **Stay on `oslo` and `arctic`.** Rejected. They work today; the risk is that they keep
  working right up until a disclosure, at which point we are forking a dead package on the
  login path under time pressure.
- **Migrate to `@oslojs/*`, the author's successor.** A real option, and close. Rejected for
  the primitives because everything we need from it is in `node:crypto`, and a dependency
  that saves forty lines is not worth the supply-chain surface in this layer. It remains the
  fallback if we later need something the standard library lacks.
- **Write the OAuth flows ourselves too, for symmetry with TOTP.** Rejected, and the
  asymmetry is the point. TOTP is one HMAC with published test vectors; OAuth/OIDC is a
  protocol with discovery, token exchange, JWKS rotation and signature verification, no
  equivalent conformance vectors we can run in CI, and a documented history of
  implementation-level breaks. The line is drawn at "can we verify it against the standard
  itself" — TOTP can, OIDC cannot.
- **Adopt a full auth framework after all** (`better-auth`, Auth0, Clerk). Rejected again,
  for the reasons already given in [ADR-0006](0006-own-identity.md); nothing about a
  dependency deprecation changes the argument about owning the membership model.

## Consequences

**Positive:** no unmaintained code on the authentication path. TOTP is verified against the
specification rather than against another implementation that might share a bug. One fewer
dependency overall.

**Negative:** we own ~120 lines of TOTP, base32 and token code that a library previously
owned, including its future maintenance. Mitigated by the RFC vectors: a regression in that
code fails CI against the standard, which is a stronger guarantee than the tests most
libraries ship with.

**Neutral:** [06 §1](../architecture/06-identity-and-access.md) is updated to name the
current libraries. The decision it records — own the tables, assemble from focused libraries
rather than adopting a framework — is unchanged.
