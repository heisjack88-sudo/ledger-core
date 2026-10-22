import { databaseUrl, describeTarget, httpPort, neonBranch } from './config.js';
import { PgDb } from './db/pg-db.js';
import { createPool } from './db/pool.js';
import { buildApp } from './http/app.js';
import { LedgerService } from './ledger/ledger-service.js';

const pool = createPool();
const db = PgDb.fromPool(pool);

/**
 * Migrations are a release step, not a boot step: with N instances behind a
 * load balancer, N processes racing to run the same DDL is a bad time. On Neon
 * the migration also has to use the direct (unpooled) connection, so the only
 * entry point is `npm run migrate`.
 */

// Fail fast with an actionable message instead of accepting traffic that is
// guaranteed to 500.
try {
  await db.query('select 1 from accounts limit 1');
} catch (error) {
  const code = (error as { code?: string }).code;
  console.error(
    code === '42P01'
      ? 'Schema not found. Run `npm run migrate` before starting the server.'
      : `Cannot reach the database at ${describeTarget(databaseUrl())}: ${(error as Error).message}`,
  );
  await pool.end();
  process.exit(1);
}

const app = buildApp(new LedgerService(db), { logger: true });
await app.listen({ port: httpPort(), host: '0.0.0.0' });

app.log.info(
  {
    target: describeTarget(databaseUrl()),
    branch: neonBranch(),
    poolMax: pool.options.max,
  },
  'ledger-core ready',
);

let shuttingDown = false;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void app
      .close()
      .then(() => pool.end())
      .then(() => process.exit(0));
  });
}
