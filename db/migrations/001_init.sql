-- 001_init.sql
--
-- Core double-entry schema.
--
-- Sign convention: postings.amount_minor is SIGNED.
--   positive = debit
--   negative = credit
--
-- The only invariant that really matters is enforced by Postgres itself:
--   for every journal entry, sum(amount_minor) = 0
--
-- The application can be buggy. The database is the last line of defence.

create table accounts (
  id             uuid        primary key,
  owner_id       uuid        not null,
  currency       char(3)     not null,
  kind           text        not null,
  allow_negative boolean     not null default false,
  created_at     timestamptz not null default now(),
  constraint accounts_currency_iso check (currency ~ '^[A-Z]{3}$'),
  constraint accounts_kind_valid check (kind in ('asset', 'liability', 'equity', 'revenue', 'expense'))
);

create table journal_entries (
  id              uuid        primary key,
  idempotency_key text        not null,
  kind            text        not null,
  status          text        not null default 'posted',
  correlation_id  text,
  created_at      timestamptz not null default now(),
  -- The whole idempotency story rests on this constraint.
  constraint journal_entries_idempotency_key_uniq unique (idempotency_key),
  constraint journal_entries_status_valid check (status in ('posted', 'reversed'))
);

create table postings (
  id           bigint      generated always as identity primary key,
  entry_id     uuid        not null references journal_entries (id),
  account_id   uuid        not null references accounts (id),
  amount_minor bigint      not null,
  currency     char(3)     not null,
  created_at   timestamptz not null default now(),
  constraint postings_amount_non_zero check (amount_minor <> 0)
);

create index postings_account_id_idx on postings (account_id, id);
create index postings_entry_id_idx on postings (entry_id);
create index journal_entries_created_at_idx on journal_entries (created_at desc, id desc);

-- A posting may only use the currency of its account.
create function enforce_posting_currency() returns trigger
language plpgsql
as $$
declare
  account_currency char(3);
begin
  select currency into account_currency from accounts where id = new.account_id;

  if account_currency is null then
    raise exception 'account % does not exist', new.account_id using errcode = '23503';
  end if;

  if account_currency <> new.currency then
    raise exception 'posting currency % does not match account currency %',
      new.currency, account_currency using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger postings_currency_check
  before insert or update on postings
  for each row execute function enforce_posting_currency();

-- Deferred check: runs at COMMIT, once the whole entry is visible.
-- This is what makes "insert half a transfer, then crash" impossible.
create function assert_entry_balanced() returns trigger
language plpgsql
as $$
declare
  -- NOTE: the variable must not share a name with the column, otherwise
  -- "where entry_id = entry_id" resolves to the column and is always true.
  target_entry_id uuid := coalesce(new.entry_id, old.entry_id);
  total bigint;
  posting_count bigint;
begin
  select coalesce(sum(amount_minor), 0), count(*)
    into total, posting_count
    from postings
   where entry_id = target_entry_id;

  -- The whole entry was deleted: nothing to check.
  if posting_count = 0 then
    return null;
  end if;

  if posting_count < 2 then
    raise exception 'journal entry % has % posting(s); at least 2 are required',
      target_entry_id, posting_count using errcode = '23514';
  end if;

  if total <> 0 then
    raise exception 'journal entry % is unbalanced: sum(amount_minor) = %',
      target_entry_id, total using errcode = '23514';
  end if;

  return null;
end;
$$;

create constraint trigger postings_entry_balanced
  after insert or update or delete on postings
  deferrable initially deferred
  for each row execute function assert_entry_balanced();
