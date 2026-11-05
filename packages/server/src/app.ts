/**
 * Fastify instance assembly (task PRD R2/R4, T3 R5/R6).
 *
 * `buildApp` only *builds* the instance — it never calls `listen`. That split
 * lets tests drive the app through `app.inject()` (no real port) and lets
 * index.ts own the process lifecycle (port binding, signals, shutdown).
 */
import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';
import type { AppConfig } from './config.js';
import { authModule } from './plugins/auth.js';
import { registerBudgetRoutes } from './routes/budget.js';
import { registerMasterDataRoutes } from './routes/master-data.js';
import { registerStatsRoutes } from './routes/stats.js';
import { registerTrashRoutes } from './routes/trash.js';
import { registerRecurringRoutes } from './routes/recurring.js';
import { registerPortabilityRoutes } from './routes/portability.js';
import { registerTransactionRoutes } from './routes/transactions.js';
import { registerTransferRoutes } from './routes/transfers.js';
import { registerAiRoutes } from './routes/ai.js';
import { registerAssistantRoutes } from './routes/assistant.js';
import { registerItemRoutes } from './routes/items.js';
import { registerItemCutoutRoutes } from './routes/item-cutouts.js';
import { registerFinancialPlanningRoutes } from './routes/financial-planning.js';
import { registerFinancialGoalsRoutes } from './routes/financial-goals.js';
import { registerFinancialFundRoutes } from './routes/financial-funds.js';
import { AuthService } from './services/auth-service.js';
import type { Db } from './db/index.js';
import type { IdentityStore } from './identity/store.js';
import { TenantContextManager, registerTenantHooks } from './tenancy/context.js';

export interface BuildAppOptions {
  readonly identityStore?: IdentityStore;
  /** Bounded open service graphs; active requests and jobs are never evicted. */
  readonly maxTenantContexts?: number;
  readonly config: AppConfig;
  /**
   * Database handle. Required to enable authentication; when omitted the app runs
   * without routes that need storage (used by the API-only/health tests).
   */
  readonly db?: Db;
  /** Override the session-clock/argon2 wrapper (tests inject a fixed clock). */
  readonly authService?: AuthService;
  /**
   * Whether to mark the session cookie `Secure`. Defaults to on in production,
   * off otherwise so a plain-http local run can still sign in.
   */
  readonly secureCookies?: boolean;
  /**
   * Injectable clock for route-level validation (date sanity checks). Defaults to
   * the real clock; tests pin it so "in the future" assertions are deterministic.
   */
  readonly now?: (() => number) | undefined;
  /** Injectable provider/inference transport for API route tests. */
  readonly fetchImpl?: typeof fetch;
  /** Streaming generation timing overrides (tests set 0 for deterministic runs). */
  readonly generationDelayMs?: number | undefined;
  readonly generationStepDelayMs?: number | undefined;
}

/** Everything below this prefix is API and must never answer with index.html. */
const API_PREFIX = '/api';

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const { config } = options;

  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: config.trustProxy,
    // A CSV import posts the file as raw text. Without this parser Fastify has no handler
    // for `text/csv` and answers 415 before the route runs.
    bodyLimit: 8 * 1024 * 1024,
  });

  app.addContentTypeParser('text/csv', { parseAs: 'string' }, (_request, body, done) => {
    done(null, body);
  });

  // Platform bill import: Alipay GBK CSV and WeChat xlsx must arrive as raw bytes.
  // A browser File.text() would corrupt GBK; the server decodes after the body lands.
  const bufferParser = (
    _request: FastifyRequest,
    body: Buffer,
    done: (err: Error | null, body?: unknown) => void,
  ): void => {
    done(null, body);
  };
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, bufferParser);
  app.addContentTypeParser(
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    { parseAs: 'buffer' },
    bufferParser,
  );
  for (const imageType of ['image/jpeg', 'image/png', 'image/webp']) {
    app.addContentTypeParser(imageType, { parseAs: 'buffer' }, bufferParser);
  }

  // ── Unified error contract: { error: { code, message } } (design.md §5) ──────
  // Fastify 5 types the handler's error as `unknown` by default, so the
  // FastifyError generic is supplied explicitly.
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const statusCode =
      typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;
    const code =
      typeof error.code === 'string' && error.code !== ''
        ? error.code
        : statusCode >= 500
          ? 'INTERNAL_ERROR'
          : 'REQUEST_ERROR';

    if (statusCode >= 500) {
      // Log the real thing, never hand it to the client.
      request.log.error({ err: error }, 'request failed');
      return reply.status(statusCode).send({ error: { code, message: 'Internal Server Error' } });
    }

    request.log.warn({ err: error }, 'request rejected');
    return reply.status(statusCode).send({ error: { code, message: error.message } });
  });

  // API responses are session-specific and must not outlive logout in HTTP caches.
  // The native client is online-first; a cached success must not hide network failure.
  app.addHook('onSend', (request, reply, payload, done) => {
    if (request.url === API_PREFIX || request.url.startsWith(`${API_PREFIX}/`)) {
      reply.header('Cache-Control', 'no-store');
    }
    done(null, payload);
  });

  // ── Health (AC6 / AC8; used by the container HEALTHCHECK) ───────────────────
  app.get('/api/v1/health', () => ({
    status: 'ok',
    version: config.version,
    uptime: Math.round(process.uptime()),
  }));

  // ── Authentication (T3) ─────────────────────────────────────────────────────
  // The guard and protected routes must share ONE module/context. Health remains
  // public, and unknown API paths still pass through the same authentication guard.
  const authService =
    options.identityStore?.authService ?? options.authService ??
    (options.db === undefined
      ? undefined
      : new AuthService(options.db, { sessionTtlDays: config.sessionTtlDays }));

  if (authService !== undefined && options.db !== undefined) {
    const secureCookies = options.secureCookies ?? config.nodeEnv === 'production';
    const db = options.db;
    const tenants = options.identityStore === undefined ? undefined :
      new TenantContextManager(options.identityStore, config, db, options.maxTenantContexts);
    if (tenants !== undefined) {
      app.addHook('preClose', async () => { await tenants.drain(); });
      app.addHook('onClose', async () => { await tenants.close(); });
    }

    // Protected route groups are passed INTO the auth module so the guard's hooks
    // apply to them (see plugins/auth.ts `extraRoutes`).
    void app.register(authModule, {
      config,
      authService,
      secureCookies,
      ...(options.identityStore === undefined ? {} : { identityStore: options.identityStore }),
      extraRoutes: [
        (instance) => { if (tenants !== undefined) registerTenantHooks(instance, tenants); },
        (instance) => registerTransactionRoutes(instance, { db, tenants, now: options.now }),
        (instance) => registerMasterDataRoutes(instance, { db, tenants, now: options.now }),
        (instance) => registerBudgetRoutes(instance, { db, tenants, now: options.now }),
        // Must be in this array, not a sibling `app.register`: a hook and the routes it should
        // protect have to share an encapsulation context, or the routes escape the guard
        // silently (`plugins/auth.ts`, and `spec/backend/index.md` "the most expensive
        // mistake"). Asserted endpoint-by-endpoint in `e2e-transfers.mjs`.
        (instance) => registerTransferRoutes(instance, { db, tenants, now: options.now }),
        (instance) => registerStatsRoutes(instance, { db, tenants, now: options.now }),
        (instance) => registerTrashRoutes(instance, { db, tenants, now: options.now }),
        (instance) => registerRecurringRoutes(instance, { db, tenants, now: options.now }),
        (instance) =>
          registerPortabilityRoutes(instance, {
            db,
            tenants,
            dataDir: config.dataDir,
            dbFile: config.dbFile,
            now: options.now,
          }),
        (instance) =>
          registerAiRoutes(instance, {
            db,
            tenants,
            config,
            now: options.now,
            fetchImpl: options.fetchImpl,
          }),
        (instance) =>
          registerAssistantRoutes(instance, {
            db,
            tenants,
            config,
            now: options.now,
            fetchImpl: options.fetchImpl,
            generationDelayMs: options.generationDelayMs,
            generationStepDelayMs: options.generationStepDelayMs,
          }),
        (instance) => registerItemRoutes(instance, { db, tenants, now: options.now }),
        (instance) =>
          registerItemCutoutRoutes(instance, {
            serviceUrl: config.itemCutoutServiceUrl,
            identityDb: options.identityStore?.db,
            fetchImpl: options.fetchImpl,
          }),
        (instance) =>
          registerFinancialPlanningRoutes(instance, {
            db,
            tenants,
            now: options.now,
          }),
        (instance) => registerFinancialGoalsRoutes(instance, { db, tenants, now: options.now }),
        (instance) => registerFinancialFundRoutes(instance, { db, tenants, now: options.now }),
      ],
    });
  } else {
    app.log.warn('no database supplied — authentication routes are disabled');
  }

  // This is an API-only service. Leftover Web builds or legacy environment
  // settings must never enable static hosting or an HTML fallback.
  app.setNotFoundHandler((request, reply) => {
    const url = request.url;

    request.log.warn({ method: request.method, url }, 'route not found');

    return reply
      .status(404)
      .send({ error: { code: 'NOT_FOUND', message: `Route ${request.method} ${url} not found` } });
  });

  return app;
}
