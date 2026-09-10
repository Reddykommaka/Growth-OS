# ADR-0009 — Opaque server-side sessions instead of JWTs

**Status:** Accepted · **Date:** 2026-09-10 · **Approved:** 2026-09-10

## Context
B2B customers require that removing a user's access takes effect immediately — an employee
is terminated, a contractor's engagement ends, a device is stolen.

## Decision
Opaque 256-bit session tokens in `__Host-`-prefixed, `HttpOnly`, `Secure`, `SameSite=Lax`
cookies. Only `sha256(token)` is stored. Revocation deletes the row. JWTs are used only for
short-lived (≤5 min) service-to-service tokens.

## Alternatives considered
- **Stateless JWT access tokens with refresh tokens.** Rejected: revocation requires a
  denylist, which reintroduces the state JWTs were meant to avoid — while adding refresh
  rotation, replay detection and clock-skew handling. The complexity buys us nothing here,
  because we are not federating across independently-operated services.
- **JWT with very short expiry.** Rejected: a revocation window measured in minutes is still
  a revocation window, and the refresh traffic negates the lookup saving.

## Consequences
**Positive:** instant revocation; a database leak yields no usable sessions; device
management and session listing are natural; no refresh-token machinery.

**Negative:** a session lookup per request (cached in Redis, falling back to Postgres);
sessions are shared state that must be available. Accepted — availability of the session
store is a lower risk than the inability to revoke access.
