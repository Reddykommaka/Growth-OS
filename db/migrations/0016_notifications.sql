-- 0016 — Notifications: the in-app inbox, and the outbound message queue.
--
-- 03-repository-structure.md calls platform/notifications a "channel-agnostic notification
-- service", and 05-data-architecture.md §3 lists `notifications` with
-- (organization_id, recipient_user_id, type, payload, read_at). Two tables, not one, because
-- the two halves address different things and have different privileges:
--
--   notifications      An in-app row for a USER who already exists. Personal: only its
--                      recipient may read it.
--   outbound_messages  A rendered message for a CHANNEL ADDRESS, which may belong to nobody —
--                      an invitation is sent to an email address precisely because there is no
--                      account yet. Encrypted, and write-only for the application.
--
-- Collapsing them would force one of two bad outcomes: either an invitation needs a user row
-- before it can be sent, or the in-app inbox has to carry an addressee that is not a user.

-- ---------------------------------------------------------------------------------------
-- notifications — the in-app inbox
-- ---------------------------------------------------------------------------------------
CREATE TABLE notifications (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Nullable: a notification about a billing change belongs to the organization, not to a
  -- workspace, and forcing one on it would make the column meaningless where it is set.
  workspace_id      uuid        NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  recipient_user_id uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  /*
   * WHO CAUSED IT, recorded rather than inferred.
   *
   * The write rule below has to permit notifying somebody ELSE — that is what a notification
   * is — which means a member can put a row in another member's inbox. The defence against a
   * fabricated one is that the type registry and the rendering are CODE, so a notification can
   * only say what a declared type can say; this column is what makes the remaining surface
   * attributable rather than anonymous. NULL means the system, not "unknown".
   */
  actor_user_id     uuid        NULL REFERENCES users(id) ON DELETE SET NULL,
  -- Not an FK and not an enum: the type catalogue lives in code, for the same reason the
  -- permission and capability catalogues do. A table that could disagree with the code about
  -- which types exist is a second source of truth, and the disagreement shows up as a
  -- notification nothing knows how to render.
  type              text        NOT NULL,
  payload           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  read_at           timestamptz NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_type_not_blank CHECK (length(btrim(type)) > 0),
  CONSTRAINT notifications_read_after_created CHECK (read_at IS NULL OR read_at >= created_at)
);

/*
 * The inbox query: one recipient's unread notifications, newest first. Partial on `read_at IS
 * NULL` because that is the query the UI runs on every page load, and the read ones are the
 * ones that accumulate forever.
 */
CREATE INDEX notifications_unread
  ON notifications (recipient_user_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE INDEX notifications_recipient_created
  ON notifications (recipient_user_id, created_at DESC);
CREATE INDEX notifications_organization_id ON notifications (organization_id);
-- Covers the FK, and answers "what did this user cause" when a fabricated notification is
-- reported.
CREATE INDEX notifications_actor_user_id ON notifications (actor_user_id)
  WHERE actor_user_id IS NOT NULL;
CREATE INDEX notifications_workspace_id ON notifications (workspace_id)
  WHERE workspace_id IS NOT NULL;

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE  ROW LEVEL SECURITY;

/*
 * A NOTIFICATION IS PERSONAL, AND THE READ RULE SAYS SO.
 *
 * The tenant predicate alone would let any member of an organization read every member's
 * inbox with raw SQL — including notifications about workspaces, listings and invoices they
 * cannot otherwise see. The recipient clause is what makes the inbox an inbox.
 *
 * THE WRITE RULE IS DELIBERATELY WIDER, and cannot be otherwise: notifying somebody else is
 * the entire operation. A rule requiring `recipient_user_id = app_current_user_id()` would
 * permit only notifying yourself. The asymmetry is the same shape as `audit_events`', and the
 * same reasoning applies — the narrow direction is the dangerous one, and this is not it.
 *
 * The workspace clause is NOT in the read rule. It would be redundant: a notification is
 * already restricted to one user, and that user's own notification about a workspace is one
 * they were deliberately told about. Adding the clause would silently hide notifications from
 * a session whose accessible set had narrowed — which is a support ticket, not a protection.
 */
CREATE POLICY tenant_isolation ON notifications
  USING      (organization_id = app_current_organization_id()
              AND recipient_user_id = app_current_user_id())
  WITH CHECK (organization_id = app_current_organization_id());

-- Read and dismiss are both the recipient's to perform, and the USING clause above already
-- confines them to their own rows. A notification is not a record of truth — `audit_events` is
-- — so there is no reason to withhold DELETE.
REVOKE ALL ON notifications FROM growth_os_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON notifications TO growth_os_app;

-- ---------------------------------------------------------------------------------------
-- outbound_messages — the deferred, encrypted channel queue
-- ---------------------------------------------------------------------------------------
-- WHY THIS TABLE EXISTS AT ALL, stated plainly, because the reasoning is the whole design.
--
-- An invitation email must carry the single-use token. The token exists only in memory at
-- creation time — only its hash is stored (ADR-0018) — so something must carry it from the
-- transaction that created it to the process that sends the mail. Three routes were possible:
--
--   1. Send inline, inside the transaction. Refused by 01-overview.md §4: no HTTP call to a
--      third party happens inside a database transaction. It is also the dual-write bug — a
--      committed send with a rolled-back invitation, or the reverse.
--
--   2. Put the token in the outbox event payload. REFUSED, and this is the important one:
--      `outbox_events` is readable by any session in the organization under its RLS policy.
--      Any member could read another member's invitation token out of the queue and accept the
--      invitation in their place. @growth-os/events rejects a payload carrying a token for
--      exactly this reason.
--
--   3. This table. The rendered message is encrypted with a key the database never holds, and
--      the application role may INSERT and NOT SELECT. A tenant session stages a message it
--      cannot read back, and the outbox event carries only this row's id.
--
-- Route 3 is the only one where the token reaches the recipient and nothing else.
CREATE TABLE outbound_messages (
  -- Supplied by the caller, NOT defaulted. `INSERT ... RETURNING id` requires SELECT on the
  -- table, and withholding SELECT from the application is the point of this design — so the
  -- id has to be known before the insert rather than discovered from it.
  id              uuid        PRIMARY KEY,
  organization_id uuid        NOT NULL,
  workspace_id    uuid        NULL,
  -- Which transport. Text with a CHECK rather than an enum: 05 §1 forbids native enums because
  -- values cannot be removed and ALTER TYPE takes a lock.
  channel         text        NOT NULL,
  /*
   * The whole envelope — address, subject, body — as one authenticated ciphertext.
   *
   * Encrypting the fields separately would leave the recipient address in plaintext, and the
   * address is both PII and, for an invitation, the thing an attacker needs to know which token
   * to steal. AES-256-GCM's tag also makes tampering a decryption failure rather than a
   * successfully-sent altered message.
   */
  envelope        bytea       NOT NULL,
  /*
   * What the message is FOR, in the clear.
   *
   * Deliberately the only unencrypted content: the sender routes on it (which provider, which
   * rate limit) and an operator answers "are invitations going out" with it. A type name is not
   * sensitive; its payload is.
   */
  type            text        NOT NULL,
  status          text        NOT NULL DEFAULT 'pending',
  attempts        integer     NOT NULL DEFAULT 0,
  last_error      text        NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz NULL,
  dead_lettered_at timestamptz NULL,
  CONSTRAINT outbound_messages_channel_known CHECK (channel IN ('email')),
  CONSTRAINT outbound_messages_status_known
    CHECK (status IN ('pending', 'sent', 'failed', 'dead_lettered')),
  CONSTRAINT outbound_messages_type_not_blank CHECK (length(btrim(type)) > 0),
  CONSTRAINT outbound_messages_attempts_non_negative CHECK (attempts >= 0),
  -- `sent` without a timestamp would make "when did this go out" unanswerable, which is the
  -- first question asked when a customer says they never received it.
  CONSTRAINT outbound_messages_sent_has_timestamp
    CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  CONSTRAINT outbound_messages_dead_has_timestamp
    CHECK ((status = 'dead_lettered') = (dead_lettered_at IS NOT NULL))
);

CREATE INDEX outbound_messages_pending
  ON outbound_messages (created_at)
  WHERE status = 'pending';

CREATE INDEX outbound_messages_dead_lettered ON outbound_messages (dead_lettered_at)
  WHERE dead_lettered_at IS NOT NULL;

CREATE INDEX outbound_messages_organization_id ON outbound_messages (organization_id);

ALTER TABLE outbound_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_messages FORCE  ROW LEVEL SECURITY;

/*
 * The policy is the SECOND gate here, not the first.
 *
 * What actually stops a tenant reading a staged invitation token is the absent SELECT
 * privilege below — a policy cannot express "you may write this and never read it". The policy
 * is still written, and written properly, because privileges and policies fail independently:
 * if a future migration granted SELECT by accident, this predicate is what would keep one
 * tenant out of another's queue.
 */
CREATE POLICY tenant_isolation ON outbound_messages
  USING (
    organization_id = app_current_organization_id()
    AND (
      workspace_id IS NULL
      OR app_workspace_scope_is_all()
      OR workspace_id = ANY (app_current_workspace_ids())
    )
  )
  WITH CHECK (organization_id = app_current_organization_id());

-- INSERT AND NOTHING ELSE. Migration 0001's ALTER DEFAULT PRIVILEGES granted all four, so all
-- four are revoked and one is given back. No SELECT: the application stages a message it cannot
-- read. No UPDATE: `status`, `attempts` and `sent_at` are the sender's state, and a session that
-- could set `status = 'sent'` could suppress an invitation it did not want delivered.
REVOKE ALL ON outbound_messages FROM growth_os_app;
GRANT INSERT ON outbound_messages TO growth_os_app;

/*
 * The background worker drains this queue as well as the outbox.
 *
 * `growth_os_relay` is named after its first consumer, and it is the WORKER'S queue-draining
 * role rather than the relay's alone: both duties run in the same apps/worker process, on the
 * same pool, and need the same thing — to cross tenants in order to drain a queue. A fourth
 * role for a second queue in the same process would add a credential to rotate and bound
 * nothing further. What bounds it is its reach: two queue tables, no CREATE on the schema, and
 * a structural test asserting that set by equality rather than inclusion.
 */
GRANT SELECT, UPDATE, DELETE ON outbound_messages TO growth_os_relay;

-- ---------------------------------------------------------------------------------------
-- Queue signals
-- ---------------------------------------------------------------------------------------
-- Same shape and the same reasoning as outbox_lag(): one definition read by the readiness
-- check and the metrics exporter, so two dashboards cannot disagree about whether mail is
-- going out. Dead-lettered messages are excluded from the age, because a message that will
-- never be sent would otherwise pin the alert on forever.
CREATE OR REPLACE FUNCTION outbound_message_lag()
RETURNS TABLE (pending bigint, oldest_seconds double precision, dead_lettered bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT
    count(*) FILTER (WHERE status = 'pending')::bigint,
    EXTRACT(
      EPOCH FROM (now() - min(created_at) FILTER (WHERE status = 'pending'))
    )::double precision,
    count(*) FILTER (WHERE status = 'dead_lettered')::bigint
  FROM outbound_messages
$$;

REVOKE EXECUTE ON FUNCTION outbound_message_lag() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION outbound_message_lag() TO growth_os_app;
GRANT  EXECUTE ON FUNCTION outbound_message_lag() TO growth_os_relay;
GRANT  EXECUTE ON FUNCTION outbound_message_lag() TO growth_os_migrator;
