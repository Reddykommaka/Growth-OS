-- 0012 — Let pre-tenant security events reach the platform chain.
--
-- THE PROBLEM. Migration 0011 gives audit_events and audit_chain_heads the standard tenant
-- policy: organization_id = app_current_organization_id(). With no tenant context set,
-- app_current_organization_id() is NULL, every comparison is NULL, and the INSERT is refused.
--
-- That is correct for tenant data and wrong for the events that PRECEDE a tenant. A failed
-- sign-in against an address belonging to nobody, a registration, a password reset requested
-- from a login page — none of these have an organization, and all of them run on the
-- untenanted path (withoutTenantContext). Under 0011 alone they cannot be written at all, so
-- the audit log is silent about exactly the period an intrusion is most visible in.
--
-- THE FIX, AND ITS BOUNDS. The WITH CHECK rule gains one clause: a row may be written for the
-- reserved platform organization WHEN THERE IS NO TENANT CONTEXT. Both halves matter.
--
--   A tenant session cannot write platform rows. Its app.organization_id is non-null and is
--   not the reserved id, so the added clause is false for it and the original clause governs.
--
--   An untenanted session cannot write ANY OTHER organization's rows. The original clause is
--   NULL for it, so the added clause is the only one available, and that clause pins the
--   organization to a single literal id.
--
-- THE READ RULE IS NOT TOUCHED. Platform rows stay invisible to every tenant session, because
-- USING still compares against app_current_organization_id(). Reading them requires a session
-- that scopes itself to the reserved id deliberately — an operator path — which is correct:
-- one tenant must never learn that an address it does not own failed to sign in.
--
-- WHY A LITERAL AND NOT A TABLE. The reserved id is a constant of the system, like the seeded
-- system-role ids in 0006. Putting it in a lookup table would make the policy depend on a row
-- an attacker with write access could add, turning "one reserved chain" into "any chain you
-- can name".

CREATE OR REPLACE FUNCTION app_platform_organization_id() RETURNS uuid
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT '01900000-0000-7000-8000-0000000000fe'::uuid $$;

GRANT EXECUTE ON FUNCTION app_platform_organization_id() TO growth_os_app;

-- The predicate, named once so the two tables and every future partition cannot drift.
CREATE OR REPLACE FUNCTION app_may_write_audit(row_organization_id uuid) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT row_organization_id = app_current_organization_id()
       OR (app_current_organization_id() IS NULL
           AND row_organization_id = app_platform_organization_id()) $$;

GRANT EXECUTE ON FUNCTION app_may_write_audit(uuid) TO growth_os_app;

-- The head is READ and UPDATED to advance a chain, so an untenanted writer needs the same
-- rule on both sides: a USING that hid platform rows would hide them from the very
-- transaction that has to chain from them, and the chain would restart at every event.
DROP POLICY tenant_isolation ON audit_chain_heads;

CREATE POLICY tenant_isolation ON audit_chain_heads
  USING      (app_may_write_audit(organization_id))
  WITH CHECK (app_may_write_audit(organization_id));

DROP POLICY tenant_isolation ON audit_events;

CREATE POLICY tenant_isolation ON audit_events
  USING (
    organization_id = app_current_organization_id()
    AND (
      workspace_id IS NULL
      OR app_workspace_scope_is_all()
      OR workspace_id = ANY (app_current_workspace_ids())
    )
  )
  WITH CHECK (app_may_write_audit(organization_id));

-- Existing partitions carry their own copy of the policy (0011 hardens each one), so they
-- must be rewritten too — a partition still holding the old rule would refuse the platform
-- write for the month it covers, which is the kind of defect that surfaces on the 1st.
CREATE OR REPLACE FUNCTION harden_audit_partition(partition_name text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', partition_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', partition_name);

  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', partition_name);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %I
       USING (organization_id = app_current_organization_id()
              AND (workspace_id IS NULL
                   OR app_workspace_scope_is_all()
                   OR workspace_id = ANY (app_current_workspace_ids())))
       WITH CHECK (app_may_write_audit(organization_id))',
    partition_name
  );

  EXECUTE format('REVOKE ALL ON %I FROM growth_os_app', partition_name);
  EXECUTE format('GRANT SELECT, INSERT ON %I TO growth_os_app', partition_name);
END
$$;

-- Re-harden every partition that already exists under the new rule.
SELECT harden_audit_partition(c.relname)
  FROM pg_class c
  JOIN pg_inherits i ON i.inhrelid = c.oid
  JOIN pg_class p ON p.oid = i.inhparent
 WHERE p.relname = 'audit_events';
