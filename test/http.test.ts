import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { LedgerService } from '../src/ledger/ledger-service.js';
import { createTestDb, type TestDb } from './support/test-db.js';

let context: TestDb;
let app: FastifyInstance;

beforeAll(async () => {
  context = await createTestDb();
  app = await buildApp(new LedgerService(context.db));
}, 60_000);

afterAll(async () => {
  await app.close();
  await context.close();
});

async function createAccount(allowNegative = false): Promise<{ id: string; currency: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/accounts',
    payload: { ownerId: randomUUID(), currency: 'USD', allowNegative },
  });

  expect(response.statusCode).toBe(201);
  return response.json<{ id: string; currency: string }>();
}

describe('http api', () => {
  it('requires an Idempotency-Key header', async () => {
    const account = await createAccount();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/transfers',
      payload: {
        fromAccountId: account.id,
        toAccountId: account.id,
        amount: '1.00',
        currency: 'USD',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ title: 'INVALID_REQUEST' });
  });

  it('creates a transfer, then replays it with 200', async () => {
    const treasury = await createAccount(true);
    const customer = await createAccount();

    const payload = {
      fromAccountId: treasury.id,
      toAccountId: customer.id,
      amount: '250.75',
      currency: 'USD',
    };
    const headers = { 'idempotency-key': `http-${randomUUID()}` };

    const created = await app.inject({
      method: 'POST',
      url: '/v1/transfers',
      headers,
      payload,
    });

    expect(created.statusCode).toBe(201);
    expect(created.headers['idempotency-replayed']).toBe('false');
    const entry = created.json<{ id: string; postings: Array<{ amountMinor: string }> }>();
    expect(entry.postings.map((posting) => posting.amountMinor).sort()).toEqual([
      '-25075',
      '25075',
    ]);

    const replayed = await app.inject({
      method: 'POST',
      url: '/v1/transfers',
      headers,
      payload,
    });

    expect(replayed.statusCode).toBe(200);
    expect(replayed.headers['idempotency-replayed']).toBe('true');
    expect(replayed.json<{ id: string }>().id).toBe(entry.id);

    const balance = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${customer.id}/balance`,
    });

    expect(balance.json()).toMatchObject({
      currency: 'USD',
      balance: '250.75',
      balanceMinor: '25075',
    });
  });

  it('returns 422 for an overdraw and 404 for unknown accounts', async () => {
    const treasury = await createAccount(true);
    const customer = await createAccount();

    const overdraw = await app.inject({
      method: 'POST',
      url: '/v1/transfers',
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        fromAccountId: customer.id,
        toAccountId: treasury.id,
        amount: '0.01',
        currency: 'USD',
      },
    });

    expect(overdraw.statusCode).toBe(422);
    expect(overdraw.headers['content-type']).toContain('application/problem+json');
    expect(overdraw.json()).toMatchObject({ title: 'INSUFFICIENT_FUNDS' });

    const missing = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${randomUUID()}/balance`,
    });

    expect(missing.statusCode).toBe(404);
  });

  it('validates request bodies', async () => {
    const account = await createAccount();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/transfers',
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        fromAccountId: account.id,
        toAccountId: account.id,
        amount: '1.234',
        currency: 'USD',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ title: 'INVALID_REQUEST' });
  });

  it('returns 404 for unknown routes without leaking internals', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/nope' });
    expect(response.statusCode).toBe(404);
  });
});
