# Security policy

Growth OS is a multi-tenant platform holding customer business data, connected social and
advertising accounts, CRM records and payment information. We take reports seriously and
respond quickly.

## Reporting a vulnerability

**Please do not open a public issue.**

Report privately through [GitHub's private vulnerability
reporting](https://github.com/Reddykommaka/Growth-OS/security/advisories/new), or email
**security@growth-os.dev**.

Include: what you found, how to reproduce it, what an attacker could achieve, and any
proof-of-concept. If you cannot share a full write-up, send what you have — a partial report
is more useful than none.

| | Target |
| --- | --- |
| Acknowledgement | 2 business days |
| Initial assessment | 5 business days |
| Fix or mitigation for a critical issue | 7 days |
| Public advisory | Coordinated with you, normally within 90 days |

We will keep you updated, credit you in the advisory unless you prefer otherwise, and tell
you when the fix ships.

## Scope

**In scope** — anything that breaks one of the controls the architecture actually promises:

- **Cross-tenant access.** Reading, writing or inferring another organization's or
  workspace's data. This is our highest-severity class: the platform is agency-first, so a
  leak between two workspaces is a leak between two of a customer's *clients*.
- Authentication or session handling: fixation, forced re-use, privilege escalation,
  bypassing MFA or an organization's SSO policy.
- Authorization: performing an action without the required permission, or escaping the
  `client_guest` role's confinement.
- Exposure of provider credentials (OAuth tokens for customers' social and ad accounts) —
  the highest-value asset in the system.
- Injection, SSRF, stored XSS, insecure deserialisation, path traversal.
- Marketplace money: price or commission tampering, unauthorised payouts, ledger corruption.
- Webhook signature bypass or replay.
- Secrets exposed in the repository, in build artefacts or in logs.

**Out of scope**

- Findings from an automated scanner with no demonstrated impact.
- Missing headers or cookie flags on endpoints that carry no session or sensitive data.
- Denial of service through volumetric traffic; rate limiting is a product concern, not a
  vulnerability report.
- Social engineering, physical attacks, or anything requiring a compromised device.
- Vulnerabilities in third-party services we consume — report those upstream, and tell us so
  we can mitigate.
- Self-XSS, clickjacking on pages with no state-changing action, or best-practice advice
  without an exploit.

## Safe harbour

We will not pursue legal action for good-faith research that follows this policy: no
accessing, modifying or destroying data belonging to anyone but yourself, no degrading the
service for others, no social engineering of staff or customers, and no disclosure before we
have had a reasonable chance to fix the issue. Use test accounts you control. If you
accidentally reach data that is not yours, stop, and tell us what you saw.

## How we build

Security controls are structural rather than procedural — see
[10-security-architecture.md](docs/architecture/10-security-architecture.md). In particular:

- Tenant isolation is enforced by PostgreSQL Row-Level Security *and* application
  authorization. CI fails if any tenant-scoped table lacks an enabled, forced policy, and
  cross-tenant probe tests run against a real database on every commit.
- The application database role is `NOBYPASSRLS`, asserted in CI.
- Secrets are blocked at pre-commit and in CI; the repository is public and treated as such.
- Every dependency change runs an audit, a licence check and CodeQL.

If you find a way around any of that, we want to hear about it.
