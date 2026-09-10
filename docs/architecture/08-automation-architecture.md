# 08 — Automation, Events & Background Work

## 1. The three layers

| Layer | What it is | Backed by |
| --- | --- | --- |
| **Event spine** | Domain events emitted transactionally by every module | Postgres `outbox_events` → relay → queue |
| **Job runtime** | Reliable execution of discrete units of work | BullMQ on Redis |
| **Automation engine** | User-authored workflows: triggers, conditions, actions, delays, branches | Postgres state machine advanced by workers |

They are layered, not alternatives: automations are triggered by events and execute their
steps as jobs.

## 2. The transactional outbox

A domain write and its side effects must not be able to disagree. Writing to Postgres and
publishing to Redis are two systems, so a crash between them either loses the event (if
published after commit) or announces a change that never happened (if published before).

The outbox removes the choice:

```sql
BEGIN;
  SET LOCAL app.organization_id = '…';
  INSERT INTO scheduled_posts …;
  INSERT INTO outbox_events (event_name, event_version, payload, organization_id) …;
  INSERT INTO audit_events  (…) ;
COMMIT;                       -- one atomic fact
```

A **relay** in `apps/worker` then polls unpublished rows (`FOR UPDATE SKIP LOCKED`, batched,
ordered by `occurred_at`), publishes to the queue, and marks them published.

- Delivery is **at-least-once**. Every consumer is therefore idempotent, keyed on the event
  id. This is a far better trade than the false comfort of exactly-once.
- Per-organization ordering is preserved by relaying in `occurred_at` order within an org
  and using per-org concurrency; global ordering is explicitly not guaranteed and no
  consumer may depend on it.
- If Redis is down, events accumulate in Postgres and drain when it returns. **Nothing is
  lost**, which is the whole point.
- `outbox_events` is monitored on lag (`now() - min(occurred_at) WHERE published_at IS NULL`);
  a growing lag is a paging alert.

## 3. Job runtime

Queues are separated by latency class so a slow bulk job cannot starve a time-critical one:

| Queue | Contents | Concurrency profile |
| --- | --- | --- |
| `critical` | Publishing at a scheduled time, payment webhooks | High, low latency |
| `default` | Automation steps, notifications, email sends | Medium |
| `ingestion` | Provider metric pulls, backfills, inbox sync | Bounded, rate-limit aware |
| `analytics` | Touchpoint processing, rollups, attribution recomputation | Batched, off-peak weighted |
| `maintenance` | Partition management, retention, reconciliation, key rotation | Low priority, scheduled |

**Every job contract:**

1. **Idempotent** — a stable `idempotencyKey`; the handler is safe to run twice. Enforced by
   `job_executions` and a Redis dedupe set.
2. **Tenant-scoped** — the payload carries `organizationId`; the handler opens tenant
   context exactly as an HTTP request does. Jobs get no ambient privilege.
3. **Bounded** — an explicit timeout and a maximum attempt count.
4. **Observable** — a span, structured logs with `job_id`/`organization_id`, and a
   `job_executions` row recording outcome and duration.
5. **Typed** — payloads are Zod-parsed on both enqueue and dequeue.

**Retry policy:** exponential backoff with full jitter (jitter matters — synchronised
retries after an outage produce a thundering herd that extends the outage). Retryable
classes only. Exhausted jobs move to a dead-letter queue with full context, and DLQ depth
is alerted on, inspectable in an admin UI, and replayable.

**Poison-message protection:** a job that fails on the same payload beyond a threshold is
quarantined rather than retried forever.

**Scheduled work** uses BullMQ repeatable jobs for system schedules, and a **claim-based
poll** for user-scheduled work: publishing selects due rows
(`WHERE status='pending' AND scheduled_at_utc <= now() FOR UPDATE SKIP LOCKED LIMIT n`),
atomically transitions them to `claimed`, and enqueues. `SKIP LOCKED` is what makes this
safe across many worker replicas without a distributed lock.

## 4. The automation engine

### Why workflows are data, not code

End users author automations in a visual builder. Their workflows must be versioned,
paused, resumed, audited and safely edited while runs are in flight. That is a data
problem. Temporal's workflow-as-code model — excellent for engineer-authored workflows —
does not fit user-authored ones, and operating a Temporal cluster is a substantial
commitment to take on in Phase 2. We build a data-driven engine, behind an interface that
allows Temporal to back the hardest durability cases later.
[ADR-0005](../adr/0005-automation-engine.md).

### Model

| Table | Purpose |
| --- | --- |
| `automation_definitions` | The automation's identity, owner, status |
| `automation_versions` | **Immutable** graph (`jsonb`), validated against a node-type schema. Editing publishes a new version |
| `automation_triggers` | Event / schedule / webhook / manual bindings with filter predicates |
| `automation_runs` | One execution: version, trigger context, status, timestamps |
| `automation_run_steps` | Per-node record: input, output, status, attempts, error, timing |
| `automation_waits` | Scheduled resumptions (`run_after`), the mechanism behind delays |

A run is a **state machine advanced by workers**, never a long-lived in-memory process.
Each transition is a database write, so a worker can die at any point and another resumes
from the last committed step. There is no "in-flight state" that a restart can lose.

**Node types:** trigger, condition (branch), action, delay (relative or until an absolute
time in the workspace timezone), parallel/join, loop over a bounded collection, wait-for-event
(with timeout), sub-automation call.

### Correctness rules

- **In-flight runs keep their version.** Editing an automation never mutates a running
  execution — otherwise a customer's edit silently rewrites work already in progress.
- **Every step is idempotent**, keyed on `(run_id, node_id, attempt_group)`. A step that
  sends an email records the send *before* the call and reconciles on retry.
- **Loop and fan-out bounds** are enforced by the engine, with per-plan limits.
- **Recursion guard:** an automation that triggers an event which re-triggers itself is
  detected by a run-depth counter and a per-entity cooldown, and stopped with a clear error.
  Unbounded automation loops are the most expensive failure mode in this product category —
  they burn provider quota, send duplicate customer emails, and are visible to the customer's
  customers.
- **Rate limits and entitlements** are checked per step execution, not once at trigger time.
- **Failure policy per node**: retry (with policy), continue, or halt the run.
- **Timeouts**: a step timeout and a whole-run timeout; `timed_out` is a distinct terminal
  state from `failed` because they need different operator responses.

### Observability and auditability

Every run is fully inspectable in the UI: the graph with each node's status, its input and
output payloads (PII-redacted by field policy), timing, attempts and errors, plus a
"why did this run?" panel showing the triggering event. Runs can be cancelled, retried from
a failed step, and replayed against a new version. An operator answering "why did this
customer get two emails?" must be able to answer it from the UI in under a minute — that is
the design target.

## 5. Failure modes

| Failure | Behaviour |
| --- | --- |
| Redis unavailable | Outbox accumulates in Postgres; publishing pauses; nothing lost; drains on recovery |
| Worker crashes mid-step | Step is not marked complete; lock expires; another worker retries the idempotent step |
| Relay falls behind | Lag metric alerts; relay scales horizontally (`SKIP LOCKED` makes it safe) |
| Provider rate-limits an action step | Step defers to the bucket's reset time; the run enters `waiting`, not `failed` |
| Automation loops | Depth counter + cooldown halts the run and notifies the workspace |
| Poison job | Quarantined after threshold; DLQ alert |
| Duplicate event delivery | Consumers dedupe on event id |
| Clock skew across workers | All scheduling decisions use database `now()`, never worker wall-clock |
| Queue backlog spike | Per-queue depth and oldest-job-age alerts; workers scale on queue depth, not CPU |
