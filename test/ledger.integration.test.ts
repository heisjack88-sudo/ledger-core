import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Account } from '../src/domain/account.js';
import { LedgerService } from '../src/ledger/ledger-service.js';
import { createTestDb, type TestDb } from './support/test-db.js';

let context: TestDb;
let ledger: LedgerService;

beforeAll(async () => {
  context = await createTestDb();
  ledger = new LedgerService(context.db);
}, 60_000);

afterAll(async () => {
  await context.close();
});

async function globalSum(): Promise<bigint> {
  const rows = await context.db.query<{ total: string }>(
    'select coalesce(sum(amount_minor), 0)::text as total from postings',
  );
  return BigInt(rows[0]?.total ?? '0');
}

/** Creates a customer account funded from an account that may go negative. */
async function fundedAccount(amountMinor: bigint, currency = 'USD'): Promise<Account> {
  const ownerId = randomUUID();
  const treasury = await ledger.openAccount({
    ownerId,
    currency,
    kind: 'equity',
    allowNegative: true,
  });
  const account = await ledger.openAccount({ ownerId, currency });

  await ledger.transfer({
    idempotencyKey: randomUUID(),
    fromAccountId: treasury.id,
    toAccountId: account.id,
    amountMinor,
    currency,
  });

  return account;
}

describe(`ledger core (${process.env.TEST_DATABASE_URL ? 'postgres' : 'pglite'})`, () => {
  it('moves money and keeps the books balanced', async () => {
    const source = await fundedAccount(100_000n);
    const destination = await ledger.openAccount({
      ownerId: randomUUID(),
      currency: 'USD',
    });

    const result = await ledger.transfer({
      idempotencyKey: randomUUID(),
      fromAccountId: source.id,
      toAccountId: destination.id,
      amountMinor: 25_050n,
      currency: 'USD',
    });

    expect(result.replayed).toBe(false);
    expect(result.entry.postings).toHaveLength(2);
    expect((await ledger.getBalance(source.id)).balanceMinor).toBe(74_950n);
    expect((await ledger.getBalance(destination.id)).balanceMinor).toBe(25_050n);
    expect(await globalSum()).toBe(0n);
  });

  it('replays an identical request without posting twice', async () => {
    const source = await fundedAccount(100_000n);
    const destination = await ledger.openAccount({ ownerId: randomUUID(), currency: 'USD' });

    const command = {
      idempotencyKey: `replay-${randomUUID()}`,
      fromAccountId: source.id,
      toAccountId: destination.id,
      amountMinor: 12_345n,
      currency: 'USD',
    };

    const first = await ledger.transfer(command);
    const second = await ledger.transfer(command);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.entry.id).toBe(first.entry.id);
    expect((await ledger.getBalance(source.id)).balanceMinor).toBe(87_655n);
    expect((await ledger.getBalance(destination.id)).balanceMinor).toBe(12_345n);
  });

  it('rejects an overdraw with INSUFFICIENT_FUNDS', async () => {
    const source = await fundedAccount(1_000n);
    const destination = await ledger.openAccount({ ownerId: randomUUID(), currency: 'USD' });

    await expect(
      ledger.transfer({
        idempotencyKey: randomUUID(),
        fromAccountId: source.id,
        toAccountId: destination.id,
        amountMinor: 1_001n,
        currency: 'USD',
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
  });

  it('rejects transfers involving unknown accounts', async () => {
    const source = await fundedAccount(1_000n);

    await expect(
      ledger.transfer({
        idempotencyKey: randomUUID(),
        fromAccountId: source.id,
        toAccountId: randomUUID(),
        amountMinor: 100n,
        currency: 'USD',
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });

    expect(await globalSum()).toBe(0n);
  });

  it('survives a race for the last funds: exactly the affordable transfers succeed', async () => {
    const source = await fundedAccount(100_000n);
    const destination = await ledger.openAccount({ ownerId: randomUUID(), currency: 'USD' });

    const attempts = Array.from({ length: 20 }, () =>
      ledger.transfer({
        idempotencyKey: randomUUID(),
        fromAccountId: source.id,
        toAccountId: destination.id,
        amountMinor: 10_000n,
        currency: 'USD',
      }),
    );

    const results = await Promise.allSettled(attempts);
    const succeeded = results.filter((result) => result.status === 'fulfilled');

    expect(succeeded).toHaveLength(10);
    expect((await ledger.getBalance(source.id)).balanceMinor).toBe(0n);
    expect((await ledger.getBalance(destination.id)).balanceMinor).toBe(100_000n);
    expect(await globalSum()).toBe(0n);
  });

  it('rejects an entry that sums to zero but has a single posting', async () => {
    const account = await fundedAccount(1_000n);
    const entryId = randomUUID();

    await expect(
      context.db.transaction(async (tx) => {
        await tx.query(
          `insert into journal_entries (id, idempotency_key, kind) values ($1, $2, 'transfer')`,
          [entryId, `single-${entryId}`],
        );
        await tx.query(
          `insert into postings (entry_id, account_id, amount_minor, currency)
           values ($1, $2, $3, $4)`,
          [entryId, account.id, '500', 'USD'],
        );
      }),
    ).rejects.toThrow(/at least 2 are required/);

    const rows = await context.db.query<{ count: string }>(
      'select count(*)::text as count from journal_entries where id = $1',
      [entryId],
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('rejects an unbalanced entry at COMMIT (deferred constraint)', async () => {
    const account = await fundedAccount(10_000n);
    const entryId = randomUUID();

    await expect(
      context.db.transaction(async (tx) => {
        await tx.query(
          `insert into journal_entries (id, idempotency_key, kind) values ($1, $2, 'transfer')`,
          [entryId, `unbalanced-${entryId}`],
        );

        // Two postings, but they do not cancel out. A buggy application could
        // easily do this; the database refuses to commit it.
        for (const amount of ['5000', '-4000']) {
          await tx.query(
            `insert into postings (entry_id, account_id, amount_minor, currency)
             values ($1, $2, $3, 'USD')`,
            [entryId, account.id, amount],
          );
        }
      }),
    ).rejects.toThrow(/unbalanced/);

    const rows = await context.db.query<{ count: string }>(
      'select count(*)::text as count from journal_entries where id = $1',
      [entryId],
    );
    expect(rows[0]?.count).toBe('0');
    expect(await globalSum()).toBe(0n);
  });

  it('rejects postings whose currency differs from the account currency', async () => {
    const account = await fundedAccount(1_000n);
    const entryId = randomUUID();

    await expect(
      context.db.transaction(async (tx) => {
        await tx.query(
          `insert into journal_entries (id, idempotency_key, kind) values ($1, $2, 'transfer')`,
          [entryId, `currency-${entryId}`],
        );
        await tx.query(
          `insert into postings (entry_id, account_id, amount_minor, currency)
           values ($1, $2, $3, 'EUR')`,
          [entryId, account.id, '500'],
        );
      }),
    ).rejects.toThrow(/does not match/);
  });

  it('writes a domain event in the same transaction as the entry', async () => {
    const source = await fundedAccount(5_000n);
    const destination = await ledger.openAccount({ ownerId: randomUUID(), currency: 'USD' });

    const { entry } = await ledger.transfer({
      idempotencyKey: randomUUID(),
      fromAccountId: source.id,
      toAccountId: destination.id,
      amountMinor: 1_500n,
      currency: 'USD',
    });

    const rows = await context.db.query<{ aggregate_id: string; event_type: string }>(
      'select aggregate_id, event_type from outbox where aggregate_id = $1',
      [entry.id],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_type).toBe('ledger.entry.posted');
  });

  it('paginates entries by keyset without duplicates or gaps', async () => {
    const source = await fundedAccount(100_000n);
    const destination = await ledger.openAccount({ ownerId: randomUUID(), currency: 'USD' });

    for (let index = 0; index < 5; index += 1) {
      await ledger.transfer({
        idempotencyKey: randomUUID(),
        fromAccountId: source.id,
        toAccountId: destination.id,
        amountMinor: 1_000n,
        currency: 'USD',
      });
    }

    const seen: string[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 10; page += 1) {
      const result = await ledger.listEntries(source.id, { limit: 2, cursor });
      seen.push(...result.items.map((item) => item.id));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }

    // 5 transfers + the funding transfer.
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
  });

  it('rejects a malformed cursor', async () => {
    const account = await fundedAccount(1_000n);

    await expect(
      ledger.listEntries(account.id, { limit: 10, cursor: 'not-a-cursor' }),
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });
});
