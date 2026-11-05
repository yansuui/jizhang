import { createRouteServices, type TenantContextManager } from '../tenancy/context.js';
/**
 * AI assistant routes. Every route is registered inside the authenticated module.
 *
 *   GET  /api/v1/ai/config              redacted provider summary
 *   PUT  /api/v1/ai/config              save provider settings
 *   POST /api/v1/ai/test                make an explicit provider test request
 *   POST /api/v1/ai/transaction-draft   generate a read-only transaction draft
 *   POST /api/v1/ai/monthly-evaluation  evaluate the current natural month
 *   POST /api/v1/ai/organization-preview  preview safe data organization actions
 *   POST /api/v1/ai/organization-apply    apply selected organization actions
 *   POST /api/v1/ai/organization-undo     conditionally undo an operation
 *   POST /api/v1/ai/organization-runs     start bounded date-range analysis
 *   GET  /api/v1/ai/organization-runs/:id read run status
 *   GET  /api/v1/ai/organization-runs/:id/card read the completed review card
 *   POST /api/v1/ai/organization-runs/:id/apply apply selected card actions
 *   POST /api/v1/ai/organization-operations/:id/undo conditionally undo an operation
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { AiConfigService } from '../services/ai-config-service.js';
import { AiProviderService } from '../services/ai-provider-service.js';
import type { AiProviderConfigInput } from '../services/ai-types.js';
import { AiSpendingOperationNotFoundError, AiSpendingRunNotFoundError } from '../services/ai-types.js';
import { MonthlyEvaluationService } from '../services/monthly-evaluation-service.js';
import { AiTransactionService } from '../services/ai-transaction-service.js';
import { AiOrganizationService } from '../services/ai-organization-service.js';
import { AiSpendingOrganizationService } from '../services/ai-spending-organization-service.js';

export interface AiRoutesOptions {
  readonly tenants?: TenantContextManager | undefined;
  readonly db: Db;
  readonly config: AppConfig;
  readonly now?: (() => number) | undefined;
  readonly fetchImpl?: typeof fetch;
}

function bodyRecord(request: FastifyRequest): Record<string, unknown> {
  const body = request.body;
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

export async function registerAiRoutes(
  app: FastifyInstance,
  options: AiRoutesOptions,
): Promise<void> {
  const getServices = createRouteServices(app, options, (options, lifecycle) => {
    const config = new AiConfigService(options.db, {
      aiEncryptionKey: options.config.aiEncryptionKey,
      production: options.config.nodeEnv === 'production',
      now: options.now,
    });
    const provider = new AiProviderService(options.fetchImpl);
    const transactions = new AiTransactionService(options.db, config, provider, options.now);
    const monthly = new MonthlyEvaluationService(options.db, config, provider, options.now);
    const organization = new AiOrganizationService(options.db, config, provider, {
      now: options.now,
    });
    const spendingOrganization = new AiSpendingOrganizationService(options.db, config, provider, {
      now: options.now,
    });
    // Abort provider work before Fastify waits for in-flight legacy synchronous POSTs.
    lifecycle.onClose(async () => { await spendingOrganization.close(); });
    lifecycle.whileBusy(() => spendingOrganization.hasActiveWork);

    return { config, provider, transactions, monthly, organization, spendingOrganization, options };
  });

  app.get('/api/v1/ai/config', async (_request: FastifyRequest, reply: FastifyReply) => {
      const { config } = getServices(_request);
    return reply.send(config.summary());
  });

  app.put('/api/v1/ai/config', async (request: FastifyRequest, reply: FastifyReply) => {
      const { config } = getServices(request);
    return reply.send(config.save(bodyRecord(request) as AiProviderConfigInput));
  });

  app.post('/api/v1/ai/models', async (_request: FastifyRequest, reply: FastifyReply) => {
      const { config, provider } = getServices(_request);
    const saved = config.getStoredForModelListingOrThrow();
    return reply.send(await provider.listModels(saved, config.getSecretOrThrow(saved)));
  });

  app.post('/api/v1/ai/test', async (_request: FastifyRequest, reply: FastifyReply) => {
      const { transactions } = getServices(_request);
    await transactions.testProvider();
    return reply.send({ ok: true });
  });

  app.post(
    '/api/v1/ai/transaction-draft',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { transactions } = getServices(request);
      const body = bodyRecord(request);
      return reply.send(await transactions.draft(body['input']));
    },
  );

  app.post('/api/v1/ai/monthly-evaluation', async (_request, reply: FastifyReply) => {
      const { monthly } = getServices(_request);
    return reply.send(await monthly.evaluate());
  });

  app.post('/api/v1/ai/organization-preview', async (_request, reply: FastifyReply) => {
      const { organization } = getServices(_request);
    return reply.send(await organization.preview());
  });

  app.post('/api/v1/ai/organization-apply', async (request: FastifyRequest, reply: FastifyReply) => {
      const { organization } = getServices(request);
    return reply.send(organization.apply(bodyRecord(request)));
  });

  app.post('/api/v1/ai/organization-undo', async (request: FastifyRequest, reply: FastifyReply) => {
      const { organization } = getServices(request);
    const body = bodyRecord(request);
    return reply.send(organization.undo(body['operationId']));
  });

  app.post('/api/v1/ai/organization-runs', async (request: FastifyRequest, reply: FastifyReply) => {
      const { spendingOrganization } = getServices(request);
    return reply.status(202).send(await spendingOrganization.startAnalysis(bodyRecord(request)));
  });

  app.post('/api/v1/ai/organization-runs/:id/resume', async (request: FastifyRequest, reply: FastifyReply) => {
      const { spendingOrganization } = getServices(request);
    const params = request.params as { id?: string };
    if (typeof params.id !== 'string' || params.id.trim() === '') throw new AiSpendingRunNotFoundError();
    return reply.status(202).send(await spendingOrganization.resumeAnalysis(params.id, bodyRecord(request)));
  });

  app.get('/api/v1/ai/organization-runs/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const { spendingOrganization } = getServices(request);
    const params = request.params as { id?: string };
    if (typeof params.id !== 'string' || params.id.trim() === '') {
      throw new AiSpendingRunNotFoundError();
    }
    return reply.send(spendingOrganization.getRun(params.id));
  });

  app.get('/api/v1/ai/organization-runs/:id/card', async (request: FastifyRequest, reply: FastifyReply) => {
      const { spendingOrganization } = getServices(request);
    const params = request.params as { id?: string };
    if (typeof params.id !== 'string' || params.id.trim() === '') {
      throw new AiSpendingRunNotFoundError();
    }
    return reply.send(spendingOrganization.getCard(params.id));
  });

  app.post('/api/v1/ai/organization-runs/:id/apply', async (request: FastifyRequest, reply: FastifyReply) => {
      const { spendingOrganization } = getServices(request);
    const params = request.params as { id?: string };
    if (typeof params.id !== 'string' || params.id.trim() === '') {
      throw new AiSpendingRunNotFoundError();
    }
    return reply.send(spendingOrganization.apply(params.id, bodyRecord(request)['actionIds']));
  });

  app.post('/api/v1/ai/organization-operations/:id/undo', async (request: FastifyRequest, reply: FastifyReply) => {
      const { spendingOrganization } = getServices(request);
    const params = request.params as { id?: string };
    if (typeof params.id !== 'string' || params.id.trim() === '') {
      throw new AiSpendingOperationNotFoundError();
    }
    return reply.send(spendingOrganization.undo(params.id));
  });
}
