import { createRouteServices, type TenantContextManager } from '../tenancy/context.js';
/**
 * 财务执行(Phase 1)HTTP 路由:`/api/v1/financial-planning/*`。
 *
 * 这些处理器**只做**三件事:取出参数、调用 `FinancialPlanningService`、回传 DTO。
 * 任何金额算术、CAS 判定、来源令牌比较都在服务层;任何领域错误都以
 * `{ statusCode, code }` 形式抛出,由 `app.ts` 的统一错误处理器渲染。
 *
 * 旧接口不受影响:
 * - `GET/PUT/POST /api/v1/financial-plan`(手动 v1 场景)保持原样;
 * - 旧账本/信封/统计仍是**毛额**口径;
 * - 旧服务器没有这些路由 → 客户端收到 404,按"不支持执行能力"降级。
 *
 * 全部注册在 auth 模块内,所以未登录 401、缺 CSRF 头 403 与其余接口一致。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/index.js';
import { FinancialPlanningService } from '../services/financial-planning-service.js';
import { MonthlyPlanService } from '../services/monthly-plan-service.js';
import { FinancialInvalidError, FinancialNotFoundError } from '../services/financial-errors.js';
import { requireUserId } from '../plugins/auth.js';

export interface FinancialPlanningRoutesOptions {
  readonly tenants?: TenantContextManager | undefined;
  readonly db: Db;
  readonly now?: (() => number) | undefined;
  /** 测试注入的操作者;缺省取单用户表里的唯一用户。 */
  readonly actorId?: string | undefined;
  readonly serverTimeZone?: string | undefined;
}

function requireParam(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, unknown>)[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new FinancialInvalidError(`${name} is required.`);
  }
  return value.trim();
}

function queryObject(request: FastifyRequest): Record<string, unknown> {
  return (request.query ?? {}) as Record<string, unknown>;
}

/** `?revision=` 是可选的正整数;解析不了就是 400,绝不忽略。 */
function optionalRevision(request: FastifyRequest): number | undefined {
  const raw = queryObject(request)['revision'];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new FinancialInvalidError('revision must be a positive integer.');
  }
  return value;
}

export async function registerFinancialPlanningRoutes(
  app: FastifyInstance,
  options: FinancialPlanningRoutesOptions,
): Promise<void> {
  const getServices = createRouteServices(app, options, (options, _lifecycle) => {
    const service = new FinancialPlanningService(options.db, {
      now: options.now,
      actorId: options.actorId,
      serverTimeZone: options.serverTimeZone,
    });

    // 月计划(C2)是**只读**汇总:同一份已确认执行事实的另一个视图,不创建周期、
    // 不改分配。它沿用本模块的 auth 封装与统一错误处理器。
    const monthlyPlanService = new MonthlyPlanService(options.db, {
      now: options.now,
      actorId: options.actorId,
      serverTimeZone: options.serverTimeZone,
    });

    /** `?periodId=` 或 `?month=YYYY-MM`,互斥;都不给 = 包含服务器当前时刻的冻结区间。 */

    return { service, monthlyPlanService, options };
  });

  app.get('/api/v1/monthly-plan', async (request, reply: FastifyReply) => {
      const { monthlyPlanService } = getServices(request);
    const query = queryObject(request);
    return reply.send(
      monthlyPlanService.getMonthlyPlan({
        periodId: query['periodId'],
        month: query['month'],
      }),
    );
  });

  // ── 能力 / 配置 ────────────────────────────────────────────────────────────
  app.get('/api/v1/financial-planning/capabilities', async (_request, reply: FastifyReply) => {
      const { service } = getServices(_request);
    return reply.send(service.capabilities());
  });

  app.get('/api/v1/financial-planning/config', async (_request, reply: FastifyReply) => {
      const { service } = getServices(_request);
    return reply.send(service.getConfig());
  });

  app.put('/api/v1/financial-planning/config', async (request, reply: FastifyReply) => {
      const { service } = getServices(request);
    return reply.send(service.putConfig(request.body));
  });

  // ── 类别映射 ───────────────────────────────────────────────────────────────
  app.get('/api/v1/financial-planning/category-rules', async (_request, reply: FastifyReply) => {
      const { service } = getServices(_request);
    return reply.send(service.getMapping());
  });

  app.put('/api/v1/financial-planning/category-rules', async (request, reply: FastifyReply) => {
      const { service } = getServices(request);
    return reply.send(service.putMapping(request.body));
  });

  // ── 工资来源 ───────────────────────────────────────────────────────────────
  app.get('/api/v1/financial-planning/sources/salaries', async (request, reply: FastifyReply) => {
      const { service } = getServices(request);
    return reply.send(service.listSalarySources(queryObject(request)));
  });

  app.get(
    '/api/v1/financial-planning/sources/salaries/:salaryId',
    async (request, reply: FastifyReply) => {
      const { service } = getServices(request);
      return reply.send(service.getSalarySource(requireParam(request, 'salaryId')));
    },
  );

  // ── 周期 ───────────────────────────────────────────────────────────────────
  app.post('/api/v1/financial-planning/periods/preview', async (request, reply: FastifyReply) => {
      const { service } = getServices(request);
    return reply.send(service.previewPeriod(request.body));
  });

  app.post('/api/v1/financial-planning/periods/confirm', async (request, reply: FastifyReply) => {
      const { service } = getServices(request);
    return reply.send(service.confirmPeriod(request.body));
  });

  app.post(
    '/api/v1/financial-planning/periods/:periodId/reconcile',
    async (request, reply: FastifyReply) => {
      const { service } = getServices(request);
      return reply.send(
        service.reconcilePeriod(requireParam(request, 'periodId'), request.body),
      );
    },
  );

  app.get('/api/v1/financial-planning/periods', async (request, reply: FastifyReply) => {
      const { service } = getServices(request);
    return reply.send(service.listPeriods(queryObject(request)));
  });

  app.get('/api/v1/financial-planning/periods/:periodId', async (request, reply: FastifyReply) => {
      const { service } = getServices(request);
    return reply.send(
      service.getPeriod(requireParam(request, 'periodId'), optionalRevision(request)),
    );
  });

  app.get(
    '/api/v1/financial-planning/periods/:periodId/revisions',
    async (request, reply: FastifyReply) => {
      const { service } = getServices(request);
      return reply.send(
        service.listPeriodRevisions(requireParam(request, 'periodId'), queryObject(request)),
      );
    },
  );

  app.get(
    '/api/v1/financial-planning/periods/:periodId/execution',
    async (request, reply: FastifyReply) => {
      const { service } = getServices(request);
      return reply.send(service.getExecution(requireParam(request, 'periodId')));
    },
  );

  app.get(
    '/api/v1/financial-planning/periods/:periodId/details',
    async (request, reply: FastifyReply) => {
      const { service } = getServices(request);
      return reply.send(
        service.listExecutionFacts(requireParam(request, 'periodId'), queryObject(request)),
      );
    },
  );

  /** 首页/统一入口的规范化读取:当前周期,没有就是 `no-period`。 */
  app.get('/api/v1/financial-planning/execution', async (request, reply: FastifyReply) => {
      const { service } = getServices(request);
    const periodId = queryObject(request)['periodId'];
    return reply.send(
      service.getExecution(
        typeof periodId === 'string' && periodId !== '' ? periodId : undefined,
      ),
    );
  });

  // ── 账单用途 ───────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/financial-planning/bill-purposes/:transactionId',
    async (request, reply: FastifyReply) => {
      const { service } = getServices(request);
      return reply.send(service.getBillPurpose(requireParam(request, 'transactionId')));
    },
  );

  app.put(
    '/api/v1/financial-planning/bill-purposes/:transactionId',
    async (request, reply: FastifyReply) => {
      const { service } = getServices(request);
      return reply.send(
        service.putBillPurpose(requireParam(request, 'transactionId'), request.body),
      );
    },
  );

  // ── 退款 ───────────────────────────────────────────────────────────────────
  app.get('/api/v1/financial-planning/refunds', async (request, reply: FastifyReply) => {
      const { service } = getServices(request);
    return reply.send(service.listRefunds(queryObject(request)));
  });

  app.get('/api/v1/financial-planning/refunds/:refundId', async (request, reply: FastifyReply) => {
      const { service } = getServices(request);
    return reply.send(service.getRefund(requireParam(request, 'refundId')));
  });

  app.put(
    '/api/v1/financial-planning/refunds/:refundId/splits',
    async (request, reply: FastifyReply) => {
      const { service } = getServices(request);
      return reply.send(
        service.putRefundSplits(requireParam(request, 'refundId'), request.body),
      );
    },
  );

  // ── 操作重放 ───────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/financial-planning/operations/:operationId',
    async (request, reply: FastifyReply) => {
      const { service } = getServices(request);
      // Scoped to the signed-in actor: an operationId belonging to another account
      // must answer 404 exactly like an unknown one, not leak its stored response.
      const found = service.operation(
        requireParam(request, 'operationId'),
        requireUserId(request),
      );
      if (found === undefined) {
        throw new FinancialNotFoundError('This operation is not known on this server.');
      }
      return reply.send(found);
    },
  );
}
