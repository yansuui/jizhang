import { createRouteServices, type TenantContextManager } from '../tenancy/context.js';
/**
 * Statistics routes (T8 PRD R1, C3 F06/F07):
 *
 *   GET /api/v1/stats/window          `?kind=month|last30&month=&timeZone=`  the real range
 *   GET /api/v1/stats/category-share  `?from=&to=`   per-category gross expense + refund income
 *   GET /api/v1/stats/monthly-trend   `?months=&endMonth=`  income + gross expense per month
 *   GET /api/v1/stats/pool-trend                      carryover pool over time
 *   GET /api/v1/stats/range                           earliest/latest activity
 *   GET /api/v1/stats/month-window    `?monthStart=`  calendar bounds of one month
 *
 * Every figure comes from `StatsService`, which in turn uses the shared accounting
 * rules — the routes do no arithmetic of their own. The date windows come from the
 * shared `resolveStatsWindow`, so the client never has to guess "30 days" or "next
 * month's first midnight" from the device clock.
 *
 * Registered inside the auth module, so the guard covers all of it.
 */
import { StatsWindowInputError, resolveStatsWindow } from '@jizhang/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/index.js';
import { StatsService } from '../services/stats-service.js';
import { ValidationError } from '../services/transaction-service.js';

export interface StatsRoutesOptions {
  readonly tenants?: TenantContextManager | undefined;
  readonly db: Db;
  readonly now?: (() => number) | undefined;
  /**
   * Explicit IANA time zone used when the request does not name one. Defaults to the
   * server's own zone (the same source `FinancialPlanningConfigService` uses), never to
   * a fixed offset: a wrong zone would shift month boundaries for a real user.
   */
  readonly timeZone?: string | undefined;
}

/** Local midnight helpers mirroring the shared engine's convention. */
function startOfMonth(epochMs: number): number {
  const date = new Date(epochMs);
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

function startOfNextMonth(epochMs: number): number {
  const date = new Date(epochMs);
  return new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime();
}

/** The server's IANA zone; `UTC` only when the runtime cannot report one. */
function serverTimeZone(options: StatsRoutesOptions): string {
  if (options.timeZone !== undefined && options.timeZone !== '') return options.timeZone;
  const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  return typeof zone === 'string' && zone !== '' ? zone : 'UTC';
}

/** Query values arrive as `string | string[] | undefined`; only one string is acceptable. */
function optionalString(raw: unknown, field: string): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string') {
    throw new ValidationError(`${field} must be a single value.`);
  }
  return raw;
}

export async function registerStatsRoutes(
  app: FastifyInstance,
  options: StatsRoutesOptions,
): Promise<void> {
  const getServices = createRouteServices(app, options, (options, _lifecycle) => {
    const service = new StatsService(options.db, options);

    // The authoritative range for every "本月 / 近30天" label. Clients pass the returned
    // from/to straight to category-share and the drilldown, so the numbers and the caption
    // cannot disagree. Invalid input is a 400 — never a silent fallback to a guessed range.

    return { service, options };
  });

  app.get('/api/v1/stats/window', async (request: FastifyRequest, reply: FastifyReply) => {
      const { options } = getServices(request);
    const query = (request.query ?? {}) as Record<string, unknown>;

    const rawKind = query['kind'];
    if (rawKind !== 'month' && rawKind !== 'last30') {
      throw new ValidationError("kind must be 'month' or 'last30'.");
    }
    let month = optionalString(query['month'], 'month') ?? null;
    const timeZone = optionalString(query['timeZone'], 'timeZone') ?? serverTimeZone(options);
    const nowMs = options.now?.() ?? Date.now();

    try {
      if (rawKind === 'month' && month === null) {
        // Default current month comes from the same captured server clock and zone.
        const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(nowMs);
        month = `${parts.find((part) => part.type === 'year')?.value}-${parts.find((part) => part.type === 'month')?.value}`;
      }
      return reply.send(resolveStatsWindow(rawKind, month, nowMs, timeZone));
    } catch (error) {
      // The shared rule is the single owner of month/timeZone validation; map its
      // rejection onto the API's 400 contract instead of duplicating the checks here.
      if (error instanceof StatsWindowInputError || error instanceof RangeError) throw new ValidationError(error.message);
      throw error;
    }
  });

  app.get(
    '/api/v1/stats/category-share',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { options, service } = getServices(request);
      const query = (request.query ?? {}) as Record<string, unknown>;

      const rawFrom = query['from'];
      const rawTo = query['to'];
      const parseInstant = (raw: unknown, fallback: number): number => {
        if (raw === undefined) return fallback;
        if (typeof raw !== 'string' || !/^-?\d+$/.test(raw)) {
          throw new ValidationError('from/to must be epoch-millisecond integers.');
        }
        const value = Number(raw);
        if (!Number.isSafeInteger(value) || Math.abs(value) > 8_640_000_000_000_000) {
          throw new ValidationError('from/to exceed the supported timestamp range.');
        }
        return value;
      };
      const parseId = (raw: unknown): string | undefined => {
        if (raw === undefined) return undefined;
        if (typeof raw !== 'string' || raw.trim() === '' || raw.length > 128) {
          throw new ValidationError('accountId/categoryId must be single non-empty exact IDs.');
        }
        return raw;
      };

      // Default to the same rolling 30-day window `/stats/window?kind=last30` reports,
      // so an unspecified range is still a truthful "近30天 … 截至现在" (the old upper
      // bound was the first instant of NEXT month, i.e. a range that ran into the future).
      const nowMs = options.now?.() ?? Date.now();
      const fallback = resolveStatsWindow('last30', null, nowMs, serverTimeZone(options));
      const from = parseInstant(rawFrom, fallback.from);
      const to = parseInstant(rawTo, fallback.to);
      const accountId = parseId(query['accountId']);
      const categoryId = parseId(query['categoryId']);
      return reply.send(service.categoryShare(from, to, {
        ...(accountId === undefined ? {} : { accountId }),
        ...(categoryId === undefined ? {} : { categoryId }),
      }));
    },
  );

  app.get(
    '/api/v1/stats/monthly-trend',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { service } = getServices(request);
      const query = (request.query ?? {}) as Record<string, unknown>;
      const raw = query['months'];
      const months = raw === undefined || raw === '' ? 6 : Number(raw);

      if (!Number.isFinite(months)) {
        throw new ValidationError('months must be a number.');
      }

      // `endMonth` anchors a historical trend (`YYYY-MM`). Omitting it keeps the original
      // "ending with the current month" behaviour; the response carries the range it
      // actually covers so the caption is not an assumption.
      const endMonth = optionalString(query['endMonth'], 'endMonth') ?? null;

      return reply.send(service.monthlyTrendSeries(months, endMonth));
    },
  );

  app.get('/api/v1/stats/pool-trend', async (_request: FastifyRequest, reply: FastifyReply) => {
      const { service } = getServices(_request);
    return reply.send(service.poolTrend());
  });

  app.get('/api/v1/stats/range', async (_request: FastifyRequest, reply: FastifyReply) => {
      const { service } = getServices(_request);
    return reply.send(service.availableRange());
  });

  // Convenience helper for the chart range picker: the bounds of a given month.
  app.get('/api/v1/stats/month-window', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const raw = query['monthStart'];
    const anchor = raw === undefined || raw === '' ? Date.now() : Number(raw);
    if (!Number.isFinite(anchor)) {
      throw new ValidationError('monthStart must be an epoch-millisecond timestamp.');
    }
    return reply.send({
      from: startOfMonth(anchor),
      to: startOfNextMonth(anchor),
    });
  });
}
