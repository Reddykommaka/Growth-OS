# 10 — Security Architecture

## 1. Threat model

Assets, ranked by what an attacker would actually want:

1. **Provider credentials** — OAuth tokens for a customer's social and ad accounts. A leak
   here means an attacker posts as our customer and spends their ad budget. This is the
   highest-value asset in the system and is treated as such.
2. **Cross-tenant data** — one organization reading another's contacts, content or revenue.
   In the agency model this is sharper: a leak between two workspaces is a leak between two
   of our customer's *clients*, breaching their commercial confidence as well as ours.
   The `client_guest` role additionally places a person from outside the tenant
   organization inside the product.
3. **Money** — marketplace orders, commissions, payouts.
4. **PII** — CRM contacts, identity graph keys, form submissions.
5. **Availability** — publishing at a scheduled time is a customer commitment.

Principal adversaries: an authenticated tenant probing for cross-tenant access; a
compromised user account; a malicious marketplace seller (uploading content, and a *paid*
adversary with a legitimate account); an attacker who obtains a database dump; a malicious
provider webhook sender; an automated scanner.

## 2. Controls by layer

| Layer | Controls |
| --- | --- |
| **Network / edge** | TLS 1.3 only, HSTS with preload, WAF, DDoS protection, per-IP rate limits at the edge before application cost is incurred |
| **HTTP** | Strict CSP with per-request nonces (no `unsafe-inline`, no `unsafe-eval`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` denying camera/mic/geo by default, `X-Frame-Options: DENY` (dashboard), COOP/CORP |
| **Session** | `__Host-` prefixed, `HttpOnly`, `Secure`, `SameSite=Lax`; opaque hashed tokens; immediate revocation ([06](06-identity-and-access.md)) |
| **CSRF** | `SameSite=Lax` + `Origin`/`Sec-Fetch-Site` validation on every state-changing request. Cookie-authenticated non-GET requests additionally carry a double-submit token. The public REST API uses bearer API keys and is exempt (it is not cookie-authenticated) |
| **Authorization** | `authz.assert` in every application service + Postgres RLS + per-role GRANTs ([06](06-identity-and-access.md)) |
| **Input** | Zod at every boundary — HTTP body/query/params, queue payloads, webhook bodies, environment. Branded id types prevent passing a `UserId` where an `OrganizationId` is required |
| **Injection** | Parameterised queries only; raw SQL requires `sql` template interpolation (never string concatenation) and is lint-flagged for review |
| **XSS** | React escaping by default; `dangerouslySetInnerHTML` is lint-banned outside one sanitising component that runs DOMPurify with a strict allowlist. Marketplace listing bodies and landing-page content are sanitised **server-side on write** as well as on render |
| **Rate limiting** | Layered: per-IP (edge), per-session, per-organization, per-API-key, per-expensive-endpoint. Auth endpoints get strict limits plus progressive delay and lockout |
| **Secrets** | Never in the repository (it is public); Zod-validated env at boot with fail-fast; runtime values from the platform secret manager; committed `.env.example` contains names only |
| **Encryption** | TLS in transit; disk encryption at rest; **envelope encryption** (AES-256-GCM DEK wrapped by a KMS key) for provider credentials, MFA secrets and identity keys, with `key_version` for rotation |
| **Files** | Presigned direct-to-storage upload; MIME allowlist verified by magic bytes not extension; size caps; EXIF stripped; async malware scan gates `scan_status` before a file is usable; **user content served from a separate origin** so a stored payload cannot reach app cookies; no user-supplied SVG rendered inline |
| **SSRF** | Any user-supplied URL we fetch (landing-page import, webhook targets, link preview) goes through one fetch wrapper: scheme allowlist, DNS resolution then IP checks against private/link-local/metadata ranges, redirect limit with re-validation at each hop, timeout and response size cap |
| **Webhooks (in)** | Raw-body HMAC verification in constant time, timestamp window, replay protection by unique provider event id ([07](07-integration-architecture.md) §5) |
| **Webhooks (out)** | We sign our outbound webhooks (HMAC + timestamp), publish the verification recipe, and support secret rotation with overlapping keys |
| **Audit** | Append-only, hash-chained `audit_events` written in the same transaction as the change; the app role has no `UPDATE`/`DELETE` grant on it |
| **Least privilege** | `growth_os_app` is `NOBYPASSRLS` with per-table grants; `growth_os_migrator` is used only by the migration job; object-storage credentials are scoped per bucket and prefix; provider OAuth requests the minimum scopes each capability needs |

## 3. Secrets and the public repository

The repository is public from the first commit, so this is a live control, not a policy
statement:

- `gitleaks` runs as a **pre-commit hook and a CI gate**; a push containing a credential
  pattern fails.
- GitHub secret scanning with push protection enabled.
- Our own API key format (`gos_live_<prefix>_…`) is registered so it is detectable.
- No environment file other than `.env.example` (names only) is ever committed;
  `.gitignore` is written before any application code.
- Runtime secrets live in the deployment platform's secret manager, injected as environment
  variables, rotated on a schedule, and never logged. Rotation runbooks are in
  `docs/runbooks/`.

## 4. AI-specific risks

Model features introduce a threat surface the rest of the system does not have, and it is
addressed in the intelligence layer rather than per feature
([16](16-intelligence-architecture.md) §7, [ADR-0016](../adr/0016-ai-governance.md)).

| Risk | Control |
| --- | --- |
| **Prompt injection via ingested content** — inbound social messages, comments, competitor pages and marketplace listings are untrusted by design | Untrusted text is delimited and never granted instruction authority; tool use is disabled for capabilities that read it; no capability reading untrusted input may write to the domain |
| **Cross-tenant leakage through retrieval** | Vector and keyword retrieval is filtered by workspace **before** ranking, never after. Embeddings live in the same RLS-protected database as their source, so the tenant filter is an ordinary predicate on an already-isolated table rather than a second system's access model to get right |
| **PII sent to a third-party model provider** | Redaction before any provider call where the capability does not require the field; per-tenant model allowlist and residency honoured by the router; zero-retention endpoints where available; no cross-tenant training, ever |
| **Unattended AI writes** | Intelligence emits proposals. Auto-apply is opt-in per automation node, gated by its own permission, and audited with the invocation id |
| **Cost as a denial-of-wallet vector** | Pre-invocation budget checks with hard stops; per-capability cost classes; anomalous-spend circuit breaker; automation recursion guards |
| **Model output as an injection vector into our own UI** | Generated content is escaped and sanitised on the same path as any user content; structured outputs are schema-validated before use |
| **Provider credential leak** | Model provider keys are held in the secret manager under the same regime as every other credential, and are registered with the repository secret scanner |

## 5. Marketplace-specific risks

The marketplace admits *paid* adversaries with legitimate accounts, which is a materially
different threat profile from the rest of the product:

| Risk | Control |
| --- | --- |
| Malicious listing content (stored XSS, phishing) | Server-side sanitisation on write, separate serving origin, moderation queue before first publish |
| Malicious uploaded files sold as digital products | Scan before availability; downloads served via short-lived presigned URLs from the isolated origin; never executed or rendered by us |
| Fake reviews | A review requires a completed order (`reviews.order_id UNIQUE`); velocity and graph anomaly detection; moderation |
| Seller fraud / money laundering | Stripe Connect KYC; payout holds for new sellers; dispute workflow; double-entry ledger makes reconciliation exact |
| Price/commission tampering | Prices and commission rates are resolved **server-side** from the listing at order time and snapshotted onto the order; the client never supplies an amount |
| Refund abuse | State machine with allowed transitions; refunds post reversing ledger entries; rate limits per buyer |
| Marketplace enumeration / scraping | Rate limits, pagination caps, no sequential ids, bot detection on discovery endpoints |

## 6. Application-security lifecycle

| Stage | Control |
| --- | --- |
| Design | Threat-model note required in the PR for any feature touching authn/authz, money, files or PII |
| Code | Typed boundaries, `any` banned, lint rules for the dangerous APIs listed above |
| Review | A second reviewer is required for changes to `packages/platform/{authn,authz}`, `db/policies/`, anything under `marketplace/money`, and any prompt or capability that reads untrusted input |
| CI | SAST (CodeQL), dependency audit (`pnpm audit` + OSV), secret scan, licence check, container image scan |
| Test | Authorization matrix, cross-tenant probes, CSRF/SSRF/upload regression tests ([11](11-testing-architecture.md)) |
| Runtime | Anomaly alerts on authorization-denial spikes, impossible-travel logins, credential-decrypt failures, invalid-webhook-signature rates |
| Response | Documented incident runbook: contain (revoke sessions/keys/tokens), assess via audit chain, notify within regulatory windows, post-mortem |
| Assurance | External penetration test before general availability; annual thereafter; a security disclosure policy (`SECURITY.md`) from day one |

## 7. Privacy and compliance readiness

- **Data classification** and retention are defined per table ([05](05-data-architecture.md) §10).
- **Subject rights**: export and erasure are implemented as auditable workflows; erasure
  pseudonymises so aggregate analytics remain correct.
- **Data residency**: `organizations.data_region` exists from the first migration. It is not
  used in Phase 1, but it means EU residency is a routing change rather than a re-platform.
- **Sub-processors** are documented; DPAs tracked; a change requires a review.
- **Consent**: tracking behaviour (link clicks, page views) respects a per-workspace consent
  configuration, and identity keys can be collected in a hashed-only mode.

## 8. What is deliberately deferred (and why that is safe)

| Deferred | Until | Why it is safe to defer |
| --- | --- | --- |
| SAML SSO / SCIM | Phase 7 | Port and org policy field exist now; no data migration later |
| Field-level encryption for all CRM PII | Post-GA | Disk + envelope encryption for the highest-value fields covers the realistic threat now; the column pattern is established |
| Formal SOC 2 audit | Post-GA | Controls (audit log, least privilege, change management, access review) are built in from the start, so the audit is evidence-gathering rather than remediation |
| Bug bounty | Post-GA | `SECURITY.md` and a disclosure address exist from day one |
