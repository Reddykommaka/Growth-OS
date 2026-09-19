-- subscriptions — WHAT THE ORGANIZATION IS PAYING FOR
--
-- WHO MAY READ:  any session acting inside the owning organization. There is no workspace
--                clause because a subscription HAS no workspace: it is bought by the
--                organization and it is what every workspace inside it draws on.
-- WHO MAY WRITE: the same, subject to application authorization. The permission that gates
--                a change is `billing.subscription:manage`, declared organization-scoped,
--                so no workspace role carries it.
--
-- WHY THIS TABLE IS NOT THE BILLING PROVIDER'S RECORD. `provider` and
-- `provider_subscription_id` are deliberately generic, and deliberately the ONLY provider
-- data here: no price, no invoice, no card. The entitlement resolver reads a plan key and a
-- period from this table and nothing else (ADR-0020's separation of billing from
-- entitlement). A row here is our statement of what the organization is entitled to; the
-- provider's subscription object is a fact about how it is paid for, and the two go out of
-- sync for perfectly ordinary reasons — a webhook retried out of order, a dunning attempt
-- in flight — which is exactly why a gating decision must not read the provider.
--
-- `past_due` IS A LIVE STATUS. Cutting a customer off the moment a card fails turns a
-- payment retry into an outage for them. Loss of entitlement is a deliberate transition to
-- `canceled` or `unpaid`, made by the billing module, not a side effect of one failed charge.
--
-- ONE LIVE SUBSCRIPTION PER ORGANIZATION is enforced by a partial unique index rather than
-- by application code, because the resolver reads exactly one row and "which one" must not
-- be a question the database can answer two ways.
--
-- canonical-using:      (organization_id = app_current_organization_id())
-- canonical-with-check: (organization_id = app_current_organization_id())

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON subscriptions
  USING      (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
