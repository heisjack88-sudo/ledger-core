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
  return new Pool({
    connectionString,
    max: poolMax(),
    application_name: 'ledger-core',
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}
