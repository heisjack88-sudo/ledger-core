# ADR-0003: Idempotency keys at the boundary

- **Status:** accepted
- **Date:** 2026-10-22

## Context

Clients retry. Networks time out after the server has already committed. Without idempotency, a retried `POST /v1/transfers` moves money twice — the single most expensive bug a payments system can have.

Options:

1. Client-generated request ID stored in Redis with a TTL — fast, but the source of truth becomes a cache that can be evicted.
2. **Unique constraint in the ledger database** — the source of truth for "this already happened" lives next to the money.
3. Database advisory locks per key — works, but adds lock-management complexity for no extra guarantee.

## Decision

Require an `Idempotency-Key` header. Persist it as `journal_entries.idempotency_key` with a **unique constraint**.

Flow:

1. Fast path: look up the key. If it exists, return the stored entry with `replayed: true` (HTTP `200` instead of `201`).
2. Otherwise run the transaction. If two requests race, one commits and the other hits `23505`.
3. The loser rolls back and re-reads the winner's entry. Same response, no second posting.

## Consequences

- Idempotency is durable and transactional. No TTL, no cache invalidation, no "the retry worked after the cache expired" window.
- Keys are global. A real multi-tenant deployment would scope them per owner/API key (`UNIQUE (owner_id, idempotency_key)`).
- There is no payload fingerprint. Reusing a key with a *different* body returns the original entry instead of a `422`. That is a deliberate simplification; the next iteration should store a request hash and reject mismatches.
- The unique index also makes the fast path a single index lookup.
