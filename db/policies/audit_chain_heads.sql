-- audit_chain_heads — the per-organization chain tip
--
-- WHO MAY READ:  a member acting inside the organization.
-- WHO MAY WRITE: the same, INSERT and UPDATE only. There is no DELETE grant.
--
-- WHY THIS TABLE IS MUTABLE WHEN THE LOG IS NOT. It is a pointer, not the record. The chain
-- advances by moving it, so UPDATE is required; deleting it is not, and is withheld because
-- a missing head would let the next event restart the chain at sequence 1 under a fresh
-- genesis — precisely the erasure the chain exists to make impossible.
--
-- TAMPERING WITH IT DOES NOT REWRITE HISTORY. audit_events rows cannot be modified at all.
-- A head altered to any other value makes the NEXT event chain from something verification
-- rejects, so the break is detectable — which is the property being bought, rather than
-- prevention.
--
-- THE RESERVED ID. `01900000-0000-7000-8000-0000000000fe` is the platform chain, for
-- security events that precede any tenant (a failed sign-in against an address belonging to
-- nobody). Because this policy compares organization_id to the session's tenant, NO tenant
-- session can read it — correct, since one tenant must not learn that an address it does not
-- own failed to sign in.
--
-- canonical-using:      (organization_id = app_current_organization_id())
-- canonical-with-check: (organization_id = app_current_organization_id())

ALTER TABLE audit_chain_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_chain_heads FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON audit_chain_heads
  USING      (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
