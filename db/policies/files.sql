-- files — METADATA HERE, BYTES ELSEWHERE
--
-- WHO MAY READ:  a session inside the owning organization, AND — for a file tagged with a workspace —
--                either that workspace is in the actor's resolved accessible set, or the actor holds
--                organization-wide workspace access. Same shape as `audit_events` and
--                `outbox_events`: a file names a workspace, so listing files would enumerate
--                workspaces.
-- WHO MAY WRITE: INSERT inside the acting organization, and UPDATE on a NAMED LIST OF COLUMNS.
--
-- THE COLUMN GRANT IS THE CONTROL THIS TABLE TURNS ON.
--
-- 10-security-architecture.md §3 requires that an "async malware scan gates scan_status before a file
-- is usable". A request-serving session that could write `scan_status` would defeat that with one
-- UPDATE — and RLS would allow the statement, because the row passes the tenant predicate. A policy
-- cannot express "you may change these columns and not those"; a column-level GRANT can:
--
--   growth_os_app    SELECT, INSERT, and UPDATE (mime_type, size_bytes, checksum, status,
--                    finalized_at, deleted_at) — everything finalisation and deletion need.
--   growth_os_relay  SELECT, and UPDATE (scan_status, scan_detail, scanned_at, status) — the
--                    scanner's columns, and deliberately NO INSERT: a scanner that could create rows
--                    could manufacture a clean verdict for an object nobody uploaded.
--
-- `status` appears in both lists on purpose. Finalisation promotes `reserved` → `ready`; an infected
-- verdict moves `ready` → `rejected`, in the same statement as the verdict so there is no window in
-- which a file is recorded infected and still serveable.
--
-- A FILE IS USABLE ONLY WHEN `status = 'ready' AND scan_status = 'clean'`. Two columns, not one,
-- because they answer different questions — did the bytes arrive, and are they safe — and a single
-- column would make "uploaded but not yet scanned" indistinguishable from "uploaded and clean",
-- which is the exact distinction the requirement rests on. `requestDownload` puts both in its WHERE
-- clause, so an unscanned file has no URL rather than an unenforced one.
--
-- A ROW EXISTS BEFORE THE BYTES DO. The client uploads directly to storage (02 §"S3-compatible object
-- storage"), so the server reserves a row and a key first and learns the upload happened only when
-- the client returns. `reserved` rows may have no object behind them and are reaped; `ready` rows
-- have one whose size and digest the server verified against storage.
--
-- THE STORAGE KEY IS SERVER-GENERATED, and the CHECK constraint says so in the schema. A
-- client-influenced key is a path-traversal primitive and a cross-tenant write: `../`, or another
-- organization's prefix, and the presigned URL makes the write legitimate. The constraint means a row
-- with a hand-written key cannot exist even if a future code path stopped generating them.
--
-- canonical-using:      ((organization_id = app_current_organization_id()) AND ((workspace_id IS NULL) OR app_workspace_scope_is_all() OR (workspace_id = ANY (app_current_workspace_ids()))))
-- canonical-with-check: (organization_id = app_current_organization_id())

ALTER TABLE files ENABLE ROW LEVEL SECURITY;
ALTER TABLE files FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON files
  USING (
    organization_id = app_current_organization_id()
    AND (
      workspace_id IS NULL
      OR app_workspace_scope_is_all()
      OR workspace_id = ANY (app_current_workspace_ids())
    )
  )
  WITH CHECK (organization_id = app_current_organization_id());
