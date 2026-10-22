import { describe, expect, it } from 'vitest';
import { assertBalanced, buildTransfer } from '../src/domain/entry.js';
import { DomainError } from '../src/domain/errors.js';
import { money } from '../src/domain/money.js';

const base = {
  id: 'entry-1',
  idempotencyKey: 'key-1',
  amount: money(10_000n, 'USD'),
  source: { id: 'acc-source', currency: 'USD', allowNegative: false, balanceMinor: 50_000n },
  destination: { id: 'acc-dest', currency: 'USD' },
};

describe('buildTransfer', () => {
  it('produces a balanced pair of postings', () => {
    const draft = buildTransfer(base);

    expect(draft.postings).toHaveLength(2);
    expect(draft.postings[0]?.amount.minor).toBe(-10_000n);
    expect(draft.postings[1]?.amount.minor).toBe(10_000n);
    expect(draft.postings.reduce((sum, p) => sum + p.amount.minor, 0n)).toBe(0n);
  });

  it('rejects a transfer that would overdraw a non-negative account', () => {
    expect(() =>
      buildTransfer({
        ...base,
        amount: money(50_001n, 'USD'),
        source: { ...base.source, balanceMinor: 50_000n },
      }),
    ).toThrowError(DomainError);
  });

  it('allows overdraw when the account explicitly permits it', () => {
    const draft = buildTransfer({
      ...base,
      amount: money(90_000n, 'USD'),
      source: { ...base.source, allowNegative: true },
    });
    expect(draft.postings[0]?.amount.minor).toBe(-90_000n);
  });

  it('rejects zero and negative amounts', () => {
    expect(() => buildTransfer({ ...base, amount: money(0n, 'USD') })).toThrowError(DomainError);
    expect(() => buildTransfer({ ...base, amount: money(-1n, 'USD') })).toThrowError(DomainError);
  });

  it('rejects same-account transfers', () => {
    expect(() =>
      buildTransfer({ ...base, destination: { id: 'acc-source', currency: 'USD' } }),
    ).toThrowError(/must differ/);
  });

  it('rejects currency mismatches', () => {
    expect(() =>
      buildTransfer({ ...base, destination: { id: 'acc-dest', currency: 'EUR' } }),
    ).toThrowError(/currency/i);
  });
});

describe('assertBalanced', () => {
  it('rejects single-posting entries', () => {
    expect(() => assertBalanced([{ accountId: 'a', amount: money(1n, 'USD') }])).toThrowError(
      /at least two/,
    );
  });

  it('rejects entries that do not sum to zero', () => {
    expect(() =>
      assertBalanced([
        { accountId: 'a', amount: money(1n, 'USD') },
        { accountId: 'b', amount: money(-2n, 'USD') },
      ]),
    ).toThrowError(/does not balance/);
  });

  it('rejects entries mixing currencies', () => {
    expect(() =>
      assertBalanced([
        { accountId: 'a', amount: money(1n, 'USD') },
        { accountId: 'b', amount: money(-1n, 'EUR') },
      ]),
    ).toThrowError(/Cannot combine/);
  });
});
