# ADR-0004: Transactional outbox instead of 2PC

- **Status:** accepted
- **Date:** 2026-10-22

## Context

After posting an entry, downstream systems (notifications, fraud scoring, statements) need to know about it. The naive implementation publishes to a broker inside the request:

```
BEGIN; insert postings; COMMIT;
publish(event);            // ← if this fails, the event is lost forever
```

The opposite order is worse: publishing before the commit can announce an entry that gets rolled back.

## Decision

Write the event to an `outbox` table **in the same transaction** as the ledger rows. A separate publisher polls unpublished rows and publishes them.

```sql
insert into outbox (id, aggregate_type, aggregate_id, event_type, payload)
values ($1, 'journal_entry', $2, 'ledger.entry.posted', $3);
```

The publisher (not implemented yet) will use:

```sql
select * from outbox
 where published_at is null
 order by created_at
 limit 100
 for update skip locked;
```

## Consequences

- Atomicity for free: the event exists if and only if the entry commits. No 2PC, no distributed transaction.
- Delivery becomes **at-least-once**, so consumers must be idempotent (dedupe on `outbox.id`).
- Adds a table, a partial index and a background process that needs monitoring (lag, retries, dead letters).
- `FOR UPDATE SKIP LOCKED` lets multiple publisher instances run without coordination.
- The outbox grows forever unless it is archived. A retention job is part of the roadmap.
