import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { databaseUrl, describeTarget, migrationDatabaseUrl } from '../config.js';
import { migrate } from './migrate.js';
import { PgDb } from './pg-db.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '../../db/migrations');

const target = migrationDatabaseUrl();

if (target === databaseUrl() && databaseUrl().includes('-pooler')) {
  console.warn(
    'DATABASE_URL is a pooled endpoint and DATABASE_URL_UNPOOLED is not set. ' +
      'Migrations should run on the direct connection; run `neon env pull` or set DATABASE_URL_UNPOOLED.',
  );
}

console.log(`Migrating ${describeTarget(target)}`);

// Single connection on purpose: migrations are sequential, and holding one
// connection avoids competing for DDL locks.
const pool = new Pool({
  connectionString: target,
  max: 1,
  application_name: 'ledger-core-migrate',
});

try {
  const applied = await migrate(PgDb.fromPool(pool), migrationsDir);
  console.log(
    applied.length === 0 ? 'No pending migrations.' : `Applied: ${applied.join(', ')}`,
  );
} finally {
  await pool.end();
}
