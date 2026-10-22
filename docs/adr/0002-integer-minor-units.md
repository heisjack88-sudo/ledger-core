# ADR-0002: Money is an integer count of minor units

- **Status:** accepted
- **Date:** 2026-10-22

## Context

`0.1 + 0.2 !== 0.3` in IEEE-754. Every monetary bug that starts with "the totals are off by a cent" starts with a float or a rounded decimal.

Options considered:

1. `number` (float) — rejected outright.
2. Decimal library (`decimal.js`, `big.js`) — correct, but adds a runtime dependency and still requires a storage decision.
3. `bigint` of minor units + a currency code — the model most payment systems converge on.
4. PostgreSQL `numeric` mapped to `string` — correct, but pushes arithmetic into SQL strings.

## Decision

`Money = { minor: bigint, currency: string }`, where `minor` counts the currency's smallest unit (cents for USD). Storage is `BIGINT`.

Parsing from user input goes through a **string** parser (`parseMinor`) that rejects excess precision instead of rounding silently. There is no `parseFloat` anywhere in the codebase.

## Consequences

- Exact arithmetic by construction; property tests can assert conservation.
- `bigint` does not survive `JSON.stringify`. API responses therefore expose `amountMinor` as a **string** and a formatted `amount` for humans.
- The database returns `int8` as a string through `pg`; a single `toBigInt` helper normalises it.
- Currency exponents other than 2 (JPY = 0, KWD = 3) are supported in the money module but not yet propagated end-to-end. This is a known gap: `parseMinor` takes an `exponent`, the HTTP layer always uses 2.
- `bigint` cannot be sent as a query parameter by `pg`, so amounts are bound as strings and cast by the column type.
