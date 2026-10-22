# ledger-core

A **double-entry ledger core**: money moves exactly once, invariants are enforced by PostgreSQL, and every posted entry emits a domain event in the same transaction.

Built as a portfolio project for senior full-stack roles in fintech. The interesting part is not the CRUD — it is what happens under **concurrency, retries and crashes**.

```
POST /v1/transfers  ──▶  LedgerService.transfer()
                           │
                           ├─ 1. Idempotency-Key lookup (fast path)
                           ├─ 2. BEGIN
                           ├─ 3. SELECT accounts ... ORDER BY id FOR UPDATE   (deadlock-free)
                           ├─ 4. SUM(postings) per account                     (safe under lock)
                           ├─ 5. domain invariants (pure functions)
                           ├─ 6. INSERT journal_entry + postings + outbox
                           └─ 7. COMMIT  ──▶ deferred trigger: Σ postings = 0
```

## Why this is hard

A naive `UPDATE accounts SET balance = balance - 100` implementation fails in at least three ways:

| Failure | What this project does |
| --- | --- |
| Two concurrent transfers read the same balance and both succeed | Row locks taken in a deterministic order; the balance is re-read inside the lock |
| The client retries a timeout and money moves twice | `Idempotency-Key` + a unique constraint; the loser of the race reads the winner's entry |
| The process dies after the debit but before the credit | The debit and the credit are separate rows in **one** transaction, and a deferred trigger refuses to commit an entry that does not sum to zero |
| The event is lost (or published for a rolled-back entry) | Transactional outbox: the event is written in the same transaction as the postings |

## Invariants

| # | Invariant | Enforced by |
| --- | --- | --- |
| 1 | Every journal entry sums to zero | Deferred `CONSTRAINT TRIGGER` (fires at `COMMIT`) |
| 2 | Every entry has at least 2 postings | Same trigger |
| 3 | A posting uses its account's currency | `BEFORE INSERT` trigger |
| 4 | Amounts are non-zero integers | `CHECK` constraint |
| 5 | A request key produces at most one entry | `UNIQUE (idempotency_key)` |
| 6 | No account with `allow_negative = false` is ever debited below zero | Domain rule inside the account row lock |
| 7 | Value is conserved: Σ postings = 0 across the whole ledger | Consequence of #1 |

Invariants 1–5 are enforced **by the database**, so an application bug cannot corrupt the books. #6 needs the lock; #7 is asserted in every integration test.

## API

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/v1/accounts` | `{ ownerId, currency, kind?, allowNegative? }` |
| `GET` | `/v1/accounts/:id` | |
| `GET` | `/v1/accounts/:id/balance` | Returns `balance` (decimal) and `balanceMinor` |
| `POST` | `/v1/transfers` | Requires `Idempotency-Key`; `201` on create, `200` on replay |
| `GET` | `/v1/accounts/:id/entries` | Keyset pagination: `limit`, `cursor` |
| `GET` | `/healthz` | |

Errors follow [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) (`application/problem+json`).

```bash
curl -s localhost:3000/v1/accounts \
  -H 'content-type: application/json' \
  -d '{"ownerId":"4b1f0c1e-2d8a-4f3b-9c1e-7a5d2b8e9f01","currency":"USD","allowNegative":true}'

curl -s localhost:3000/v1/transfers \
  -H 'content-type: application/json' \
  -H 'idempotency-key: 7d1c2f9a-1f7e-4d0b-9d0e-1a2b3c4d5e6f' \
  -d '{"fromAccountId":"...","toAccountId":"...","amount":"250.75","currency":"USD"}'
```

## Design decisions

- [ADR-0001](docs/adr/0001-signed-postings-and-deferred-trigger.md) — signed postings + deferred constraint trigger
- [ADR-0002](docs/adr/0002-integer-minor-units.md) — integer minor units, never floats
- [ADR-0003](docs/adr/0003-idempotency-keys.md) — idempotency at the boundary
- [ADR-0004](docs/adr/0004-transactional-outbox.md) — transactional outbox instead of 2PC
- [ADR-0005](docs/adr/0005-pglite-for-integration-tests.md) — Postgres-in-WASM for integration tests

## Running it

Requirements: Node 22+ and PostgreSQL 16+ (or Docker).

```bash
npm install
docker compose up -d          # or point DATABASE_URL at your own Postgres
cp .env.example .env          # PowerShell: Copy-Item .env.example .env
npm run migrate
npm run dev
```

## Deploy on Neon

[Neon](https://neon.tech) is the recommended hosted Postgres (branch-first, pooled + direct endpoints, scale-to-zero). This repo is wired to use both URLs correctly.

### One-time setup

```bash
npm i -g neonctl
neon login
neon init -y --org-id org-green-mode-64813568 --project-id super-cell-77584292 --branch production --services postgres
neon deploy
neon env pull
```

`neon init` links the project, writes `neon.ts`, installs the Neon agent tooling, and pulls variables into `.env.local` (`DATABASE_URL` pooled, `DATABASE_URL_UNPOOLED`, `NEON_BRANCH`). `neon deploy` applies `neon.ts` (branch policy/services) and re-pulls env.

### Environment

| Variable | Purpose | Notes |
| --- | --- | --- |
| `DATABASE_URL` | App traffic (pooled) | Hostname contains `-pooler`. PgBouncer in transaction mode. |
| `DATABASE_URL_UNPOOLED` | Migrations / admin jobs | Direct endpoint (no pooler). Required for DDL/some session state. |
| `NEON_BRANCH` | Current branch name | Logged at startup for traceability. |
| `PG_POOL_MAX` | App pool size (default `10`) | Pooler multiplexes beyond this. |
| `PORT` | HTTP port (default `3000`) |  |

Scripts load both `.env` and `.env.local` (Node `--env-file-if-exists`, `.env.local` wins). `cp .env.example .env` is still fine for local Postgres.

### Migrate and run

```bash
npm run migrate        # uses DATABASE_URL_UNPOOLED (direct)
npm run build && npm start
# or
npm run dev
```

Migrations are a **release step** (not auto-run on boot). The server fails fast at startup if the schema is missing with a clear message.

### Prove it end-to-end

```bash
# Start the server against Neon (env from .env/.env.local)
$env:PORT='3100'; npm start &
$env:BASE_URL='http://localhost:3100'; npm run smoke

# Verify DB invariants directly (retries the deferred-trigger rejection)
npm run verify:ledger
```

`npm run smoke` hits the real HTTP → Fastify → Postgres path (create accounts, idempotent transfer, replay with `Idempotency-Replayed: true`, balance, cursor pagination, overdraw → `422` `application/problem+json`, 404). `npm run verify:ledger` asserts `SUM(postings)=0`, counts, trigger presence, and **proves the deferred `postings_entry_balanced` trigger rejects an unbalanced entry at `COMMIT`** (then rolls back with no leaked rows).

```bash
npm run typecheck
npm test
npm run build && npm start
```

## Testing

32 tests, three layers:

| Layer | File | Proves |
| --- | --- | --- |
| Unit | `test/money.test.ts`, `test/entry.test.ts` | Parsing/formatting never drifts; domain rejects invalid transfers |
| Property-based | `test/entry.property.test.ts` | Over 300 random transfer sequences: no overdraw, no money created or destroyed, every entry balances |
| Integration | `test/ledger.integration.test.ts`, `test/http.test.ts` | Real SQL, real triggers, replay semantics, the race for the last funds, keyset pagination, HTTP contract |

Integration tests run against **PGlite** (PostgreSQL 17 compiled to WASM): no Docker, no services in CI, and the deferred-constraint semantics are the real thing.

To run the same suite against a real PostgreSQL server:

```bash
# bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/ledger_test npm test
```

```powershell
$env:TEST_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/ledger_test'; npm test
```

This is the run that genuinely exercises row-level locking across concurrent connections.

## Deliberately not done (yet)

Senior work is also about scope discipline. These are known gaps, not oversights:

- **No balance snapshots.** Balances are `SUM(postings)`. Correct and simple; O(history) per read. A snapshot table (periodically materialised, with a rebuild job) is the next step — and a good ADR to write.
- **No outbox publisher.** Events are written transactionally but nothing consumes them yet. Next: a polling publisher with `FOR UPDATE SKIP LOCKED`, at-least-once delivery and an idempotent consumer.
- **No reversal flow.** `journal_entries.status` exists; the compensating-entry command does not.
- **No FX.** Multi-currency exists at the account level; cross-currency transfers are rejected rather than guessed.
- **No auth.** `ownerId` is trusted input. Real deployment needs OIDC, per-owner scoping and rate limiting.
- **No load test in the repo yet.** Planned: k6 scenario at 500 TPS with a p95 target and a zero-discrepancy assertion.

## Roadmap

1. Balance snapshots + rebuild job (with a consistency test)
2. Outbox publisher + idempotent consumer + DLQ
3. Reversal and refund commands
4. k6 load test with published numbers
5. OpenTelemetry traces + Prometheus metrics for the outbox lag
