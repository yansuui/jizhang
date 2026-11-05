import { createRouteServices, type TenantContextManager } from '../tenancy/context.js';
/**
 * Budget, salary and template routes (T6 PRD R1/R5).
 *
 *   GET    /api/v1/budget/overview     module views + carryover pool
 *   GET    /api/v1/salaries            list
 *   GET    /api/v1/salaries/:id        detail incl. allocation
 *   POST   /api/v1/salaries            record a salary (starts a cycle)
 *   PATCH  /api/v1/salaries/:id        edit the record
 *   PUT    /api/v1/salaries/:id/allocations  replace the snapshot
 *   DELETE /api/v1/salaries/:id        soft delete the record AND its allocation
 *   GET    /api/v1/templates           list              (deprecated, see below)
 *   POST   /api/v1/templates           create            (deprecated)
 *   PATCH  /api/v1/templates/:id       edit              (deprecated)
 *   DELETE /api/v1/templates/:id       soft delete       (deprecated, never the default)
 *   POST   /api/v1/templates/:id/default  make it the only default   (deprecated)
 *   POST   /api/v1/templates/:id/apply-current  apply to the newest cycle  (deprecated)
 *   GET/PUT /api/v1/settings           cycle start day
 *
 *   GET    /api/v1/financial-plan          the saved four-purpose plan (or null)
 *   POST   /api/v1/financial-plan/preview  recompute an unsaved analysis (no writes)
 *   PUT    /api/v1/financial-plan          save with revision CAS
 *
 * `/budget/overview` is the only place the envelope arithmetic is exposed, and it
 * delegates entirely to `@jizhang/shared`'s engine — the server never re-derives
 * net expense or carryover itself (design.md §5).
 *
 * The financial-plan routes are an independent domain: they read and write exactly one
 * `settings` key and nothing else (see `services/financial-plan-service.ts`).
 *
 * Registered inside the auth module, so the guard applies to all of it.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/index.js';
import { requireUserId } from '../plugins/auth.js';
import {
  CYCLE_START_DAY_KEY,
  MAX_CYCLE_START_DAY,
  MIN_CYCLE_START_DAY,
  SalaryService,
} from '../services/salary-service.js';
import { BudgetOverviewService } from '../services/budget-overview-service.js';
import { FinancialPlanService } from '../services/financial-plan-service.js';
import { TemplateService } from '../services/template-service.js';
import { ValidationError } from '../services/transaction-service.js';

interface IdParams {
  id?: string;
}

function requireId(request: FastifyRequest): string {
  const id = (request.params as IdParams).id;
  if (typeof id !== 'string' || id.trim() === '') {
    throw new ValidationError('An id is required.');
  }
  return id;
}

export interface BudgetRoutesOptions {
  readonly tenants?: TenantContextManager | undefined;
  readonly db: Db;
  readonly now?: (() => number) | undefined;
  readonly serverTimeZone?: string | undefined;
}

export async function registerBudgetRoutes(
  app: FastifyInstance,
  options: BudgetRoutesOptions,
): Promise<void> {
  const getServices = createRouteServices(app, options, (options, _lifecycle) => {
    const { db } = options;
    const salaries = new SalaryService(db, options);
    const templates = new TemplateService(db, options);
    const overviewService = new BudgetOverviewService(db, options);
    const financialPlans = new FinancialPlanService(db, options);

    /**
     * Parses `?periodStart=`.
     *
     * Absent and `''` both mean "the current cycle", matching how the stats routes treat
     * their optional window parameters. Anything present must be a finite integer.
     *
     * Validation happens here; whether the value names a REAL cycle is checked against
     * `listCycleStarts` by the caller, because "not a number" and "a number naming no
     * cycle" deserve the same 400 but for different reasons.
     */
    function parsePeriodStart(query: Record<string, unknown>): number | undefined {
      const raw = query['periodStart'];
      if (raw === undefined || raw === '') return undefined;
      const value = Number(raw);
      if (!Number.isFinite(value) || !Number.isInteger(value)) {
        throw new ValidationError(
          'periodStart must be an epoch-millisecond timestamp of a known budget cycle.',
        );
      }
      return value;
    }

    // ── budget overview ────────────────────────────────────────────────────────

    return { db, salaries, templates, overviewService, financialPlans, parsePeriodStart, options };
  });

  app.get('/api/v1/budget/overview', async (request: FastifyRequest, reply: FastifyReply) => {
      const { parsePeriodStart, overviewService } = getServices(request);
    const requested = parsePeriodStart((request.query ?? {}) as Record<string, unknown>);
    return reply.send(overviewService.overview(requested));
  });

  // ── which cycles can be reviewed ───────────────────────────────────────────
  // A separate endpoint rather than extra fields on the overview: the overview must
  // answer byte-identically when no period is requested, so that every existing caller
  // and test keeps its exact contract.
  app.get('/api/v1/budget/periods', async (_request: FastifyRequest, reply: FastifyReply) => {
      const { overviewService } = getServices(_request);
    return reply.send(overviewService.periods());
  });

  // ── salaries ───────────────────────────────────────────────────────────────
  app.get('/api/v1/salaries', async (_request: FastifyRequest, reply: FastifyReply) => {
      const { salaries } = getServices(_request);
    return reply.send({ items: salaries.list() });
  });

  app.get('/api/v1/salaries/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const { salaries } = getServices(request);
    return reply.send(salaries.getByIdOrThrow(requireId(request)));
  });

  app.post('/api/v1/salaries', async (request: FastifyRequest, reply: FastifyReply) => {
      const { salaries } = getServices(request);
    const created = salaries.create((request.body ?? {}) as Record<string, unknown>, { actorId: requireUserId(request) });
    return reply.status(201).send(created);
  });

  app.patch('/api/v1/salaries/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const { salaries } = getServices(request);
    const updated = salaries.update(
      requireId(request),
      (request.body ?? {}) as Record<string, unknown>,
      { actorId: requireUserId(request) },
    );
    return reply.send(updated);
  });

  app.put(
    '/api/v1/salaries/:id/allocations',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { salaries } = getServices(request);
      const body = (request.body ?? {}) as Record<string, unknown>;
      return reply.send(salaries.replaceAllocations(requireId(request), body['allocations']));
    },
  );

  app.delete('/api/v1/salaries/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const { salaries } = getServices(request);
    salaries.softDelete(requireId(request), (request.body ?? {}) as Record<string, unknown>, { actorId: requireUserId(request) });
    return reply.status(204).send();
  });

  // ── templates (DEPRECATED) ─────────────────────────────────────────────────
  //
  // The allocation-template surface is retired in favour of ordinary bill tags:
  // migration 022 folds every template name into `tags`, and the iOS client no
  // longer exposes an entry point. Reading remains available for older clients;
  // mutation routes explicitly return 410 so they cannot create new allocations.
  // The list retains its items and adds a deprecation flag.
  const deprecated = (reply: FastifyReply): void => {
    reply.header('Deprecation', 'true');
    reply.header('Link', '</api/v1/tags>; rel="successor-version"');
  };

  app.get('/api/v1/templates', async (_request: FastifyRequest, reply: FastifyReply) => {
      const { templates } = getServices(_request);
    deprecated(reply);
    return reply.send({ items: templates.list(), deprecated: true });
  });

  // Shipped clients can inspect old templates, but creating, editing or applying
  // allocations is intentionally retired. No historical allocation rows are modified.
  const retired = (reply: FastifyReply) => {
    deprecated(reply);
    return reply.status(410).send({ error: { code: 'TEMPLATE_RETIRED', message: '分配模板已停用，请改用标签。' } });
  };
  app.post('/api/v1/templates', async (_request: FastifyRequest, reply: FastifyReply) => retired(reply));
  app.patch('/api/v1/templates/:id', async (_request: FastifyRequest, reply: FastifyReply) => retired(reply));
  app.delete('/api/v1/templates/:id', async (_request: FastifyRequest, reply: FastifyReply) => retired(reply));
  app.post('/api/v1/templates/:id/default', async (_request: FastifyRequest, reply: FastifyReply) => retired(reply));
  app.post('/api/v1/templates/:id/apply-current', async (_request: FastifyRequest, reply: FastifyReply) => retired(reply));

  // ── settings ───────────────────────────────────────────────────────────────
  app.get('/api/v1/settings', async (_request: FastifyRequest, reply: FastifyReply) => {
      const { salaries } = getServices(_request);
    const day = salaries.getCycleStartDay();
    return reply.send({
      cycleStartDay: day ?? null,
      minCycleStartDay: MIN_CYCLE_START_DAY,
      maxCycleStartDay: MAX_CYCLE_START_DAY,
      key: CYCLE_START_DAY_KEY,
    });
  });

  app.put('/api/v1/settings', async (request: FastifyRequest, reply: FastifyReply) => {
      const { salaries } = getServices(request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const raw = body['cycleStartDay'];

    let day: number | null;
    if (raw === null || raw === undefined || raw === '') {
      day = null;
    } else if (typeof raw === 'number') {
      day = raw;
    } else {
      throw new ValidationError('cycleStartDay must be a number or null.');
    }

    const applied = salaries.setCycleStartDay(day);
    return reply.send({ cycleStartDay: applied ?? null });
  });

  // ── financial plan (independent domain, one settings key) ──────────────────
  // Three thin handlers: validation, arithmetic and persistence all live in
  // `FinancialPlanService`; nothing here re-derives money.

  app.get('/api/v1/financial-plan', async (_request: FastifyRequest, reply: FastifyReply) => {
      const { financialPlans } = getServices(_request);
    // `null` is a real answer meaning "never saved", distinct from the 503 a corrupt
    // envelope produces. The client must not conflate the two (see contract.md).
    return reply.send({ plan: financialPlans.get() });
  });

  app.post(
    '/api/v1/financial-plan/preview',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { financialPlans } = getServices(request);
      // Explicit POST (a body is needed) but read-only: no settings row is touched.
      return reply.send({ analysis: financialPlans.preview(request.body) });
    },
  );

  app.put('/api/v1/financial-plan', async (request: FastifyRequest, reply: FastifyReply) => {
      const { financialPlans } = getServices(request);
    return reply.send({ plan: financialPlans.save(request.body) });
  });
}
