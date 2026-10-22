# ADR-0005: PGlite for integration tests

- **Status:** accepted
- **Date:** 2026-10-22

## Context

The most valuable tests in this project exercise SQL that an in-memory fake cannot reproduce: deferred constraint triggers, `BEFORE INSERT` triggers, `FOR UPDATE` ordering, keyset pagination with row comparison.

Options:

1. Mock the repository — rejected. It tests the mock.
2. Testcontainers + Docker — the usual answer, but requires Docker, adds ~10s per suite, and complicates CI.
3. A real Postgres in CI only — local feedback disappears.
4. **PGlite** (PostgreSQL 17 compiled to WASM) — real Postgres semantics, in-process, no services.

## Decision

Run integration tests against PGlite by default, and allow the identical suite to run against a real Postgres via `TEST_DATABASE_URL`.

Because PGlite has a single connection:

- Top-level operations are serialized through a shared mutex.
- A transaction receives a separate non-queuing adapter, so a concurrent transaction cannot execute its `BEGIN` inside another transaction's scope.
- Nested transactions are rejected explicitly.

## Consequences

- `npm test` works on a fresh machine with no Docker, in ~17s, and the deferred-constraint semantics under test are the real ones.
- **The concurrency test is weaker under PGlite**: it proves the logic (exactly the affordable transfers succeed) but not true row-lock behaviour. `TEST_DATABASE_URL` is the run that validates `FOR UPDATE` under real parallelism, and it should be part of CI.
- PGlite is a test dependency only. Production uses `pg` against a real server through the same `Db` port.
- Two adapters (`PgDb`, `PgliteDb`) mean the port has to stay small. That constraint is healthy: no ORM-specific API leaks into the ledger service.
