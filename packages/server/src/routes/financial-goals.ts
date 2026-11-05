import { createRouteServices, type TenantContextManager } from '../tenancy/context.js';
/**
 * 手动存钱与投资进度 HTTP 路由:`/api/v1/financial-goals/*`(C4 / F08+F09)。
 *
 * 处理器只做三件事:取参数、调用 `FinancialGoalsService`、回传 DTO。金额算术、
 * 历史重放、CAS 与重放判定都在服务层;领域错误以 `{ statusCode, code }` 抛出,
 * 由 `app.ts` 的统一错误处理器渲染成 `{ error: { code, message } }`。
 *
 * 全部注册在 auth 模块的 `extraRoutes` 内:未登录 401、缺 CSRF 头 403 与其它
 * 财务写接口完全一致,不另开鉴权通道。
 *
 * 这些接口**不修改**账本、工资、转账或账户余额;它们只记录用户确认过的手动进度。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/index.js';
import { FinancialNotFoundError } from '../services/financial-errors.js';
import { FinancialGoalsService } from '../services/financial-goals-service.js';

export interface FinancialGoalsRoutesOptions {
  readonly tenants?: TenantContextManager | undefined;
  readonly db: Db;
  readonly now?: (() => number) | undefined;
  /** 测试注入的操作者;缺省取单用户表里的唯一用户。 */
  readonly actorId?: string | undefined;
}

function requireParam(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, unknown>)[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new FinancialNotFoundError(`${name} is required.`);
  }
  return value.trim();
}

function queryObject(request: FastifyRequest): Record<string, unknown> {
  return (request.query ?? {}) as Record<string, unknown>;
}

export async function registerFinancialGoalsRoutes(
  app: FastifyInstance,
  options: FinancialGoalsRoutesOptions,
): Promise<void> {
  const getServices = createRouteServices(app, options, (options, _lifecycle) => {
    const service = new FinancialGoalsService(options.db, {
      now: options.now,
      actorId: options.actorId,
    });

    // ── 进度视图 ────────────────────────────────────────────────────────────────

    return { service, options };
  });

  app.get('/api/v1/financial-goals', async (request, reply: FastifyReply) => {
      const { service } = getServices(request);
    return reply.send(service.view(queryObject(request)));
  });

  // ── 起始值(显式确认/更正) ──────────────────────────────────────────────────
  app.put('/api/v1/financial-goals/opening', async (request, reply: FastifyReply) => {
      const { service } = getServices(request);
    const result = service.putOpening(request.body);
    return reply.status(result.statusCode).send(result.body);
  });

  // ── 记录列表(有界游标) ─────────────────────────────────────────────────────
  app.get('/api/v1/financial-goals/entries', async (request, reply: FastifyReply) => {
      const { service } = getServices(request);
    return reply.send(service.listEntries(queryObject(request)));
  });

  app.post('/api/v1/financial-goals/entries', async (request, reply: FastifyReply) => {
      const { service } = getServices(request);
    const result = service.createEntry(request.body);
    return reply.status(result.statusCode).send(result.body);
  });

  app.patch(
    '/api/v1/financial-goals/entries/:entryId',
    async (request, reply: FastifyReply) => {
      const { service } = getServices(request);
      const result = service.patchEntry(requireParam(request, 'entryId'), request.body);
      return reply.status(result.statusCode).send(result.body);
    },
  );

  app.delete(
    '/api/v1/financial-goals/entries/:entryId',
    async (request, reply: FastifyReply) => {
      const { service } = getServices(request);
      const result = service.deleteEntry(requireParam(request, 'entryId'), request.body);
      return reply.status(result.statusCode).send(result.body);
    },
  );

  // ── 未知结果查询(不重复新操作) ─────────────────────────────────────────────
  app.get(
    '/api/v1/financial-goals/operations/:operationId',
    async (request, reply: FastifyReply) => {
      const { service } = getServices(request);
      const found = service.operation(requireParam(request, 'operationId'));
      if (found === undefined) {
        throw new FinancialNotFoundError('This operation is not known on this server.');
      }
      return reply.send(found);
    },
  );
}
