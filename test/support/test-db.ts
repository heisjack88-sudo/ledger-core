import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../../src/db/db.js';
import { migrate } from '../../src/db/migrate.js';
import { PgDb } from '../../src/db/pg-db.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../db/migrations');

export interface TestDb {
  db: Db;
  driver: 'pglite' | 'postgres';
  close(): Promise<void>;
}

/**
 * PGlite is Postgres 17 compiled to WASM: same planner, same triggers, same
 * deferred-constraint semantics. Integration tests need no Docker and no
 * services in CI. Set TEST_DATABASE_URL to run the very same suite against a
 * real Postgres, which is where row-level locking is genuinely exercised.
 *
 * PGlite has a single connection, so top-level operations are serialized
 * through a shared mutex. A transaction gets its own non-queuing adapter:
 * that is what prevents a concurrent transaction from sneaking its BEGIN
 * into another transaction's scope. Consequence: under PGlite the
 * "race for the last funds" test proves the logic, not true parallelism.
 */
class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

class PgliteDb implements Db {
  constructor(
    private readonly client: PGlite,
    private readonly mutex: Mutex = new Mutex(),
    private readonly insideTransaction = false,
  ) {}

  async query<R>(sql: string, params: unknown[] = []): Promise<R[]> {
    const run = async (): Promise<R[]> => {
      const result = await this.client.query(sql, params);
      return result.rows as R[];
    };

    return this.insideTransaction ? run() : this.mutex.run(run);
  }

  async exec(sql: string): Promise<void> {
    const run = async (): Promise<void> => {
      await this.client.exec(sql);
    };

    await (this.insideTransaction ? run() : this.mutex.run(run));
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (this.insideTransaction) {
      throw new Error('Nested transactions are not supported');
    }

    return this.mutex.run(async () => {
      await this.client.exec('begin');
      try {
        const result = await fn(new PgliteDb(this.client, this.mutex, true));
        await this.client.exec('commit');
        return result;
      } catch (error) {
        await this.client.exec('rollback').catch(() => undefined);
        throw error;
      }
    });
  }
}

export async function createTestDb(): Promise<TestDb> {
  const url = process.env.TEST_DATABASE_URL;

  if (url !== undefined && url.length > 0) {
    const pool = new Pool({ connectionString: url });
    const db = PgDb.fromPool(pool);
    await db.exec('drop schema public cascade; create schema public;');
    await migrate(db, migrationsDir);
    return { db, driver: 'postgres', close: () => pool.end() };
  }

  const client = new PGlite();
  const db = new PgliteDb(client);
  await migrate(db, migrationsDir);
  return { db, driver: 'pglite', close: () => client.close() };
}
