const LOCAL_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/ledger';

/**
 * Application traffic. On Neon this must be the **pooled** endpoint
 * (hostname contains `-pooler`): PgBouncer in transaction mode keeps the
 * connection count sane for a long-running Fastify server.
 */
export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;
}

/**
 * Schema migrations. Neon exposes the direct (unpooled) endpoint as
 * `DATABASE_URL_UNPOOLED`. DDL and session state do not belong on a
 * transaction-mode pooler, and `neon env pull` provides both URLs for exactly
 * this reason.
 */
export function migrationDatabaseUrl(): string {
  return process.env.DATABASE_URL_UNPOOLED ?? databaseUrl();
}

export function poolMax(): number {
  const raw = process.env.PG_POOL_MAX ?? '10';
  const value = Number(raw);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid PG_POOL_MAX: ${raw}`);
  }

  return value;
}

/** Injected by `neon env pull`; useful in logs and diagnostics. */
export function neonBranch(): string | null {
  return process.env.NEON_BRANCH ?? null;
}

/** Host + database only, never credentials. Safe to log. */
export function describeTarget(connectionString: string): string {
  try {
    const parsed = new URL(connectionString);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return '(unparseable connection string)';
  }
}

export function httpPort(): number {
  const raw = process.env.PORT ?? '3000';
  const port = Number(raw);

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid PORT: ${raw}`);
  }

  return port;
}
