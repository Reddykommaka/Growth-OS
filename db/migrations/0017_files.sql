-- 0017 — Files: metadata here, bytes in object storage.
--
-- 05-data-architecture.md §3 lists `files` with (organization_id, workspace_id, storage_key,
-- mime_type, size_bytes, checksum, scan_status, uploaded_by) and the note "metadata only; bytes in
-- object storage". 02 §"S3-compatible object storage" adds the reason the bytes are elsewhere:
-- presigned direct upload and download, so bytes never proxy through our app servers.
--
-- That choice is what makes this table's shape unusual, and the shape is the security design:
--
--   A ROW EXISTS BEFORE THE BYTES DO. The client uploads straight to storage, so the server never
--   sees the upload happen. It therefore RESERVES a row first (with the storage key it generated),
--   hands out a presigned PUT, and learns the upload succeeded only when the client comes back.
--   A row in `reserved` may have no object behind it; a row in `ready` has one whose size and
--   digest the server has verified against storage.
--
--   A FILE IS NOT USABLE UNTIL IT IS SCANNED. 10-security-architecture.md §3 requires an
--   "async malware scan [that] gates scan_status before a file is usable". `status` and
--   `scan_status` are therefore SEPARATE columns: the first says whether the bytes arrived, the
--   second whether they are safe, and a file needs both. Folding them into one column would make
--   "uploaded but not yet scanned" and "uploaded and clean" the same state, which is the exact
--   distinction the requirement rests on.

CREATE TABLE files (
  id              uuid        PRIMARY KEY,
  organization_id uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id    uuid        NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  /*
   * The object's path in the bucket. SERVER-GENERATED, never client-supplied.
   *
   * A client-chosen key is a path-traversal primitive and a cross-tenant one: `../` or another
   * organization's prefix would let one tenant write over another's object, and the presigned URL
   * would make it legitimate. The CHECK below is the schema's half of that guarantee — the key must
   * look exactly like a key this system generates, so a row with a hand-written one cannot exist
   * even if a future code path stopped generating them.
   */
  storage_key     text        NOT NULL,
  /*
   * What the bytes ACTUALLY are, per magic-byte inspection — not what the client claimed.
   *
   * 10 §3: "MIME allowlist verified by magic bytes not extension". NULL until finalisation,
   * because until then nobody has looked at the bytes.
   */
  mime_type       text        NULL,
  /*
   * What the client SAID it was uploading, kept for the mismatch case.
   *
   * A file whose declared type and sniffed type disagree is the interesting one: it is either a
   * confused client or an attempt to have a payload served with a type that makes it executable.
   * Keeping both is what makes the difference reportable rather than merely rejected.
   */
  declared_mime   text        NOT NULL,
  original_name   text        NOT NULL,
  /*
   * What the file is FOR, fixed at reservation.
   *
   * Stored rather than re-derived at finalisation, and the difference matters. Finalisation re-checks
   * the size cap and the format allowlist against the REAL bytes, and both of those are properties of
   * the purpose — so a purpose guessed from the declared MIME type would let a client reserve a
   * 64 MB `import` and finalise it as a 512 MB `media` file. The column is what makes the second
   * check the same check as the first.
   */
  purpose         text        NOT NULL,
  size_bytes      bigint      NULL,
  -- sha256 of the bytes, hex. NULL until finalisation. Not a money column despite the name
  -- "checksum" — bytea would be tidier, but hex text is what a presigned-upload ETag comparison
  -- and an API response both want, and converting in two directions is how they drift.
  checksum        text        NULL,
  status          text        NOT NULL DEFAULT 'reserved',
  scan_status     text        NOT NULL DEFAULT 'pending',
  scan_detail     text        NULL,
  uploaded_by     uuid        NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  finalized_at    timestamptz NULL,
  scanned_at      timestamptz NULL,
  deleted_at      timestamptz NULL,

  CONSTRAINT files_status_known
    CHECK (status IN ('reserved', 'ready', 'rejected', 'deleted')),
  -- The catalogue of purposes lives in code (packages/platform/files/src/policy.ts), like the
  -- permission and capability catalogues. The CHECK pins the set the schema will accept so a typo
  -- cannot create a row no policy describes.
  CONSTRAINT files_purpose_known
    CHECK (purpose IN ('media', 'document', 'import', 'export')),
  CONSTRAINT files_scan_status_known
    CHECK (scan_status IN ('pending', 'clean', 'infected', 'failed')),
  /*
   * The key's shape, enforced here as well as in code.
   *
   * `org/<uuid>/<yyyy>/<mm>/<uuid>` and nothing else: no dots, no slashes beyond the four, no
   * client-supplied segment at all. A traversal sequence cannot satisfy this, and neither can a
   * key naming another tenant's prefix by accident, because the organization id is in it and the
   * policy below pins the row's organization.
   */
  CONSTRAINT files_storage_key_shape
    CHECK (storage_key ~ '^org/[0-9a-f-]{36}/[0-9]{4}/[0-9]{2}/[0-9a-f-]{36}$'),
  /*
   * Two implications, NOT one equivalence.
   *
   * An equivalence — `(status = 'ready') = (measured)` — reads as the tighter statement and is wrong:
   * it forbids a file from ever LEAVING `ready`, because a deleted or scanner-rejected row keeps the
   * measurements it earned. The two directions that actually matter are that a ready file has been
   * measured (or it is an unverified file presented as verified) and that a reserved one has not (or
   * it is claiming a measurement nobody took).
   */
  CONSTRAINT files_ready_is_measured
    CHECK (
      status <> 'ready'
      OR (finalized_at IS NOT NULL AND size_bytes IS NOT NULL AND checksum IS NOT NULL
          AND mime_type IS NOT NULL)
    ),
  CONSTRAINT files_reserved_is_unmeasured
    CHECK (
      status <> 'reserved'
      OR (finalized_at IS NULL AND size_bytes IS NULL AND checksum IS NULL AND mime_type IS NULL)
    ),
  CONSTRAINT files_size_non_negative CHECK (size_bytes IS NULL OR size_bytes >= 0),
  CONSTRAINT files_checksum_is_sha256 CHECK (checksum IS NULL OR checksum ~ '^[0-9a-f]{64}$'),
  -- A scan verdict without a timestamp makes "how long has this been unscanned" unanswerable,
  -- which is the question that tells an operator the scanner has stopped.
  CONSTRAINT files_scan_verdict_has_timestamp
    CHECK ((scan_status = 'pending') = (scanned_at IS NULL)),
  CONSTRAINT files_deleted_has_timestamp CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
);

-- One row per object, so a retried finalisation cannot produce two rows claiming the same bytes.
CREATE UNIQUE INDEX files_storage_key_key ON files (storage_key);

/*
 * The listing query: a workspace's usable files, newest first. Partial on the two conditions that
 * together mean "usable" (10 §3), because that is the only combination a product surface ever asks
 * for and the rejected and unscanned rows are the ones that accumulate.
 */
CREATE INDEX files_usable
  ON files (workspace_id, created_at DESC)
  WHERE status = 'ready' AND scan_status = 'clean';

/*
 * The scanner's queue. A file that has arrived and not been scanned is work to do, and its age is
 * the signal that says the scanner has stopped.
 */
CREATE INDEX files_awaiting_scan
  ON files (finalized_at)
  WHERE status = 'ready' AND scan_status = 'pending';

/*
 * Abandoned reservations. A client that asks for an upload URL and never uploads leaves a row and,
 * possibly, a partial object. Both need reaping, and without this index the reaper scans the table.
 */
CREATE INDEX files_abandoned_reservations
  ON files (created_at)
  WHERE status = 'reserved';

CREATE INDEX files_organization_id ON files (organization_id);
CREATE INDEX files_uploaded_by ON files (uploaded_by) WHERE uploaded_by IS NOT NULL;

ALTER TABLE files ENABLE ROW LEVEL SECURITY;
ALTER TABLE files FORCE  ROW LEVEL SECURITY;

-- The workspace clause, same shape as audit_events and outbox_events: a file names a workspace, so
-- listing files freely would enumerate workspaces.
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

/*
 * THE APPLICATION MAY NOT SET A SCAN VERDICT.
 *
 * `scan_status`, `scan_detail` and `scanned_at` are the scanner's state. A request-serving session
 * that could write them could mark its own upload clean and have it served — which is precisely the
 * control 10 §3 asks for, defeated by one UPDATE that RLS would happily allow because the row passes
 * the tenant predicate.
 *
 * PostgreSQL has no per-column UPDATE policy, but it does have per-column GRANTs, so the privilege
 * is expressed as a column list. Everything the application legitimately updates is here, and the
 * three scanner columns are not.
 */
REVOKE ALL ON files FROM growth_os_app;
GRANT SELECT, INSERT ON files TO growth_os_app;
GRANT UPDATE (
  mime_type, size_bytes, checksum, status, finalized_at, deleted_at
) ON files TO growth_os_app;

/*
 * The scanner runs in the worker, across tenants, exactly as the relay and the sender do — so it
 * uses the same bounded role rather than a fourth one. It needs the columns the application is
 * denied, and it does NOT need INSERT: a scanner that could create file rows could manufacture a
 * clean verdict for an object nobody uploaded.
 */
GRANT SELECT ON files TO growth_os_relay;
GRANT UPDATE (scan_status, scan_detail, scanned_at, status) ON files TO growth_os_relay;

-- ---------------------------------------------------------------------------------------
-- Scan backlog
-- ---------------------------------------------------------------------------------------
-- The same shape as outbox_lag() and outbound_message_lag(), and the same reason for existing: one
-- definition, read by the readiness check and by whatever reports it, so two views of "is the
-- scanner keeping up" cannot disagree.
--
-- `infected` is counted separately from the backlog. It is not work in progress — it is a verdict,
-- and one that a human may want to know about — so folding it into the backlog would leave the
-- backlog alert firing over files that have already been dealt with correctly.
CREATE OR REPLACE FUNCTION file_scan_backlog()
RETURNS TABLE (awaiting bigint, oldest_seconds double precision, infected bigint, failed bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT
    count(*) FILTER (WHERE status = 'ready' AND scan_status = 'pending')::bigint,
    EXTRACT(
      EPOCH FROM (
        now() - min(finalized_at) FILTER (WHERE status = 'ready' AND scan_status = 'pending')
      )
    )::double precision,
    count(*) FILTER (WHERE scan_status = 'infected')::bigint,
    count(*) FILTER (WHERE scan_status = 'failed')::bigint
  FROM files
$$;

REVOKE EXECUTE ON FUNCTION file_scan_backlog() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION file_scan_backlog() TO growth_os_app;
GRANT  EXECUTE ON FUNCTION file_scan_backlog() TO growth_os_relay;
GRANT  EXECUTE ON FUNCTION file_scan_backlog() TO growth_os_migrator;
