import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DomainError } from '../domain/errors.js';
import { formatMinor, money, parseMinor } from '../domain/money.js';
import type { LedgerService } from '../ledger/ledger-service.js';

const accountParams = z.object({ id: z.uuid() });

const openAccountBody = z.object({
  ownerId: z.uuid(),
  currency: z.string().trim().length(3),
  kind: z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']).optional(),
  allowNegative: z.boolean().optional(),
});

const transferBody = z.object({
  fromAccountId: z.uuid(),
  toAccountId: z.uuid(),
  // Amounts travel as decimal strings; they are parsed to minor units and
  // never become IEEE-754 floats.
  amount: z.string().regex(/^-?\d+(?:[.,]\d{1,2})?$/, 'amount must be a decimal string'),
  currency: z.string().trim().length(3),
  correlationId: z.string().max(128).optional(),
});

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
});

export interface AppOptions {
  logger?: boolean;
}

export function buildApp(ledger: LedgerService, options: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) {
      const status = statusFor(error.code);
      return reply
        .status(status)
        .type('application/problem+json')
        .send({
          type: `https://ledger-core.dev/problems/${error.code.toLowerCase()}`,
          title: error.code,
          status,
          detail: error.message,
          ...error.details,
        });
    }

    if (error instanceof z.ZodError) {
      return reply
        .status(400)
        .type('application/problem+json')
        .send({
          type: 'https://ledger-core.dev/problems/invalid-request',
          title: 'INVALID_REQUEST',
          status: 400,
          detail: 'Request validation failed',
          issues: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply
      .status(500)
      .type('application/problem+json')
      .send({
        type: 'https://ledger-core.dev/problems/internal-error',
        title: 'INTERNAL_ERROR',
        status: 500,
        detail: 'An unexpected error occurred',
      });
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.post('/v1/accounts', async (request, reply) => {
    const body = openAccountBody.parse(request.body);
    const account = await ledger.openAccount(body);
    return reply.status(201).send(serializeAccount(account));
  });

  app.get('/v1/accounts/:id', async (request) => {
    const { id } = accountParams.parse(request.params);
    return serializeAccount(await ledger.getAccount(id));
  });

  app.get('/v1/accounts/:id/balance', async (request) => {
    const { id } = accountParams.parse(request.params);
    const balance = await ledger.getBalance(id);
    const amount = money(balance.balanceMinor, balance.currency);
    return {
      accountId: balance.accountId,
      currency: balance.currency,
      balance: formatMinor(amount),
      balanceMinor: balance.balanceMinor.toString(),
    };
  });

  app.get('/v1/accounts/:id/entries', async (request) => {
    const { id } = accountParams.parse(request.params);
    const query = listQuery.parse(request.query);
    return ledger.listEntries(id, { limit: query.limit, cursor: query.cursor ?? null });
  });

  app.post('/v1/transfers', async (request, reply) => {
    const idempotencyKey = readIdempotencyKey(request);
    const body = transferBody.parse(request.body);

    const result = await ledger.transfer({
      idempotencyKey,
      fromAccountId: body.fromAccountId,
      toAccountId: body.toAccountId,
      amountMinor: parseAmount(body.amount, body.currency),
      currency: body.currency,
      correlationId: body.correlationId ?? null,
    });

    return reply
      .header('idempotency-replayed', String(result.replayed))
      .status(result.replayed ? 200 : 201)
      .send(result.entry);
  });

  return app;
}

function readIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers['idempotency-key'];

  if (typeof header !== 'string' || header.trim().length === 0) {
    throw new DomainError(
      'INVALID_REQUEST',
      'Missing required Idempotency-Key header',
    );
  }

  if (header.length > 255) {
    throw new DomainError('INVALID_REQUEST', 'Idempotency-Key must be 255 characters or fewer');
  }

  return header;
}

function parseAmount(amount: string, currency: string): bigint {
  return parseMinor(amount, currency).minor;
}

function serializeAccount(account: {
  id: string;
  ownerId: string;
  currency: string;
  kind: string;
  allowNegative: boolean;
  createdAt: Date;
}) {
  return {
    id: account.id,
    ownerId: account.ownerId,
    currency: account.currency,
    kind: account.kind,
    allowNegative: account.allowNegative,
    createdAt: account.createdAt.toISOString(),
  };
}

function statusFor(code: DomainError['code']): number {
  switch (code) {
    case 'ACCOUNT_NOT_FOUND':
      return 404;
    case 'INSUFFICIENT_FUNDS':
    case 'CURRENCY_MISMATCH':
    case 'SAME_ACCOUNT':
    case 'UNBALANCED_ENTRY':
    case 'SINGLE_POSTING':
      return 422;
    default:
      return 400;
  }
}
