# ADR-0018 — Credentials that precede a tenant context carry their tenant

**Status:** Accepted · **Date:** 2026-09-15 · **Approved:** 2026-09-15

## Context

Two credentials in Growth OS are presented by somebody who is not yet inside a tenant:

- an **invitation token**, redeemed by a person who is by definition not a member of the
  organization inviting them;
- an **API key**, presented on a request that has no session.

Both must resolve to an organization before anything else can happen. And both are stored in
tables — `invitations`, `api_keys` — that are tenant-scoped with `ENABLE` + `FORCE ROW LEVEL
SECURITY` and a policy of `organization_id = app_current_organization_id()`
(migration 0005). With no `app.organization_id` set, that predicate is NULL and the policy
fails closed.

So reading the row requires knowing the organization, and the only way to learn the
organization was to read the row. This is the same shape as the accessible-workspace-set
circularity that migration 0007 resolves, and it has the same property: it cannot be
papered over, because every workaround is a hole in tenant isolation.

It was found the way it should be found — by a test. Eleven of the twenty-two invitation
integration cases failed, every one of them returning `invalid`, because acceptance was
running through `withoutTenantContext`, whose own suite asserts that it "still sees ZERO
tenant rows". The code could not have worked, and the guarantee it violated was documented.

## Decision

A credential that must be presented before a tenant context exists **names the tenant it
belongs to**, as an explicitly untrusted routing hint.

- Invitation token: `<organizationId>.<secret>`, where `secret` is 256 bits of base64url.
  `sha256` of the **whole token** is stored.
- API key: `gos_live_<prefix>_<secret>` — the format recorded in 06 §2, unchanged — where
  `prefix` is the organization's 32 hex digits followed by a base32 random half. The prefix
  remains the public, uniquely-indexed, secret-scannable half it always was.

Resolution is then: parse the hint, open a transaction scoped to that organization with
`withOrganizationScope`, and look the row up **under RLS**. Nothing else changes: the
invitation's role, workspace and organization still come from the stored row, and the key's
scopes still come from its own.

The hint decides which tenant's scope to open and settles nothing else. Two independent
mechanisms make a forged one useless:

1. **The policy.** The row is visible only if its own `organization_id` equals the scope
   that was opened. A token or key pointed at another tenant finds nothing.
2. **The hash.** For invitations, `sha256` covers the organization segment too, so a secret
   lifted from one tenant's token does not hash to a stored value under any other. For keys,
   the prefix is uniquely indexed across the whole table, so a rewritten prefix matches no
   row anywhere.

The consequence worth stating plainly: **"accepting an invitation for the wrong
organization" stops being a check that could be forgotten and becomes a structural
impossibility**, enforced by the same policy that enforces every other tenant boundary.

## Alternatives considered

- **Relax the RLS policy on `invitations` and `api_keys` to permit reads with no tenant
  context.** Rejected, and not narrowly. It would turn `withoutTenantContext` — a primitive
  that exists precisely because it can reach nothing tenant-scoped — into an enumeration
  channel over every organization's outstanding invitations, invitee addresses and key
  metadata. The policy would no longer mean what its name says, and the one test that
  currently proves the untenanted path is inert would have to be deleted to make room.

- **A `SECURITY DEFINER` resolver function** owned by `growth_os_migrator` (BYPASSRLS),
  returning only an organization id for a given token hash or prefix. This is the textbook
  PostgreSQL answer and it was close. Rejected because it would introduce the system's
  **first** RLS-bypassing code path to solve a problem that does not require one. Every such
  function is a standing invitation to add a second, slightly wider one; the value of having
  none is that "does anything bypass RLS?" has a one-word answer.

- **A second, untenanted lookup table** mapping token hash → organization. Rejected: two
  sources of truth for the same fact, which can drift, and the drift is silent — a stale row
  routes a valid credential to the wrong tenant, where it is refused for a reason nobody can
  reconstruct.

- **Keep the key format and look keys up with no tenant filter at all**, relying on the
  unique prefix index. Rejected: this is the relaxed-policy option wearing a narrower hat,
  and it makes `api_keys` the one tenant table whose rows are readable from outside a tenant.

## Consequences

**Positive:** no RLS bypass anywhere in the system; no duplicated state; the wrong-tenant
attack is refused by the database rather than by application code; the same rule covers both
credentials, so there is one idea to understand rather than two mechanisms. The credential
scope is opened with the *empty* workspace set for invitations, so acceptance can reach
tenancy rows and no tenant content at all — strictly less reach than the primitive had
before this ADR.

**Negative:** tokens and keys are longer (an invitation token is 80 characters, a key about
100). The organization id becomes visible to anyone holding the credential — including in a
secret-scanning alert for a leaked key. Callers must remember that the hint is untrusted;
a future reader who mistakes it for an authorisation would write a real vulnerability.
`withOrganizationScope` now has three callers rather than one, and that count is the thing
its safety rests on.

**Mitigation:** the untrusted nature of the hint is stated at the primitive, at the port and
at both call sites, and the failing case is covered by integration tests that rewrite the
segment and assert both that nothing is granted and that the genuine credential still works.
The organization id is not a secret — anyone holding the credential already has access to
that tenant, and a uuidv7 discloses only a creation timestamp. The widening of
`withOrganizationScope` is offset by making its capability an explicit argument: two of the
three callers now take `'set'` with an empty workspace set and therefore see *less* than any
caller could before, and an architecture test pins both the caller list and the much
narrower list permitted to ask for `'all'`.

**Exit condition / trigger to revisit:** if a third credential class needs this treatment,
or if a future requirement makes the tenant id genuinely sensitive (a per-tenant privacy
guarantee that forbids disclosing which tenant a credential belongs to), revisit — the
likely replacement is a keyed lookup blinded with an HMAC of the tenant id rather than the
id in clear. Also revisit if PostgreSQL ever offers a policy that can consult a
caller-supplied parameter safely, which would let the row be found without a scope.
