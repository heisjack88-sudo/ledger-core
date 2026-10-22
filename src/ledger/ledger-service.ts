import { randomUUID } from 'node:crypto';
import type { Account, AccountKind } from '../domain/account.js';
import { buildTransfer, type EntryDraft, type EntryKind } from '../domain/entry.js';
import { DomainError } from '../domain/errors.js';
import { money, parseMinor } from '../domain/money.js';
import { type Db, isUniqueViolation, toBigInt, toIsoString } from '../db/db.js';

interface AccountRow {
  id: string;
  owner_id: string;
  currency: string;
  kind: AccountKind;
  allow_negative: boolean;
  created_at: Date | string;
}

interface EntryRow {
  id: string;
  kind: EntryKind;
  status: 'posted' | 'reversed';
  correlation_id: string | null;
  created_at: Date | string;
  postings: RawPosting[];
}

interface RawPosting {
  id: string;
  accountId: string;
  amountMinor: string;
  currency: string;
}

export interface PostingView {
  id: string;
  accountId: string;
  amountMinor: string;
  currency: string;
}

export interface EntryView {
  id: string;
  kind: EntryKind;
  status: 'posted' | 'reversed';
  correlationId: string | null;
  createdAt: string;
  postings: PostingView[];
}

export interface TransferResult {
  entry: EntryView;
  replayed: boolean;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface OpenAccountInput {
  ownerId: string;
  currency: string;
  kind?: AccountKind;
  allowNegative?: boolean;
}

export interface TransferCommand {
  idempotencyKey: string;
  fromAccountId: string;
  toAccountId: string;
  amountMinor: bigint;
  currency: string;
  correlationId?: string | null;
}

export interface ListEntriesOptions {
  limit: number;
  cursor?: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class LedgerService {
  constructor(private readonly db: Db) {}

  async openAccount(input: OpenAccountInput): Promise<Account> {
    const rows = await this.db.query<AccountRow>(
      `insert into accounts (id, owner_id, currency, kind, allow_negative)
       values ($1, $2, $3, $4, $5)
       returning *`,
      [
        randomUUID(),
        input.ownerId,
        input.currency,
        input.kind ?? 'asset',
        input.allowNegative ?? false,
      ],
    );

    const row = rows[0];
    if (row === undefined) throw new Error('Account insert returned no row');
    return mapAccount(row);
  }

  async getAccount(accountId: string): Promise<Account> {
    const rows = await this.db.query<AccountRow>('select * from accounts where id = $1', [
      accountId,
    ]);
    const row = rows[0];
    if (row === undefined) {
      throw new DomainError('ACCOUNT_NOT_FOUND', `Account ${accountId} not found`, { accountId });
    }
    return mapAccount(row);
  }

  async getBalance(accountId: string): Promise<{ accountId: string; currency: string; balanceMinor: bigint }> {
    const rows = await this.db.query<{ id: string; currency: string; balance: string }>(
      `select a.id, a.currency, coalesce(sum(p.amount_minor), 0)::text as balance
         from accounts a
         left join postings p on p.account_id = a.id
        where a.id = $1
        group by a.id, a.currency`,
      [accountId],
    );

    const row = rows[0];
    if (row === undefined) {
      throw new DomainError('ACCOUNT_NOT_FOUND', `Account ${accountId} not found`, { accountId });
    }

    return { accountId: row.id, currency: row.currency, balanceMinor: toBigInt(row.balance) };
  }

  async transfer(command: TransferCommand): Promise<TransferResult> {
    const alreadyPosted = await this.findByIdempotencyKey(command.idempotencyKey);
    if (alreadyPosted !== null) {
      return { entry: alreadyPosted, replayed: true };
    }

    let entryId: string;
    try {
      entryId = await this.db.transaction(async (tx) => {
        const accountIds = [command.fromAccountId, command.toAccountId];

        // Lock in a deterministic order: concurrent transfers touching the same
        // pair of accounts can never deadlock on each other.
        const accounts = await tx.query<AccountRow>(
          `select * from accounts
            where id = any($1::uuid[])
            order by id
            for update`,
          [accountIds],
        );

        const byId = new Map(accounts.map((account) => [account.id, account]));
        const source = byId.get(command.fromAccountId);
        const destination = byId.get(command.toAccountId);

        if (source === undefined) {
          throw new DomainError('ACCOUNT_NOT_FOUND', `Account ${command.fromAccountId} not found`, {
            accountId: command.fromAccountId,
          });
        }
        if (destination === undefined) {
          throw new DomainError('ACCOUNT_NOT_FOUND', `Account ${command.toAccountId} not found`, {
            accountId: command.toAccountId,
          });
        }

        // Safe under the row locks above: no one can post to these accounts
        // between this read and the commit.
        const balances = await this.balances(tx, accountIds);

        const draft = buildTransfer({
          id: randomUUID(),
          idempotencyKey: command.idempotencyKey,
          correlationId: command.correlationId ?? null,
          amount: money(command.amountMinor, command.currency),
          source: {
            id: source.id,
            currency: source.currency,
            allowNegative: source.allow_negative,
            balanceMinor: balances.get(source.id) ?? 0n,
          },
          destination: { id: destination.id, currency: destination.currency },
        });

        await this.insertEntry(tx, draft);
        return draft.id;
      });
    } catch (error) {
      // Two identical requests raced; the loser reads the winner's entry.
      if (isUniqueViolation(error)) {
        const winner = await this.findByIdempotencyKey(command.idempotencyKey);
        if (winner !== null) return { entry: winner, replayed: true };
      }
      throw error;
    }

    return { entry: await this.loadEntry(entryId), replayed: false };
  }

  async listEntries(accountId: string, options: ListEntriesOptions): Promise<Page<EntryView>> {
    await this.getAccount(accountId); // 404 for unknown accounts

    const limit = Math.min(Math.max(options.limit, 1), 100);
    const cursor = options.cursor != null ? decodeCursor(options.cursor) : null;

    const rows = await this.db.query<EntryRow>(
      `with page as (
         select e.id, e.created_at
           from journal_entries e
          where exists (
                  select 1 from postings p
                   where p.entry_id = e.id and p.account_id = $1::uuid
                )
            and ($2::timestamptz is null
                 or (e.created_at, e.id) < ($2::timestamptz, $3::uuid))
          order by e.created_at desc, e.id desc
          limit $4
       )
       select e.id, e.kind, e.status, e.correlation_id, e.created_at,
              coalesce(
                json_agg(
                  json_build_object(
                    'id', p.id::text,
                    'accountId', p.account_id,
                    'amountMinor', p.amount_minor::text,
                    'currency', p.currency
                  ) order by p.id
                ) filter (where p.id is not null),
                '[]'::json
              ) as postings
         from page
         join journal_entries e on e.id = page.id
         join postings p on p.entry_id = e.id
        group by e.id, e.kind, e.status, e.correlation_id, e.created_at
        order by e.created_at desc, e.id desc`,
      [accountId, cursor?.createdAt ?? null, cursor?.id ?? null, limit],
    );

    const items = rows.map(mapEntry);
    const last = rows[rows.length - 1];

    return {
      items,
      nextCursor:
        rows.length === limit && last !== undefined
          ? encodeCursor(toIsoString(last.created_at), last.id)
          : null,
    };
  }

  private async balances(tx: Db, accountIds: string[]): Promise<Map<string, bigint>> {
    const rows = await tx.query<{ account_id: string; balance: string }>(
      `select account_id, coalesce(sum(amount_minor), 0)::text as balance
         from postings
        where account_id = any($1::uuid[])
        group by account_id`,
      [accountIds],
    );

    const result = new Map<string, bigint>();
    for (const row of rows) result.set(row.account_id, toBigInt(row.balance));
    return result;
  }

  private async insertEntry(tx: Db, draft: EntryDraft): Promise<void> {
    await tx.query(
      `insert into journal_entries (id, idempotency_key, kind, correlation_id)
       values ($1, $2, $3, $4)`,
      [draft.id, draft.idempotencyKey, draft.kind, draft.correlationId],
    );

    const values: unknown[] = [];
    const placeholders: string[] = [];

    draft.postings.forEach((posting, index) => {
      const base = index * 4;
      placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
      values.push(
        draft.id,
        posting.accountId,
        posting.amount.minor.toString(),
        posting.amount.currency,
      );
    });

    await tx.query(
      `insert into postings (entry_id, account_id, amount_minor, currency)
       values ${placeholders.join(', ')}`,
      values,
    );

    // Same transaction as the ledger rows: the event cannot exist without the
    // entry, and the entry cannot commit without the event.
    await tx.query(
      `insert into outbox (id, aggregate_type, aggregate_id, event_type, payload)
       values ($1, $2, $3, $4, $5)`,
      [
        randomUUID(),
        'journal_entry',
        draft.id,
        'ledger.entry.posted',
        JSON.stringify({
          entryId: draft.id,
          kind: draft.kind,
          postings: draft.postings.map((posting) => ({
            accountId: posting.accountId,
            amountMinor: posting.amount.minor.toString(),
            currency: posting.amount.currency,
          })),
        }),
      ],
    );
  }

  private async findByIdempotencyKey(key: string): Promise<EntryView | null> {
    const rows = await this.db.query<{ id: string }>(
      'select id from journal_entries where idempotency_key = $1',
      [key],
    );
    const row = rows[0];
    return row === undefined ? null : this.loadEntry(row.id);
  }

  private async loadEntry(entryId: string): Promise<EntryView> {
    const rows = await this.db.query<EntryRow>(
      `select e.id, e.kind, e.status, e.correlation_id, e.created_at,
              coalesce(
                json_agg(
                  json_build_object(
                    'id', p.id::text,
                    'accountId', p.account_id,
                    'amountMinor', p.amount_minor::text,
                    'currency', p.currency
                  ) order by p.id
                ) filter (where p.id is not null),
                '[]'::json
              ) as postings
         from journal_entries e
         left join postings p on p.entry_id = e.id
        where e.id = $1
        group by e.id, e.kind, e.status, e.correlation_id, e.created_at`,
      [entryId],
    );

    const row = rows[0];
    if (row === undefined) throw new Error(`Entry ${entryId} not found after commit`);
    return mapEntry(row);
  }
}

function mapAccount(row: AccountRow): Account {
  return {
    id: row.id,
    ownerId: row.owner_id,
    currency: row.currency.trim(),
    kind: row.kind,
    allowNegative: row.allow_negative,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  };
}

function mapEntry(row: EntryRow): EntryView {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    correlationId: row.correlation_id,
    createdAt: toIsoString(row.created_at),
    postings: row.postings.map((posting) => ({
      id: posting.id,
      accountId: posting.accountId,
      amountMinor: posting.amountMinor,
      currency: posting.currency.trim(),
    })),
  };
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = raw.indexOf('|');

  if (separator <= 0) {
    throw new DomainError('INVALID_CURSOR', 'Malformed pagination cursor');
  }

  const createdAt = raw.slice(0, separator);
  const id = raw.slice(separator + 1);

  if (Number.isNaN(Date.parse(createdAt)) || !UUID_PATTERN.test(id)) {
    throw new DomainError('INVALID_CURSOR', 'Malformed pagination cursor');
  }

  return { createdAt, id };
}

// Exported for tests that need to build amounts from decimal strings.
export function amountFromDecimal(value: string, currency: string): bigint {
  return parseMinor(value, currency).minor;
}
