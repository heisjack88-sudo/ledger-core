/**
 * End-to-end smoke test against a running server.
 *
 *   npm run smoke                      # http://localhost:3000
 *   BASE_URL=https://... npm run smoke # deployed instance
 *
 * Exercises the real HTTP -> Fastify -> Postgres path, including the deferred
 * balance trigger and idempotent replay. Exits non-zero on the first failure.
 */
const baseUrl = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

const results = [];
let failed = 0;

function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failed += 1;
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function request(method, path, { body, headers } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let json;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }

  return { status: response.status, headers: response.headers, body: json };
}

const runId = crypto.randomUUID();
const idempotencyKey = `smoke-${runId}`;

console.log(`Target: ${baseUrl}\n`);

async function waitForServer() {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Server at ${baseUrl} did not become ready within 30s`);
}

await waitForServer();

const health = await request('GET', '/healthz');
check('GET /healthz', health.status === 200 && health.body?.status === 'ok', `status ${health.status}`);

const ownerId = crypto.randomUUID();

const treasury = await request('POST', '/v1/accounts', {
  body: { ownerId, currency: 'USD', kind: 'equity', allowNegative: true },
});
check('POST /v1/accounts (treasury)', treasury.status === 201, `status ${treasury.status}`);

const customer = await request('POST', '/v1/accounts', {
  body: { ownerId, currency: 'USD' },
});
check('POST /v1/accounts (customer)', customer.status === 201, `status ${customer.status}`);

const transferBody = {
  fromAccountId: treasury.body.id,
  toAccountId: customer.body.id,
  amount: '250.75',
  currency: 'USD',
};

const transfer = await request('POST', '/v1/transfers', {
  body: transferBody,
  headers: { 'idempotency-key': idempotencyKey },
});
const postings = transfer.body?.postings ?? [];
const postingSum = postings.reduce((sum, posting) => sum + BigInt(posting.amountMinor), 0n);

check('POST /v1/transfers', transfer.status === 201, `status ${transfer.status}`);
check('transfer has 2 postings', postings.length === 2, `${postings.length} postings`);
check('entry sums to zero', postingSum === 0n, `sum ${postingSum}`);
check('postings are -25075 / +25075', postings.map((p) => p.amountMinor).sort().join(',') === '-25075,25075');

const replay = await request('POST', '/v1/transfers', {
  body: transferBody,
  headers: { 'idempotency-key': idempotencyKey },
});
check('replay returns 200', replay.status === 200, `status ${replay.status}`);
check(
  'replay is flagged',
  replay.headers.get('idempotency-replayed') === 'true',
  `header ${replay.headers.get('idempotency-replayed')}`,
);
check('replay returns the same entry', replay.body?.id === transfer.body?.id);

const balance = await request('GET', `/v1/accounts/${customer.body.id}/balance`);
check(
  'GET balance is 250.75',
  balance.status === 200 && balance.body?.balance === '250.75' && balance.body?.balanceMinor === '25075',
  `${balance.body?.balance} / ${balance.body?.balanceMinor}`,
);

const page1 = await request('GET', `/v1/accounts/${customer.body.id}/entries?limit=1`);
const page2 = page1.body?.nextCursor
  ? await request(
      'GET',
      `/v1/accounts/${customer.body.id}/entries?limit=1&cursor=${encodeURIComponent(page1.body.nextCursor)}`,
    )
  : null;

check('GET entries (page 1)', page1.status === 200 && page1.body?.items?.length === 1);
check('cursor pagination terminates', page1.body?.items?.length === 1 && (page2?.status ?? 0) === 200);

const overdraw = await request('POST', '/v1/transfers', {
  body: {
    fromAccountId: customer.body.id,
    toAccountId: treasury.body.id,
    amount: '999999.00',
    currency: 'USD',
  },
  headers: { 'idempotency-key': `smoke-overdraw-${runId}` },
});
check('overdraw is rejected with 422', overdraw.status === 422, `status ${overdraw.status}`);
check(
  'overdraw is a problem+json INSUFFICIENT_FUNDS',
  overdraw.body?.title === 'INSUFFICIENT_FUNDS',
  `${overdraw.body?.title}`,
);

const missing = await request('GET', `/v1/accounts/${crypto.randomUUID()}/balance`);
check('unknown account returns 404', missing.status === 404, `status ${missing.status}`);

console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (failed > 0) process.exitCode = 1;
