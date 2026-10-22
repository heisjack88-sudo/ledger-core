import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildTransfer, type EntryDraft } from '../src/domain/entry.js';
import { DomainError } from '../src/domain/errors.js';
import { money } from '../src/domain/money.js';

describe('transfer invariants (property based)', () => {
  /**
   * Whatever sequence of transfers we throw at the domain layer:
   *   - no account with allowNegative=false ever ends up negative
   *   - value is conserved (source + destination === initial)
   *   - every produced entry sums to zero
   * fast-check shrinks any counterexample to the smallest failing sequence.
   */
  it('never overdraws and never loses money', () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 1n, max: 250_000n }), { minLength: 1, maxLength: 40 }),
        (amounts) => {
          const initial = 1_000_000n;
          const balances = new Map<string, bigint>([
            ['source', initial],
            ['destination', 0n],
          ]);

          for (const [index, amountMinor] of amounts.entries()) {
            let draft: EntryDraft | null = null;

            try {
              draft = buildTransfer({
                id: `entry-${index}`,
                idempotencyKey: `key-${index}`,
                amount: money(amountMinor, 'USD'),
                source: {
                  id: 'source',
                  currency: 'USD',
                  allowNegative: false,
                  balanceMinor: balances.get('source') ?? 0n,
                },
                destination: { id: 'destination', currency: 'USD' },
              });
            } catch (error) {
              expect(error).toBeInstanceOf(DomainError);
            }

            if (draft === null) continue;

            const sum = draft.postings.reduce((total, posting) => total + posting.amount.minor, 0n);
            expect(sum).toBe(0n);

            for (const posting of draft.postings) {
              balances.set(
                posting.accountId,
                (balances.get(posting.accountId) ?? 0n) + posting.amount.minor,
              );
            }

            expect(balances.get('source') ?? 0n).toBeGreaterThanOrEqual(0n);
          }

          expect((balances.get('source') ?? 0n) + (balances.get('destination') ?? 0n)).toBe(
            initial,
          );
        },
      ),
      { numRuns: 300 },
    );
  });
});
