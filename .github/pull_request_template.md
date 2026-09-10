## What and why

<!-- The diff says what changed. Explain why, and what a reviewer should look at hardest. -->

## Architecture questions

<!-- These four catch the expensive mistakes. Answer them honestly; "N/A" is fine when it
     genuinely is, but say why. -->

**Which module owns this?**
<!-- Exactly one. If it feels like two, you probably need a domain event, not a shared
     table (04-domain-architecture.md §3). -->

**Which permission gates it?**
<!-- Every state change asserts one. "None" is an answer only for a genuinely public
     surface (06-identity-and-access.md §3). -->

**What happens when it fails?**
<!-- Retryable? Idempotent? What does the operator see? Add it to the subsystem's failure
     table if it introduces a new mode. -->

**Threat-model note required?**
<!-- Required for authn/authz, money, file handling and PII. If yes, write it here. -->

## Checks

- [ ] Tests added at the right level; a bug fix has a regression test that fails without it
- [ ] `pnpm run lint` and `pnpm run typecheck` pass locally
- [ ] Migration is expand/contract and safe against the **previous** app version, and
      `generate-schema-version.mjs` was re-run
- [ ] New tenant-scoped table has RLS enabled **and** forced, with an explicit `WITH CHECK`
- [ ] New UI passes `axe` and keyboard tests in both themes
- [ ] Docs or ADR updated if this changes an architectural decision
- [ ] Second reviewer requested if this touches authn/authz, `db/policies/`, marketplace
      money, or a prompt that reads untrusted input

## Rollout

<!-- Anything to do before, during or after merge: a migration to run, a flag to enable, a
     provider app-review to start, an alert to watch. -->
