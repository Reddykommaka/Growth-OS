# ADR-0019 — The audit row is written in the transaction, not through the outbox

**Status:** Accepted · **Date:** 2026-09-17 · **Approved:** 2026-09-17

## Context

ADR-0007 establishes the transactional outbox as how a domain write reliably produces side
effects: write the event to `outbox_events` inside the transaction, let a relay publish it.
Its stated motivation names audit among those effects.

Implementing `platform/audit` forced the question to be answered precisely, because the two
mechanisms give different guarantees and only one of them is what an audit log needs.

The outbox exists to solve the **dual-write problem**: the effect lives in ANOTHER system
(Redis, an email provider), so the database transaction cannot cover it. Publishing before
commit announces changes that never happened; publishing after commit loses them on a crash.
The outbox makes the intent durable inside the transaction and delivers it afterwards, at
least once.

The audit row has no other system. It is a row in the same PostgreSQL database as the change
it describes.

## Decision

`audit_events` rows are written **directly in the transaction that performs the change**,
through a recorder bound to that transaction's client. Audit does not go through the outbox.

Domain *events about* audited actions still go through the outbox when another system needs
them. What does not is the audit record itself.

Concretely: the recorder is handed the same `PoolClient` the business mutation is running on.
There is no queue, no fire-and-forget, and no `.catch()` on the audit write. A failed audit
write fails the action.

## Alternatives considered

- **Route audit through the outbox, for consistency with every other effect.** Rejected, and
  it is the closest alternative — consistency of mechanism is worth something. It fails on
  the substance: the outbox delivers *after* commit, so there would be a window in which the
  change is visible and unrecorded, and the relay is at-least-once, so the chain would have
  to tolerate duplicates. A hash chain cannot: two deliveries of one event either fork the
  chain or require a dedupe key that makes the sequence non-deterministic. The outbox would
  be reconstructing, asynchronously and less reliably, a guarantee the transaction already
  gives synchronously.

- **Write the audit row asynchronously and best-effort**, so the audit system can never fail
  a user's action. Rejected: it converts "this action was refused" into "no record exists",
  which is indistinguishable from the action not happening. The whole value of the log is
  that its silence is meaningful.

- **A database trigger writing audit rows from row changes.** Rejected: triggers see row
  diffs, not intent. `UPDATE organization_members SET role_id = …` cannot tell an invitation
  acceptance from an administrator's promotion from a support engineer's impersonated
  change, and intent is the thing an investigation needs. It would also put the hash chain
  inside a trigger, where a failure aborts the transaction with no useful message.

- **Scan `audit_events` for the previous hash** instead of keeping a chain-head table.
  Rejected: an `ORDER BY` across every monthly partition on the write path, and it still
  races — two writers read the same tip and fork the chain. A single narrow row per
  organization taken with `SELECT … FOR UPDATE` gives the tip and the serialization in one
  step.

## Consequences

**Positive:** a committed change always has a committed audit record, and a rolled-back one
has neither — no window, no duplicates, no relay lag to monitor. The chain is gapless by
construction because the sequence is claimed under the same lock. Verification needs no
knowledge of delivery semantics.

**Negative:** the audit write is on the critical path of every audited action, and it takes a
row lock. Two consequences follow, and both are real:

1. **Writers within one organization serialize on the audit head** for the remainder of the
   enclosing transaction. That is inherent to a per-organization chain — a total order cannot
   be produced without one — but it means a long business transaction holds the lock for its
   whole duration.
2. **An audit failure fails the action.** That is the intended trade, but it makes the audit
   table a dependency of every mutation.

**Mitigation:** contention is bounded to one organization; writers in different tenants never
touch the same row, so the chain is not a global bottleneck. The lock should be taken as LATE
as possible — record the audit event at the end of the transaction, not the start — which
keeps the held interval short. The head is a single narrow row with no indexes to maintain.

**Exit condition / trigger to revisit:** if a single organization's audited write rate
approaches the point where head contention dominates its transaction time, the chain can be
sharded (a chain per organization per month, verified per shard and linked at the boundary)
without changing the event model or the verification algorithm. Revisit also if audit is ever
required to reach an external SIEM synchronously — that IS a dual-write, and the outbox is
the right mechanism for that leg, alongside (not instead of) the row.
