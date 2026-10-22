# ADR-0001: Signed postings and a deferred constraint trigger

- **Status:** accepted
- **Date:** 2026-10-22

## Context

A ledger entry (a "journal entry") must move value between accounts without creating or destroying it. Two common models:

1. Each posting has a `direction` (`debit` / `credit`) and a positive `amount`.
2. Each posting has a **signed** `amount`: positive = debit, negative = credit.

The invariant "debits equal credits" has to hold no matter what the application does — including bugs, partial writes, and manual SQL.

## Decision

Use **signed amounts**, with `sum(amount_minor) = 0` as the invariant.

Enforce it with a `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED` that fires at `COMMIT`. A deferred check is essential: during a transaction the entry is temporarily unbalanced, and an immediate per-row trigger would reject every valid insert.

Reject entries with fewer than two postings in the same trigger.

## Consequences

- The invariant is one comparison, not a `direction` + `amount` pair that can be inconsistent.
- A crash between the two inserts cannot commit a half-entry: the trigger runs at commit, and the transaction is atomic anyway.
- The application still validates the same rule in pure functions (`assertBalanced`) so it can fail fast with a domain error instead of a database error. Duplication is intentional: the domain gives good errors, the database gives guarantees.
- Signed amounts require discipline in reporting: account-level signs depend on account kind (`asset` vs `liability`). Presentation logic must not assume "positive = money in".
- Cost: one aggregate query per touched entry at commit. Acceptable at this scale; a high-throughput ledger would batch postings per entry into a single insert (already done) and could move to a single statement-level check.
