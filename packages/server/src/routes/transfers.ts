import { createRouteServices, type TenantContextManager } from '../tenancy/context.js';
/**
 * Transfer routes (child task `09-13-account-transfer`).
 *
 *   GET    /api/v1/transfers              list (`?accountId=&limit=&offset=`)
 *   POST   /api/v1/transfers              create
 *   GET    /api/v1/transfers/:id          read
 *   PATCH  /api/v1/transfers/:id          edit
 *   DELETE /api/v1/transfers/:id          soft delete
 *
 * A transfer is neither income nor expense — see the service and migration 004. Nothing here
 * touches the budget or the statistics; there is no endpoint to make it do so.
 *
 * Registered inside the auth module (`app.ts` `extraRoutes`), so the guard covers all of it.
 * That registration is one line and its absence is invisible: the five endpoints would work
 * perfectly and be world-readable. `e2e-transfers.mjs` asserts all five answer 401 without a
 * session for exactly that reason.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/index.js';
import {
  MAX_TRANSFER_PAGE_SIZE,
  TransferService,
  type ListTransfersQuery,
} from '../services/transfer-service.js';
import { ValidationError } from '../services/transaction-service.js';

interface IdParams {
  id?: string;
}

function requireId(request: FastifyRequest): string {
  const params = request.params as IdParams;
  const id = params.id;
  if (typeof id !== 'string' || id.trim() === '') {
    throw new ValidationError('A transfer id is required.');
  }
  return id;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseListQuery(query: Record<string, unknown>): ListTransfersQuery {
  const limit = optionalNumber(query['limit']);
  if (limit !== undefined && (limit < 1 || limit > MAX_TRANSFER_PAGE_SIZE)) {
    throw new ValidationError(`limit must be between 1 and ${MAX_TRANSFER_PAGE_SIZE}.`);
  }
  const offset = optionalNumber(query['offset']);
  if (offset !== undefined && offset < 0) {
    throw new ValidationError('offset must not be negative.');
  }

  const rawAccountId = query['accountId'];
  const accountId =
    typeof rawAccountId === 'string' && rawAccountId.trim() !== ''
      ? rawAccountId
      : undefined;

  return { accountId, limit, offset };
}

export interface TransferRoutesOptions {
  readonly tenants?: TenantContextManager | undefined;
  readonly db: Db;
  readonly now?: (() => number) | undefined;
}

export async function registerTransferRoutes(
  app: FastifyInstance,
  options: TransferRoutesOptions,
): Promise<void> {
  const getServices = createRouteServices(app, options, (options, _lifecycle) => {
    const transfers = new TransferService(options.db, options);

    return { transfers, options };
  });

  app.get('/api/v1/transfers', async (request: FastifyRequest, reply: FastifyReply) => {
      const { transfers } = getServices(request);
    const query = parseListQuery((request.query ?? {}) as Record<string, unknown>);
    return reply.send(transfers.list(query));
  });

  app.post('/api/v1/transfers', async (request: FastifyRequest, reply: FastifyReply) => {
      const { transfers } = getServices(request);
    const created = transfers.create((request.body ?? {}) as Record<string, unknown>);
    return reply.status(201).send(created);
  });

  app.get('/api/v1/transfers/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const { transfers } = getServices(request);
    return reply.send(transfers.getByIdOrThrow(requireId(request)));
  });

  app.patch('/api/v1/transfers/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const { transfers } = getServices(request);
    const updated = transfers.update(
      requireId(request),
      (request.body ?? {}) as Record<string, unknown>,
    );
    return reply.send(updated);
  });

  app.delete('/api/v1/transfers/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const { transfers } = getServices(request);
    transfers.softDelete(requireId(request));
    return reply.status(204).send();
  });
}
