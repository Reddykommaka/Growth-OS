# ADR-0022 — Files: verify the bytes, not the claim; and what the S3 adapter and scanner still owe

**Status:** Accepted · **Date:** 2026-09-28

## Context

[02-technology-stack.md](../architecture/02-technology-stack.md) §3 puts file bytes in S3-compatible
object storage with "presigned direct upload/download; bytes never proxy through our app servers", and
[05-data-architecture.md](../architecture/05-data-architecture.md) §3 keeps only metadata in `files`.
That is a capacity decision — an app server that streams uploads is an app server that can be exhausted
by them — and it has a consequence that shapes everything else: **the server never sees the upload
happen.**

Everything a normal upload handler does at the moment the bytes arrive therefore has to move. There is
no moment. There is a before, in which the server can only decide what it is willing to permit, and an
after, in which it can ask storage what actually turned up.

[10-security-architecture.md](../architecture/10-security-architecture.md) §3 sets the bar for what must
still hold: presigned direct upload, a "MIME allowlist verified by magic bytes not extension", size
caps, EXIF stripped, an "async malware scan [that] gates `scan_status` before a file is usable", user
content served from a separate origin, and no user-supplied SVG rendered inline.

Two of those require infrastructure that does not exist in this repository: a bucket with credentials,
and a scanning engine. The temptation is to write the adapters anyway against a mocked endpoint and call
the requirement met. That is the thing this ADR exists to refuse.

## Decision

**1. Every check runs twice: once on the claim, once on the object.**

`requestUpload` checks purpose, declared type, declared size and filename, and mints a presigned PUT.
`finalizeUpload` asks storage for the real size, reads the first 64 bytes, and re-runs the size and
allowlist checks against what is actually there. Neither pass is redundant: the first stops an
over-cap upload for the price of one round trip, and the second is the only one that tests a fact.

**2. The allowlist is positive, and it is checked against bytes.**

`sniff` identifies a fixed set of signatures and refuses anything it cannot positively identify. A
declared `Content-Type` is consulted for exactly one purpose — choosing between `text/csv` and
`text/plain`, which are the same bytes — and can never widen what is accepted. Text additionally has to
be **valid UTF-8**: a printable-ASCII check accepts every byte from 0x80 to 0xFF, so a binary blob would
otherwise store as `text/plain`, and banning high bytes outright would refuse every CSV containing a
non-English name. Markup is refused outright, including SVG, because a stored document can be served
somewhere it will be parsed.

**3. The storage key is server-generated, and the schema says so.**

`org/<organizationId>/<yyyy>/<mm>/<uuid>`, with a `CHECK` constraint pinning that shape and a second
check before any key is signed. A client-influenced key — even one merely appended to a prefix — is a
path-traversal primitive and a cross-tenant write, and the presigned URL would make the write
legitimate.

**4. `status` and `scan_status` are separate columns, and the application cannot write the second.**

The first says whether the bytes arrived; the second whether they are safe. A file is usable only when
it is `ready` AND `clean`, and `requestDownload` puts both in its `WHERE` clause. The scan columns are
withheld from `growth_os_app` by a **column-level GRANT**, because RLS cannot express "you may change
these columns and not those" and a session that could set `scan_status = 'clean'` would defeat the whole
control with one statement the policy allows.

**5. A rejection is a return value, not an exception.**

`finalizeUpload` runs inside the caller's transaction and marks the row `rejected`. Throwing would roll
that mark back with everything else, leaving the row `reserved` forever while the caller reported a
failure. The two genuine exceptions — an unknown reservation, a missing object — stay exceptions,
because they have nothing to persist.

**6. Download URLs are attachment-only, at the port level.**

`presignDownload` does not take a disposition. 10 §3 forbids rendering user-supplied content inline, and
a port that offered the choice would make that a per-caller decision — which is the kind of decision that
gets made differently in the fourth caller.

**7. The S3 adapter and the scanner engine are deliberately absent.**

What exists is the protocol, the policy, the sniffer, the gate and an in-memory `StoragePort` that the
worker also uses in local development. What does not exist is the vendor adapter and the engine, and
this ADR records what would complete each.

### Production acceptance condition — the S3 adapter

`packages/integrations/s3` is complete when all of:

- it implements `StoragePort` against a real S3-compatible endpoint, with tests that run against one
  (MinIO in CI is acceptable; a mock is not, because the thing being tested is the signature);
- the presigned PUT signature **covers `Content-Length` and `Content-Type`**, so the declared size and
  type are binding rather than advisory — a client sending different ones must get a signature mismatch
  from storage, not a stored file we then have to reject;
- presigned GET sets `Content-Disposition: attachment` with the stored `original_name`, and the bucket
  is served from the **separate user-content origin** required by 10 §3 and
  [12-devops-architecture.md](../architecture/12-devops-architecture.md) §3;
- the bucket denies public reads, has versioning on, and has a lifecycle rule that expires
  never-finalised objects — the abandoned-reservation case;
- `head` returns a digest, or the adapter computes one, because the ready state requires a checksum and
  a file with no digest cannot be checked for corruption later;
- a test asserts that a key outside the generated shape is refused before signing.

### Production acceptance condition — the scanner

The scan gate is complete when all of:

- a `FileScanner` implementation exists against a real engine, and a test scans the **EICAR test file**
  and asserts an `infected` verdict — a scanner that has never returned `infected` has not been tested;
- an engine error yields `failed`, never `clean`, asserted by a test that makes the engine unreachable;
- the scanner reads bytes from object storage rather than from an upload path, since there is no upload
  path;
- **EXIF is stripped** as part of the same pass — it is the other thing that requires reading the bytes,
  and 10 §3 requires it. A file whose EXIF still carries GPS coordinates is a privacy defect, and
  stripping it needs the image decoded, which means the scanner's pass or another just like it;
- `failed` files have a defined operator path: they are unusable and nothing retries them, deliberately,
  because an automatic retry loop against a broken engine is an unbounded bill;
- the `file-scan-backlog` readiness check is wired into `/readyz`.

**Until both hold, no upload is usable in production.** That is the designed failure mode rather than a
broken one: an unscanned file has no download URL, so "no scanner" degrades to "nothing a customer
uploads can be opened" rather than to "unscanned files are served". The readiness check reports it as a
visible product outage, which is what it would be.

## Alternatives considered

**Trust the declared `Content-Type`.** Rejected: it is supplied by the uploader, so trusting it means the
uploader chooses how their file will later be served, and a payload served as `text/html` from an origin
holding session cookies is stored XSS. It is also the cheaper code, which is why it is worth naming as a
rejected option rather than an unconsidered one.

**Sniff on the client before upload.** Rejected as a security control, though it is a fine UX touch: a
client-side check is advice, and the client is the thing being checked.

**Proxy uploads through the app so the server sees the bytes.** Rejected per 02 §3, and it was the
closest call — it would collapse the three-step protocol into one handler and make sniffing, EXIF
stripping and scanning a single synchronous pass. It fails on capacity: streaming multi-hundred-megabyte
video through the request path makes upload concurrency an app-server scaling problem, and it puts a
long-lived request in front of a connection from the pool.

**Allow SVG and sanitise it.** Rejected. SVG sanitisation is a losing arms race — the attack surface is
the whole of XML plus scripting plus external references — and 10 §3 already forbids rendering
user-supplied SVG inline. Refusing it at the gate is the same outcome with none of the maintenance.

**One `status` column with a `scanning` value.** Rejected: it makes "uploaded but not yet scanned" and
"uploaded and clean" the same kind of thing, and the gate is precisely the distinction between them.
With one column, every query that wanted usable files would have to enumerate states, and the day
someone adds a state is the day one of those queries is wrong.

**Ship a no-op scanner that marks everything clean, to unblock the feature.** Rejected outright. It
would satisfy every test above while removing the control entirely, and it would do so invisibly — the
column would say `clean`, the check would pass, and nothing would ever say that no scanning happened.

## Consequences

**Positive.** A file's type is a fact about its bytes. The scan gate cannot be opened from a request. The
storage key cannot be influenced by a client, and the schema enforces that independently of the code. The
upload protocol is fully tested without a bucket, so the S3 adapter has a narrow, well-specified job.

**Negative.** Three round trips for an upload instead of one, and a client that fails between the second
and third leaves a reservation and an object to reap. Nothing a customer uploads is usable until the
scanner exists — which is correct and is still a missing feature. The sniffer's allowlist is narrow
enough that adding a format is a code change, and a customer wanting one waits for a deploy. Text is
accepted on a UTF-8 check, which is a heuristic: a binary file that happens to be valid UTF-8 with no
control bytes would be stored as `text/plain`, and the mitigation is that the purposes allowing text are
the ones that parse it.

**Mitigation.** Abandoned reservations have their own partial index so the reaper is cheap, and the
bucket lifecycle rule in the acceptance condition handles the orphaned objects. The scan backlog is a
readiness signal, so "the scanner has stopped" is visible rather than discovered by a customer.

**Exit condition / trigger to revisit.** If a product surface needs a format the sniffer cannot identify
from a signature — Office documents being the likely one — revisit decision 2 rather than widening the
text fallback, because the fallback is the weakest part of it. If upload latency from the extra round
trips becomes a measured complaint, the reservation can be folded into the page load that precedes it,
which is a client change and not a protocol one.
