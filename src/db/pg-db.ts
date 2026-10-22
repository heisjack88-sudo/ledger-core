import type { Pool } from 'pg';
import type { Db } from './db.js';

/**
 * Structural subset of pg's Pool/PoolClient so the same adapter works for
 * both a pool and a transaction-scoped client.
 */
interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export class PgDb implements Db {
  constructor(
    private readonly connection: Queryable,
    private readonly pool: Pool | null = null,
  ) {}

  static fromPool(pool: Pool): PgDb {
    return new PgDb(pool as unknown as Queryable, pool);
  }

  async query<R>(sql: string, params: unknown[] = []): Promise<R[]> {
    const result = await this.connection.query(sql, params);
    return result.rows as R[];
  }

  async exec(sql: string): Promise<void> {
    await this.connection.query(sql);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (this.pool === null) {
      throw new Error('Nested transactions are not supported');
    }

    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await fn(new PgDb(client as unknown as Queryable));
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
