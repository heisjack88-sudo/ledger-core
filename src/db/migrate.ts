import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from './db.js';

/**
 * Tiny forward-only migrator. Each migration runs inside its own transaction,
 * so a failing script leaves the database untouched.
 */
export async function migrate(db: Db, migrationsDir: string): Promise<string[]> {
  await db.exec(`
    create table if not exists schema_migrations (
      name       text        primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const applied: string[] = [];

  for (const file of files) {
    const existing = await db.query<{ name: string }>(
      'select name from schema_migrations where name = $1',
      [file],
    );
    if (existing.length > 0) continue;

    const sql = await readFile(join(migrationsDir, file), 'utf8');

    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query('insert into schema_migrations (name) values ($1)', [file]);
    });

    applied.push(file);
  }

  return applied;
}
