-- 002_outbox.sql
--
-- Transactional outbox: domain events are written in the SAME transaction as
-- the ledger rows, then published asynchronously. No 2PC, no lost events.

create table outbox (
  id             uuid        primary key,
  aggregate_type text        not null,
  aggregate_id   uuid        not null,
  event_type     text        not null,
  payload        jsonb       not null,
  attempts       integer     not null default 0,
  created_at     timestamptz not null default now(),
  published_at   timestamptz,
  constraint outbox_attempts_non_negative check (attempts >= 0)
);

-- Partial index: the publisher only ever scans unpublished rows.
create index outbox_unpublished_idx on outbox (created_at) where published_at is null;
