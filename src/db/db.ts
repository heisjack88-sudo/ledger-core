/**
 * Minimal database port. Deliberately not an ORM:
 * the ledger core is SQL, and the SQL must stay visible.
 *
 * Rows are returned as plain objects; callers own their row types.
 */
export interface Db {
  query<R>(sql: string, params?: unknown[]): Promise<R[]>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

export function toBigInt(value: bigint | string | number): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === '23505') return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message.includes('journal_entries_idempotency_key_uniq');
}

export function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
