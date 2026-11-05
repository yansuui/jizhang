import { createRouteServices, type TenantContextManager } from '../tenancy/context.js';
/**
 * Recycle-bin routes (T12 PRD R1–R3).
 *
 *   GET    /api/v1/trash              deleted bills only, most recently deleted first
 *   POST   /api/v1/trash/:id/restore  put one back (idempotent)
 *   DELETE /api/v1/trash/:id          permanently delete one (trash rows only)
 *   POST   /api/v1/trash/restore-all  put everything back
 *   DELETE /api/v1/trash              empty the bin
 *
 * ## Why this exists instead of a flag on `/transactions`
 *
 * `GET /transactions?includeDeleted=true` returns deleted AND live rows, and
 * `TransactionDto` carries no `deleted` field, so a client could not tell them apart.
 * Rather than add a discriminator to a response that 45 e2e checks and the whole list
 * page depend on, the trash gets its own read path whose contract is unambiguous: every
 * row it returns is deleted. That makes "the trash never shows a live bill" a
 * structural property instead of a convention someone has to remember.
 *
 * ## Why the bulk operations are named endpoints rather than `{ ids }`
 *
 * The two bulk actions are "restore everything" and "empty the bin". Accepting an id
 * list would drag in "what does an empty array mean?" — a question whose wrong answer
 * deletes the wrong set. A named destructive endpoint has to be asked for by name.
 *
 * Registered inside the auth module (see `app.ts`), so the guard applies to all of it.
 * That is not a formality: registering these as a sibling of the guard is the mistake
 * that once left protected routes completely unauthenticated while every unit test
 * still passed, so `test/trash.test.ts` asserts a 401 on each of the five.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/index.js';
import { NotFoundError, TransactionService } from '../services/transaction-service.js';

export interface TrashRoutesOptions {
  readonly actorId?: string | undefined;
  readonly tenants?: TenantContextManager | undefined;
  readonly db: Db;
  readonly now?: (() => number) | undefined;
}

interface IdParams {
  id?: string;
}

function requireId(request: FastifyRequest): string {
  const params = request.params as IdParams;
  const id = params.id;
  if (typeof id !== 'string' || id.trim() === '') {
    throw new NotFoundError('A transaction id is required.');
  }
  return id;
}

export async function registerTrashRoutes(
  app: FastifyInstance,
  options: TrashRoutesOptions,
): Promise<void> {
  const getServices = createRouteServices(app, options, (options, _lifecycle) => {
    const service = new TransactionService(
      options.db,
    options,
    );

    return { service, options };
  });

  app.get('/api/v1/trash', async (_request: FastifyRequest, reply: FastifyReply) => {
      const { service } = getServices(_request);
    const items = service.listDeleted();
    return reply.send({ items, total: service.countDeleted() });
  });

  // Registered before `/:id` deliberately. Fastify's router prefers a static segment
  // over a parameter, but relying on that unverified would be a guess; `test/trash.test.ts`
  // asserts this path reaches the bulk handler rather than being read as an id.
  app.post(
    '/api/v1/trash/restore-all',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const { service } = getServices(_request);
      const restored = service.restoreAll();
      return reply.send({ restored, remaining: service.countDeleted() });
    },
  );

  app.post(
    '/api/v1/trash/:id/restore',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { service } = getServices(request);
      return reply.send(service.restore(requireId(request)));
    },
  );

  app.delete('/api/v1/trash/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const { service } = getServices(request);
    service.purge(requireId(request));
    return reply.status(204).send();
  });

  app.delete('/api/v1/trash', async (_request: FastifyRequest, reply: FastifyReply) => {
      const { service } = getServices(_request);
    const purged = service.purgeAll();
    return reply.send({ purged, remaining: service.countDeleted() });
  });
}
