# ADR-0006 — Own the identity tables; assemble authentication from focused libraries

**Status:** Accepted · **Date:** 2026-09-10 · **Approved:** 2026-09-10

## Context
A user's relationship to an organization is a first-class domain concept here: multi-org
membership, workspace-scoped roles, custom roles, seat-based billing, agency staff moving
between client workspaces, and support impersonation.

## Decision
Own `users`, `sessions`, `organization_members`, `roles` and `role_assignments`. Assemble
authentication from `arctic` (OAuth flows), `oslo` (crypto primitives) and
`@node-rs/argon2` (password hashing). Enterprise SSO and SCIM go behind an
`EnterpriseIdentityPort` in a later phase.

## Alternatives considered
- **`better-auth`.** The strongest alternative and faster to Phase 1. Rejected because its
  organization/role model would need extending immediately, and the coupling is hardest to
  unwind in precisely the part of the system that must never be worked around.
- **Auth0 / Clerk / WorkOS as the identity system of record.** Rejected: per-MAU pricing on a
  B2B product with many seats, an external dependency on the login path, and our membership
  model living in someone else's schema.
- **Rolling our own crypto.** Rejected without qualification.

## Consequences
**Positive:** the membership model is exactly what the domain requires; no vendor on the
critical login path; auth logic is testable in-process.

**Negative:** we own session management, MFA, account recovery and their security
correctness; more Phase 1 effort; enterprise SSO is later than a vendor would give us.

**Mitigation:** narrow, well-audited libraries for every primitive; the authorization matrix
and isolation suites; external penetration test before general availability.
