/**
 * Application traffic. On Neon this must be the **pooled** endpoint
 * (hostname contains `-pooler`): PgBouncer in transaction mode keeps the
 * connection count sane for a long-running Fastify server.
 *
 * Fail closed: no silent fallback to a localhost URL with default
 * credentials. A missing DATABASE_URL is a misconfiguration, and crashing
 * at boot with an actionable message beats quietly connecting somewhere
 * unintended (and unauthenticated) in production.
 */
export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.length === 0) {
    throw new Error(
      'DATABASE_URL is not set. Run `neon env pull` (Neon) or copy .env.example to .env (local Postgres).',
    );
  }
  return url;
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
