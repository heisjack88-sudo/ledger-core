import { DomainError } from './errors.js';
import {
  type Money,
  assertSameCurrency,
  isPositive,
  money,
  negate,
} from './money.js';

export type EntryKind = 'transfer' | 'deposit' | 'withdrawal' | 'fee' | 'reversal';

export interface PostingDraft {
  readonly accountId: string;
  readonly amount: Money;
}

export interface EntryDraft {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly kind: EntryKind;
  readonly correlationId: string | null;
  readonly postings: readonly PostingDraft[];
}

export interface TransferSource {
  readonly id: string;
  readonly currency: string;
  readonly allowNegative: boolean;
  readonly balanceMinor: bigint;
}

export interface TransferRequest {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly correlationId?: string | null;
  readonly amount: Money;
  readonly source: TransferSource;
  readonly destination: { readonly id: string; readonly currency: string };
}

/**
 * The domain-level mirror of the database's deferred trigger.
 * Pure, fast, and property-testable: no I/O here.
 */
export function assertBalanced(postings: readonly PostingDraft[]): void {
  const first = postings[0];
  if (first === undefined || postings.length < 2) {
    throw new DomainError(
      'SINGLE_POSTING',
      'A journal entry needs at least two postings',
      { postings: postings.length },
    );
  }

  let total = 0n;
  for (const posting of postings) {
    assertSameCurrency(first.amount, posting.amount);
    total += posting.amount.minor;
  }

  if (total !== 0n) {
    throw new DomainError('UNBALANCED_ENTRY', `Entry does not balance: sum = ${total}`, {
      sum: total.toString(),
    });
  }
}

export function buildTransfer(request: TransferRequest): EntryDraft {
  const { amount, source, destination } = request;

  if (!isPositive(amount)) {
    throw new DomainError('INVALID_AMOUNT', 'Transfer amount must be strictly positive', {
      amount: amount.minor.toString(),
    });
  }

  if (source.id === destination.id) {
    throw new DomainError('SAME_ACCOUNT', 'Source and destination accounts must differ');
  }

  if (amount.currency !== source.currency || amount.currency !== destination.currency) {
    throw new DomainError(
      'CURRENCY_MISMATCH',
      'Transfer currency must match both accounts',
      {
        amount: amount.currency,
        source: source.currency,
        destination: destination.currency,
      },
    );
  }

  if (!source.allowNegative && source.balanceMinor - amount.minor < 0n) {
    throw new DomainError('INSUFFICIENT_FUNDS', 'Source account has insufficient funds', {
      available: source.balanceMinor.toString(),
      requested: amount.minor.toString(),
    });
  }

  const postings: PostingDraft[] = [
    { accountId: source.id, amount: negate(amount) },
    { accountId: destination.id, amount: money(amount.minor, amount.currency) },
  ];

  assertBalanced(postings);

  return {
    id: request.id,
    idempotencyKey: request.idempotencyKey,
    kind: 'transfer',
    correlationId: request.correlationId ?? null,
    postings,
  };
}
