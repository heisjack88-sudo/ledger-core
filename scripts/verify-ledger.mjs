/**
 * Verifies the ledger invariants directly against the database.
 * Requires DATABASE_URL_UNPOOLED (preferred) or DATABASE_URL.
 *
 *   npm run verify:ledger
 *
 * This is the check that a schema-only test cannot fake: it inserts a broken
 * entry, commits, and expects Postgres itself to reject it.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const connectionString = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;

if (!connectionString) {
  console.error('DATABASE_URL_UNPOOLED or DATABASE_URL must be set');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString, max: 1, application_name: 'ledger-core-verify' });
let failed = 0;

function check(name, ok, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

try {
  const target = new URL(connectionString);
  console.log(`Target: ${target.hostname}${target.pathname}\n`);

  const triggers = await pool.query(
    `select tgname from pg_trigger where not tgisinternal order by tgname`,
  );
  const triggerNames = triggers.rows.map((row) => row.tgname);
  check(
    'deferred balance trigger exists',
    triggerNames.includes('postings_entry_balanced'),
    triggerNames.join(', ') || 'none',
  );
  check('currency trigger exists', triggerNames.includes('postings_currency_check'));

  const totals = await pool.query(
    `select coalesce(sum(amount_minor), 0)::text as total,
            count(*)::int as postings
       from postings`,
  );
  const entries = await pool.query('select count(*)::int as entries from journal_entries');
  check('ledger is balanced', totals.rows[0].total === '0', `sum=${totals.rows[0].total}`);
  console.log(
    `      ${entries.rows[0].entries} entries, ${totals.rows[0].postings} postings, net ${totals.rows[0].total}`,
  );

  const account = await pool.query('select id, currency from accounts limit 1');
  if (account.rowCount === 0) {
    check('an account exists to test the trigger', false, 'no accounts yet');
  } else {
    const { id: accountId, currency } = account.rows[0];
    const entryId = randomUUID();
    const client = await pool.connect();

    try {
      await client.query('begin');
      await client.query(
        `insert into journal_entries (id, idempotency_key, kind) values ($1, $2, 'transfer')`,
        [entryId, `verify-${entryId}`],
      );
      // Two postings that do not cancel out: exactly the bug the trigger exists
      // to catch. The insert succeeds; the COMMIT must not.
      await client.query(
        `insert into postings (entry_id, account_id, amount_minor, currency)
         values ($1, $2, '700', $3), ($1, $2, '-600', $3)`,
        [entryId, accountId, currency],
      );
      await client.query('commit');
      check('unbalanced entry is rejected at COMMIT', false, 'it committed!');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      check(
        'unbalanced entry is rejected at COMMIT',
        /unbalanced/.test(error.message),
        error.message.slice(0, 80),
      );
    } finally {
      client.release();
    }

    const after = await pool.query(
      `select count(*)::int as leaked from journal_entries where id = $1`,
      [entryId],
    );
    check('rejected entry left no rows behind', after.rows[0].leaked === 0);
  }

  const finalSum = await pool.query(
    `select coalesce(sum(amount_minor), 0)::text as total from postings`,
  );
  check('ledger still balanced after the attempt', finalSum.rows[0].total === '0');

  console.log(failed === 0 ? '\nAll invariant checks passed.' : `\n${failed} check(s) failed.`);
  if (failed > 0) process.exitCode = 1;
} finally {
  await pool.end();
}
