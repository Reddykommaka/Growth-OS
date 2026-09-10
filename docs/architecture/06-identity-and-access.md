# 06 — Identity, Authentication & Authorization Architecture

## 1. Design stance

We **own the identity tables**. Authentication is assembled from focused, auditable
libraries (`arctic` for OAuth flows, `oslo` for crypto primitives, `@node-rs/argon2` for
password hashing) rather than delegated to a framework that owns the user record.

The reason is specific rather than ideological: in this product, a user's relationship to
an organization is a first-class domain concept (multi-org membership, workspace-scoped
roles, agency staff moving between client workspaces, seat-based billing). Auth frameworks
model that as a plugin on top of *their* schema. When the model diverges — and here it
does, immediately — you end up fighting the framework in the one part of the system that
must never be worked around.

`better-auth` was the serious alternative and would be faster to Phase 1. Rejected because
the coupling is hardest to unwind exactly where it matters most.
[ADR-0006](../adr/0006-own-identity.md).

## 2. Authentication

### Sessions, not JWTs, for the first-party web app

| Property | Decision |
| --- | --- |
| Token | 256 bits from a CSPRNG, opaque. **Only `sha256(token)` is stored** — a database leak does not yield usable sessions |
| Transport | Cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, `__Host-` prefix |
| Lifetime | 30 days sliding, 90 days absolute; re-auth required for sensitive actions |
| Revocation | Immediate — delete the row. This is the decisive advantage over JWTs: firing an employee must end their access *now*, not at token expiry |
| Rotation | Token rotates on privilege elevation and on MFA completion |
| Device list | Every session shows device, IP, location and last-used; users can revoke individually or globally |

JWTs are used only for short-lived (≤5 min), narrowly-audienced service-to-service tokens.

### Credentials and factors

- **Passwords:** Argon2id (m=64MiB, t=3, p=4), tuned to ~250ms on production hardware.
  Minimum length 12, no composition rules, checked against a breached-password corpus.
  Timing-safe verification; a dummy hash is verified for unknown emails so response time
  does not disclose account existence.
- **MFA:** TOTP and WebAuthn/passkeys. Recovery codes are single-use and hashed. MFA can be
  *required by organization policy*, enforced server-side at session establishment.
- **OAuth social login** via `arctic`: PKCE, `state`, `nonce` all verified. An OAuth
  identity is linked to a user only after email ownership is proven — otherwise an attacker
  who controls an unverified provider account can take over an existing user.
- **Enterprise SSO (SAML/OIDC) + SCIM provisioning** is Phase 7, behind an
  `EnterpriseIdentityPort` so the org-level policy (`sso_required`) is written now and the
  adapter (likely WorkOS) is plugged in later.
- **Machine access:** API keys (`gos_live_<prefix>_<secret>`), Argon2-hashed, scoped,
  expiring, per-organization, with `last_used_at` and per-key rate limits. Displayed once.
  Detectable by GitHub secret scanning by virtue of the prefix format.

### Impersonation

Support access is a first-class, constrained feature — never a shared admin password. It
requires a support role, a stated reason, an explicit time box (≤60 min), an
`audit_events` record marking every action as impersonated, and a persistent banner in the
UI. Impersonation is denied on billing mutations and credential reads.

## 3. Authorization

Three layers, each independently sufficient to deny. Defence in depth means a bug in one
does not become a breach.

```
   Layer 1  Application  authz.assert(actor, permission, resource)   ← primary, expressive
   Layer 2  Database     Row-Level Security on organization_id       ← backstop, unbypassable
   Layer 3  Privileges   GRANTs per role (no UPDATE on audit_events) ← structural limits
```

The UI additionally hides what the actor cannot do — but that is **usability, not
security**, and is never the only check. Every server action and every REST route resolves
an actor and asserts a permission before touching data.

### The permission model

Permissions are `<module>.<resource>:<action>` string literals, declared in each module's
`contracts` and unioned into a single exhaustive TypeScript type. A typo does not compile,
and the full catalogue is enumerable — which is what makes the authorization matrix test
([11](11-testing-architecture.md) §3) able to cover *every* permission automatically.

```ts
type Permission =
  | 'social.post:read'   | 'social.post:create'  | 'social.post:approve' | 'social.post:publish'
  | 'crm.deal:read'      | 'crm.deal:update'     | 'crm.deal:delete'
  | 'marketplace.listing:publish'
  | 'billing.subscription:manage'
  | 'organization.member:invite'
  /* … */;
```

**System roles** (org scope): `owner`, `admin`, `manager`, `member`, `analyst`, `billing`,
`guest`. **Workspace scope**: `workspace_admin`, `editor`, `contributor`, `approver`,
`viewer`. Organizations may define **custom roles** as permission sets — required by
agencies and enterprises, and cheap given the catalogue is data.

**Resource-level grants** (`resource_grants`) handle sharing a single campaign or report
with someone who otherwise lacks access — the common case that pure RBAC handles badly.

### Evaluation order

```
deny if session invalid / expired / MFA required and unsatisfied
deny if organization suspended or subscription in a blocking state
deny if the actor is not a member of the target organization
deny if the resource is workspace-scoped and the actor lacks that workspace
allow if a role assignment grants the permission at org or workspace scope
allow if a resource_grant grants it on this specific resource
allow if an ownership rule applies (e.g. 'crm.deal:update' on a deal you own)
otherwise deny            ← default deny, always
```

Resolved permission sets are cached per (session, organization) for 60s in Redis and
invalidated eagerly on role change, membership change or subscription state change.

**ReBAC migration path:** if resource-sharing graphs deepen (nested folders, delegated
agency hierarchies), the policy engine's interface allows swapping the evaluator for
OpenFGA without changing a single call site. Noted, not built.

## 4. Tenant isolation — the mechanism in detail

This is the control the entire multi-tenant promise rests on, so it is specified precisely.

**Two database roles:**
- `growth_os_app` — used by every request and job. `NOBYPASSRLS`. This is not configurable
  at runtime.
- `growth_os_migrator` — `BYPASSRLS`, used **only** by the migration job, which never runs
  in an application process.

**Every transaction opens with tenant context:**

```sql
BEGIN;
  SET LOCAL app.organization_id = '…';
  SET LOCAL app.user_id         = '…';
  -- all statements now filtered by RLS
COMMIT;
```

`SET LOCAL` (transaction-scoped) rather than `SET` (session-scoped) is deliberate: it is
correct under a transaction-mode connection pooler, where a session-level setting could
leak one tenant's context onto another tenant's next query through a recycled connection.
That is the exact failure mode that turns a pooling optimisation into a data breach.

**Policy shape:**

```sql
ALTER TABLE content_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_items FORCE ROW LEVEL SECURITY;   -- applies to the table owner too

CREATE POLICY tenant_isolation ON content_items
  USING      (organization_id = current_setting('app.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.organization_id', true)::uuid);
```

`WITH CHECK` matters as much as `USING`: without it, a tenant could *insert* rows
belonging to another organization even though it cannot read them.

**Structural guarantees, verified in CI:**
1. A test enumerates `information_schema` and fails if any table with an `organization_id`
   column lacks an enabled, forced RLS policy. **New tables cannot silently opt out.**
2. A test asserts the application role has `rolbypassrls = false`.
3. Cross-tenant probe tests attempt read, update, insert and delete of Org B's rows while
   in Org A's context, for every tenant-scoped table, and assert zero rows and zero effect.
4. A test asserts no application code path issues session-level `SET` for tenant context.

**Why both RLS and application checks?** RLS answers "which rows may this tenant touch" —
coarse and unbypassable. Application authz answers "may this actor perform this action on
this resource" — fine-grained and expressive. Neither substitutes for the other, and the
combination means a missed `authz.assert` becomes a permissions bug rather than a
cross-tenant data leak.

## 5. Failure modes

| Failure | Behaviour |
| --- | --- |
| `app.organization_id` not set | RLS `current_setting(…, true)` returns NULL → predicate false → **zero rows**. Fails closed |
| Session store (Redis) unavailable | Session validation falls back to Postgres; permission cache misses recompute. Degraded latency, not degraded security |
| Permission cache stale after a role change | Eager invalidation on change; 60s worst case. Revocations of *membership* bypass the cache and are immediate |
| Compromised session token | Revoke session; all devices listed and revocable; anomalous-IP detection raises a notification |
| Leaked API key | Per-key revocation; prefix-based secret scanning; key never recoverable after creation, so rotation is the only remedy — by design |
| Postgres role misconfigured with BYPASSRLS | CI assertion fails the deploy |
