-- notifications — THE PERSONAL INBOX
--
-- WHO MAY READ:  the RECIPIENT, acting inside the owning organization. Nobody else — not an
--                owner, not an administrator.
-- WHO MAY WRITE: any session inside the organization, for any recipient in it. INSERT, UPDATE
--                and DELETE are all confined to the reader's own rows by the USING clause.
--
-- THE READ RULE IS NARROWER THAN THE TENANT PREDICATE, AND THAT IS THE POINT. Without the
-- recipient clause any member could read every member's inbox with raw SQL — including
-- notifications about workspaces, listings and invoices they cannot otherwise see. A notification
-- names things by reference, so an inbox is a readable index of everything happening in the
-- organization. The recipient clause is what makes an inbox an inbox.
--
-- No administrative override, deliberately. "An owner may read any member's notifications" sounds
-- reasonable and is not: an owner already has the audit log for anything they legitimately need
-- to investigate, and an override here would make the inbox a surveillance surface with none of
-- the audit log's tamper-evidence.
--
-- THE WRITE RULE IS DELIBERATELY WIDER, and cannot be otherwise: notifying somebody else is the
-- entire operation. `recipient_user_id = app_current_user_id()` in WITH CHECK would permit only
-- notifying yourself. The asymmetry has the same shape as `audit_events`', and the same argument
-- applies — the narrow direction is the dangerous one, and this is not it.
--
-- So a member CAN put a row in another member's inbox, and that is a phishing surface. Three
-- things bound it, none of them RLS:
--   1. The type catalogue is CODE. A notification can only be one of the declared types, and the
--      rendering is chosen by type — the payload is interpolated into a template, never rendered
--      as markup or free text.
--   2. `actor_user_id` is recorded, so a fabricated notification is attributable rather than
--      anonymous. NULL means the system, not "unknown".
--   3. `notify` is not reachable from user input; application services call it.
--
-- THE WORKSPACE CLAUSE IS ABSENT, unlike `audit_events` and `outbox_events`. It would be
-- redundant — the row is already confined to one user, and that user was deliberately told about
-- the thing — and it would be actively harmful: a session whose accessible set had narrowed would
-- silently stop seeing notifications it had already received. That is a support ticket, not a
-- protection.
--
-- DELETE IS GRANTED, unlike on the append-only tables. A notification is not a record of truth;
-- `audit_events` is. Dismissing one is the recipient's to do.
--
-- canonical-using:      ((organization_id = app_current_organization_id()) AND (recipient_user_id = app_current_user_id()))
-- canonical-with-check: (organization_id = app_current_organization_id())

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON notifications
  USING      (organization_id = app_current_organization_id()
              AND recipient_user_id = app_current_user_id())
  WITH CHECK (organization_id = app_current_organization_id());
