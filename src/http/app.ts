import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
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

/** RFC 9457 problem document carried by the rate limiter's thrown error. */
interface RateLimitProblem {
  type: string;
  status: number;
  title: string;
  detail: string;
  retryAfter: number;
}

export interface AppOptions {
  logger?: boolean;
}

export async function buildApp(
  ledger: LedgerService,
  options: AppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });

  // Plugins MUST be awaited before the routes below: @fastify/rate-limit
  // attaches via an onRoute hook, so a route declared before the plugin
  // boots silently escapes the limiter (verified: void-register → 0/5
  // blocked, await-register → 3/5 blocked).
  await app.register(helmet);

  // Rate limiting: in-memory counters are correct for a single process
  // (our deploy shape: one Fastify instance behind Neon's pooler). If this
  // ever scales to N instances, the limiter must move to a shared store —
  // in-memory would become max × instances.
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    // Load balancers and Neon probes hit /healthz constantly; it returns
    // a constant and is not worth a budget.
    allowList: (request) => request.url === '/healthz',
    errorResponseBuilder: (_request, context) => {
      const retryAfter = Math.ceil(context.ttl / 1000);
      // The limiter does NOT reply on its own: it THROWS whatever this
      // builder returns (see @fastify/rate-limit/index.js), and our error
      // handler receives the value as-is. It must therefore be an Error
      // carrying statusCode — a plain object has no status and collapses
      // into a generic 500 (verified live: 500 instead of 429).
      return Object.assign(new Error(`Rate limit exceeded, retry after ${retryAfter}s`), {
        statusCode: context.statusCode, // 429 (403 only if bans were enabled)
        problem: {
          type: 'https://ledger-core.dev/problems/rate-limited',
          status: context.statusCode,
          title: 'RATE_LIMITED',
          detail: `Too many requests. Retry after ${retryAfter}s.`,
          retryAfter,
        } satisfies RateLimitProblem,
      });
    },
  });

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

    // Rate-limited requests land here because the limiter throws its
    // errorResponseBuilder result instead of replying; forward the attached
    // problem document with its original status rather than masking it.
    const rateLimitProblem = (error as { problem?: RateLimitProblem }).problem;
    if (rateLimitProblem) {
      return reply
        .status(rateLimitProblem.status)
        .type('application/problem+json')
        .send(rateLimitProblem);
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

  app.post(
    '/v1/accounts',
    // Opening accounts is cheaper than moving money, but still write-heavy.
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = openAccountBody.parse(request.body);
      const account = await ledger.openAccount(body);
      return reply.status(201).send(serializeAccount(account));
    },
  );

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

  app.post(
    '/v1/transfers',
    // The money endpoint gets the tightest budget: abuse here drains real
    // balances, and each request costs a pool slot + row locks.
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
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
    },
  );

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
