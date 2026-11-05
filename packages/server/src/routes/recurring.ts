import { createRouteServices, type TenantContextManager } from '../tenancy/context.js';
/**
 * Recurring-bill routes (T13 PRD R1–R3).
 *
 *   GET    /api/v1/recurring/rules                       list
 *   POST   /api/v1/recurring/rules                       create
 *   PATCH  /api/v1/recurring/rules/:id                   edit
 *   DELETE /api/v1/recurring/rules/:id                   soft delete (+ its pending items)
 *   POST   /api/v1/recurring/rules/:id/enabled           enable / disable
 *   POST   /api/v1/recurring/generate                    materialise due occurrences
 *   GET    /api/v1/recurring/occurrences                 all occurrences, newest first
 *   GET    /api/v1/recurring/pending                     only the undecided ones
 *   POST   /api/v1/recurring/occurrences/:id/confirm      turn one into a real bill
 *   POST   /api/v1/recurring/occurrences/:id/ignore       skip it, creating nothing
 *
 * ## Why generation is an explicit POST
 *
 * The frontend calls it when the dashboard or the pending list mounts. It is not folded
 * into `GET /pending` because a read with a write side effect turns every retry, prefetch
 * and concurrent read into a write. It is not a scheduled job either: this is a
 * single-container app on a 1 GB VPS, and a rule's due date is evaluated against the
 * server's clock, which only moves in one direction.
 *
 * Registered inside the auth module (see `app.ts`), so the guard covers all of it — the
 * mistake that once left protected routes wide open while every unit test passed is why
 * `test/recurring.test.ts` asserts a 401 on each endpoint individually.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/index.js';
import { RecurringService } from '../services/recurring-service.js';
import { NotFoundError } from '../services/transaction-service.js';

export interface RecurringRoutesOptions {
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
    throw new NotFoundError('A recurring id is required.');
  }
  return id;
}

export async function registerRecurringRoutes(
  app: FastifyInstance,
  options: RecurringRoutesOptions,
): Promise<void> {
  const getServices = createRouteServices(app, options, (options, _lifecycle) => {
    const service = new RecurringService(
      options.db,
    options,
    );

    // ── rules ──────────────────────────────────────────────────────────────────

    return { service, options };
  });

  app.get('/api/v1/recurring/rules', async (_request: FastifyRequest, reply: FastifyReply) => {
      const { service } = getServices(_request);
    return reply.send({ items: service.listRules() });
  });

  app.post('/api/v1/recurring/rules', async (request: FastifyRequest, reply: FastifyReply) => {
      const { service } = getServices(request);
    const created = service.createRule((request.body ?? {}) as Record<string, unknown>);
    return reply.status(201).send(created);
  });

  app.patch(
    '/api/v1/recurring/rules/:id',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { service } = getServices(request);
      const updated = service.updateRule(
        requireId(request),
        (request.body ?? {}) as Record<string, unknown>,
      );
      return reply.send(updated);
    },
  );

  app.delete(
    '/api/v1/recurring/rules/:id',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { service } = getServices(request);
      service.deleteRule(requireId(request));
      return reply.status(204).send();
    },
  );

  // A dedicated path rather than a generic PATCH: toggling is the one edit that also
  // moves the generation cursor, so it is clearer named than inferred from a body field.
  app.post(
    '/api/v1/recurring/rules/:id/enabled',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { service } = getServices(request);
      const body = (request.body ?? {}) as Record<string, unknown>;
      const enabled = body['enabled'];
      if (typeof enabled !== 'boolean') {
        return reply.status(400).send({
          error: { code: 'VALIDATION', message: 'enabled must be a boolean.' },
        });
      }
      return reply.send(service.setRuleEnabled(requireId(request), enabled));
    },
  );

  // ── generation ─────────────────────────────────────────────────────────────
  // A static segment, so it cannot be confused with `rules/:id`. The e2e suite asserts
  // each path reaches its own handler rather than trusting the router's precedence.
  app.post('/api/v1/recurring/generate', async (_request: FastifyRequest, reply: FastifyReply) => {
      const { service } = getServices(_request);
    const result = service.generateDue();
    return reply.send({ ...result, pending: service.listPending().length });
  });

  // ── occurrences ────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/recurring/occurrences',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const { service } = getServices(_request);
      return reply.send({ items: service.listOccurrences() });
    },
  );

  app.get('/api/v1/recurring/pending', async (_request: FastifyRequest, reply: FastifyReply) => {
      const { service } = getServices(_request);
    const items = service.listPending();
    return reply.send({ items, total: items.length });
  });

  app.post(
    '/api/v1/recurring/occurrences/:id/confirm',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { service } = getServices(request);
      // `created: false` means the occurrence was already confirmed and the bill it
      // produced is being returned — not that a second bill was made.
      return reply.send(service.confirmOccurrence(requireId(request)));
    },
  );

  app.post(
    '/api/v1/recurring/occurrences/:id/ignore',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { service } = getServices(request);
      return reply.send(service.ignoreOccurrence(requireId(request)));
    },
  );
}
