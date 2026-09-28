-- outbound_messages — THE SEALED CHANNEL QUEUE
--
-- WHO MAY READ:  nobody, from a request. The application role holds no SELECT at all.
-- WHO MAY WRITE: INSERT only, inside the acting organization.
--
-- THE PRIVILEGE IS THE PRIMARY CONTROL HERE, NOT THE POLICY. What this table exists to do is
-- carry an invitation token from the transaction that created it to the process that sends the
-- mail, and RLS cannot express the property that makes that safe: "you may write this row and
-- never read it back". A policy filters rows; the absent SELECT grant refuses the statement.
--
-- WHY THE TOKEN IS HERE AND NOT ON THE EVENT. An invitation mail must carry the single-use token,
-- which exists only in memory — ADR-0018 stores its hash and never the secret. Three routes:
--
--   1. Send inline, inside the transaction. Refused by 01-overview.md §4, and it is the dual-write
--      bug besides: a sent mail with a rolled-back invitation, or the reverse.
--   2. Put the token in the outbox event payload. REFUSED. `outbox_events` is readable by every
--      session in the organization under its own policy, so any member could lift another
--      member's invitation token out of the queue and accept in their place.
--      @growth-os/events rejects a payload carrying a token for exactly this reason.
--   3. This table: the rendered message sealed with AES-256-GCM under a key the database never
--      holds, INSERT-only for the application, and only the row's id on the event.
--
-- Route 3 is the only one where the token reaches the recipient and nothing else.
--
-- THE WHOLE ENVELOPE IS ENCRYPTED, not just the body. Encrypting the body alone would leave the
-- recipient address in plaintext, and the address is both PII and — for an invitation — exactly
-- what an attacker needs in order to know which queued token is worth stealing. `type` is the one
-- deliberate exception: the sender routes on it and an operator answers "are invitations going
-- out" with it. A type name is not sensitive; its payload is.
--
-- THE ID IS SUPPLIED, NOT DEFAULTED. `INSERT ... RETURNING id` requires SELECT on the table, and
-- withholding SELECT is the point — so the caller generates the id before the insert rather than
-- discovering it from one.
--
-- NO UPDATE EITHER. `status`, `attempts` and `sent_at` are the sender's state. A session that
-- could set `status = 'sent'` could suppress an invitation it did not want delivered, and the
-- suppression would be indistinguishable from a delivery.
--
-- THE POLICY IS STILL WRITTEN, AND WRITTEN PROPERLY. Privileges and policies fail independently:
-- if a future migration granted SELECT by accident, this predicate is what would keep one tenant
-- out of another's queue. Defence in depth is only depth if the second layer is correct.
--
-- canonical-using:      ((organization_id = app_current_organization_id()) AND ((workspace_id IS NULL) OR app_workspace_scope_is_all() OR (workspace_id = ANY (app_current_workspace_ids()))))
-- canonical-with-check: (organization_id = app_current_organization_id())

ALTER TABLE outbound_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_messages FORCE  ROW LEVEL SECURITY;

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
