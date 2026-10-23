import { Pool } from 'pg';
import { databaseUrl, poolMax } from '../config.js';

/**
 * One pool for the process. A long-running server reuses connections across
 * requests; behind Neon's pooler the local pool can stay small because
 * PgBouncer multiplexes the rest.
 *
 * TLS comes from the connection string (`sslmode=require`), which Neon
 * includes in `DATABASE_URL`.
 */
export function createPool(connectionString: string = databaseUrl()): Pool {
  const pool = new Pool({
    connectionString,
    max: poolMax(),
    application_name: 'ledger-core',
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // DoS containment: a runaway query releases its connection instead of
    // holding a pool slot (max = 10) forever. Migrations intentionally use
    // their own pool without this limit — DDL may legitimately be slow.
    // The startup parameter works on vanilla Postgres, but Neon's proxy
    // silently drops it (SHOW statement_timeout = 0, verified); the per-
    // checkout SET below covers that case (verified: pg_sleep(10) cancelled
    // at ~5s through the pooler).
    statement_timeout: 5_000,
  });

  // The SET is queued on the client before the caller's query runs (pg's
  // per-client queue is FIFO), so there is no race with real traffic.
  // 'acquire' alone covers every checkout — new clients fire it too; firing
  // it from 'connect' as well would queue a second SET and trip pg's
  // "query() while already executing" deprecation (client.js:779).
  // NOTE: submitting the caller's query behind this SET trips the same
  // one-time deprecation warning at boot (known pg 8.12+ noise for the
  // official per-checkout-setup pattern; harmless until pg@9). This is the
  // only mechanism Neon's pooler accepts: the startup key is dropped and
  // `options -c statement_timeout` is rejected outright.
  pool.on('acquire', (client) => {
    void client.query('set statement_timeout = 5000').catch(() => {
      // A dying connection must not crash the pool; the next checkout retries.
    });
  });

  return pool;
}
