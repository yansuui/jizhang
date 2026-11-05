import { createRouteServices, type TenantContextManager } from '../tenancy/context.js';
/**
 * Transaction routes (T4 PRD R2):
 *
 *   GET    /api/v1/transactions        list + filter + paginate
 *   GET    /api/v1/transactions/:id    one row
 *   POST   /api/v1/transactions        create
 *   PATCH  /api/v1/transactions/:id    partial update
 *   DELETE /api/v1/transactions/:id    soft delete
 *
 * These are registered INSIDE the auth module so the guard's hooks apply to them
 * (see `.trellis/spec/backend/directory-structure.md` — registering routes as a
 * sibling of the guard silently leaves them unprotected).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/index.js';
import {
  MAX_PAGE_SIZE,
  NotFoundError,
  TransactionService,
  ValidationError,
  type ListTransactionsQuery,
} from '../services/transaction-service.js';

export interface TransactionRoutesOptions {
  readonly actorId?: string | undefined;
  readonly tenants?: TenantContextManager | undefined;
  readonly db: Db;
  readonly now?: (() => number) | undefined;
}

/** Query params arrive as strings; parse the numeric ones defensively. */
function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return value;
}

/** Strict extra guards are only used by stats drilldown; malformed inputs never disappear. */
function optionalExpectedInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new ValidationError(`${field} must be a non-negative safe integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ValidationError(`${field} must be a non-negative safe integer.`);
  return parsed;
}

function parseListQuery(query: Record<string, unknown>): ListTransactionsQuery {
  const type = optionalNumber(query['type']);
  if (type !== undefined && type !== 0 && type !== 1) {
    throw new ValidationError('type must be 0 (expense) or 1 (income).');
  }

  const limit = optionalNumber(query['limit']);
  if (limit !== undefined && (limit < 1 || limit > MAX_PAGE_SIZE)) {
    throw new ValidationError(`limit must be between 1 and ${MAX_PAGE_SIZE}.`);
  }

  const offset = optionalNumber(query['offset']);
  if (offset !== undefined && offset < 0) {
    throw new ValidationError('offset must not be negative.');
  }

  const tag = optionalString(query['tag']);
  const tagId = optionalString(query['tagId']);
  if (tag !== undefined && tagId !== undefined) throw new ValidationError('tag and tagId cannot be used together.');
  const from = optionalNumber(query['from']);
  const to = optionalNumber(query['to']);
  const categoryId = optionalString(query['categoryId']);
  const accountId = optionalString(query['accountId']);
  const q = optionalString(query['q']);
  const search = optionalString(query['search']);
  const includeDeleted = query['includeDeleted'] === 'true' || query['includeDeleted'] === true;
  const expectedExpenseCents = optionalExpectedInteger(query['expectedExpenseCents'], 'expectedExpenseCents');
  const expectedExpenseCount = optionalExpectedInteger(query['expectedExpenseCount'], 'expectedExpenseCount');
  if ((expectedExpenseCents === undefined) !== (expectedExpenseCount === undefined)) {
    throw new ValidationError('expectedExpenseCents and expectedExpenseCount must be supplied together.');
  }
  if (expectedExpenseCents !== undefined) {
    if (
      type !== 0 || categoryId === undefined || includeDeleted ||
      from === undefined || to === undefined || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from >= to ||
      tag !== undefined || tagId !== undefined || q !== undefined || search !== undefined
    ) {
      throw new ValidationError('Expense total guards require an exact live expense category/date scope without other filters.');
    }
  }

  return {
    from,
    to,
    type,
    categoryId,
    accountId,
    tag,
    tagId,
    q,
    search,
    includeDeleted,
    limit,
    offset,
    expectedExpenseCents,
    expectedExpenseCount,
  };
}

interface IdParams {
  id?: string;
}

function requireId(request: FastifyRequest): string {
  const params = request.params as IdParams;
  const id = params.id;
  if (typeof id !== 'string' || id.trim() === '') {
    throw new ValidationError('A transaction id is required.');
  }
  return id;
}

export async function registerTransactionRoutes(
  app: FastifyInstance,
  options: TransactionRoutesOptions,
): Promise<void> {
  const getServices = createRouteServices(app, options, (options, _lifecycle) => {
    const service = new TransactionService(
      options.db,
    options,
    );

    return { service, options };
  });

  app.get(
    '/api/v1/transactions',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { service } = getServices(request);
      const query = parseListQuery((request.query ?? {}) as Record<string, unknown>);
      return reply.send(service.list(query));
    },
  );

  app.get(
    '/api/v1/transactions/daily-summary',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { service } = getServices(request);
      const raw = (request.query ?? {}) as Record<string, unknown>;
      // Summary scope is independent of paging, even when paging values are invalid.
      const query = parseListQuery({ ...raw, limit: undefined, offset: undefined });
      return reply.send(service.dailySummary({ ...query, timeZone: optionalString(raw['timeZone']) }));
    },
  );

  app.get(
    '/api/v1/transactions/:id',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { service } = getServices(request);
      const found = service.getById(requireId(request));
      if (found === undefined) throw new NotFoundError();
      return reply.send(found);
    },
  );

  app.post(
    '/api/v1/transactions',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { service } = getServices(request);
      const created = service.create((request.body ?? {}) as Record<string, unknown>);
      return reply.status(201).send(created);
    },
  );

  app.patch(
    '/api/v1/transactions/:id',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { service } = getServices(request);
      const updated = service.update(
        requireId(request),
        (request.body ?? {}) as Record<string, unknown>,
      );
      return reply.send(updated);
    },
  );

  app.delete(
    '/api/v1/transactions/:id',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { service } = getServices(request);
      service.softDelete(requireId(request));
      return reply.status(204).send();
    },
  );

  // `GET /api/v1/tags` is NOT registered here: the vocabulary, its rename and its
  // delete live together in routes/master-data.ts (T7). Registering it in both
  // places makes Fastify reject the whole app with
  // "Method 'GET' already declared for route '/api/v1/tags'".
}
