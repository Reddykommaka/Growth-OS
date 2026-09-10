# Row-Level Security policies

RLS policies are the backstop the entire multi-tenant promise rests on
([06-identity-and-access.md](../../docs/architecture/06-identity-and-access.md) §4). They are
**reviewed as security artefacts**, separately from the feature that needs them.

## Convention

A policy lives in the migration that creates its table — PostgreSQL has no way to attach a
policy to a table that does not exist yet, and splitting them across migrations creates a
window in which the table is unprotected.

This directory holds the **canonical policy text** for every tenant-scoped table, kept in
sync with the migrations, so a reviewer (or an auditor) can read the isolation rules for the
whole system in one place without reconstructing them from a migration history.

```
db/policies/
  README.md          this file
  <table>.sql        the policy as it exists in the database, with its rationale
```

## Review rules

1. **A second reviewer is required** for anything in this directory, and for any migration
   that creates, alters or drops a policy
   ([10-security-architecture.md](../../docs/architecture/10-security-architecture.md) §6).
2. Every policy states, in a comment, **who may read and who may write**, in plain language,
   before the SQL.
3. `ENABLE` **and** `FORCE`. Without `FORCE` the table owner bypasses its own policy.
4. **Always write an explicit `WITH CHECK`**, even when it duplicates `USING`.

## Why `WITH CHECK` is always explicit

PostgreSQL reuses the `USING` expression as the write predicate when `WITH CHECK` is
omitted. For a symmetric policy that is harmless — verified against a live cluster during
Phase 0, and the architecture's original justification for this rule was corrected as a
result ([06](../../docs/architecture/06-identity-and-access.md) §4).

The rule stands for a different reason: **it forces the author to state the write rule
deliberately rather than inherit the read rule.** Where the two differ, inheriting is a
hole. The marketplace listings policy is exactly that case —

```sql
USING (status = 'published' OR seller_organization_id = app_current_organization_id())
```

— because a tenant could otherwise insert a listing carrying **another organization's**
seller id simply by marking it published.

An asymmetric policy also needs a **hand-written cross-tenant probe** alongside it: the
generic probe in `@growth-os/testing` inserts a minimal row and cannot know which column
value satisfies the broad predicate.

## What CI enforces

| Check | Where |
| --- | --- |
| Static: every tenant-scoped table has RLS enabled, forced, and a policy with `USING` and an explicit `WITH CHECK` | `tools/scripts/lint-migrations.mjs` |
| Runtime: the same, read from `pg_class` and `pg_policies` | `checkRlsCompleteness` |
| Runtime: `growth_os_app` never has `BYPASSRLS`; append-only tables withhold `UPDATE`/`DELETE` | `checkRolePosture` |
| Runtime: cross-tenant read, update, delete and insert all no-op | `probeCrossTenantAccess` |
| Runtime: no tenant context returns zero rows | `checkFailsClosedWithoutContext` |

The runtime checks are generated from `information_schema`, so **coverage grows with the
schema automatically**. A table added in a later phase is probed without anyone remembering
to add a test for it.
