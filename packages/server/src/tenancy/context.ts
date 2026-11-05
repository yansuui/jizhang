import type { FastifyInstance, FastifyRequest } from 'fastify';
import { statSync } from 'node:fs';
import type { AppConfig } from '../config.js';
import { closeDatabase, initializeDatabase, openDatabase, type Db } from '../db/index.js';
import type { IdentityStore } from '../identity/store.js';
import { requireUserId, UnauthorizedError } from '../plugins/auth.js';

export interface TenantLifecycle {
  onClose(close: () => Promise<void> | void): void;
  whileBusy(check: () => boolean): void;
}

/** A stable service graph: a live request or worker can never change its ledger. */
export class TenantContext implements TenantLifecycle {
  private readonly services = new Map<symbol, unknown>();
  private readonly closers: (() => Promise<void> | void)[] = [];
  private readonly busyChecks: (() => boolean)[] = [];
  private draining: Promise<void> | undefined;
  references = 0;
  lastUsed = Date.now();

  constructor(
    readonly userId: string,
    readonly db: Db,
    readonly dbFile: string,
    readonly dataDir: string,
    private readonly ownsDatabase: boolean,
  ) {}

  service<T>(key: symbol, create: (lifecycle: TenantLifecycle) => T): T {
    if (this.draining !== undefined) throw new TenantCapacityError();
    if (!this.services.has(key)) this.services.set(key, create(this));
    return this.services.get(key) as T;
  }

  onClose(close: () => Promise<void> | void): void { this.closers.push(close); }
  whileBusy(check: () => boolean): void { this.busyChecks.push(check); }
  get idle(): boolean { return this.references === 0 && this.busyChecks.every((check) => !check()); }

  drain(): Promise<void> {
    this.draining ??= (async () => {
      // Start every cancellation before waiting for any provider or stream.
      const results = await Promise.allSettled(this.closers.map(async (close) => close()));
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length > 0) throw new AggregateError(failures.map((result) => result.reason), 'Tenant shutdown failed');
    })();
    return this.draining;
  }

  async close(): Promise<void> {
    await this.drain();
    if (this.ownsDatabase) closeDatabase(this.db);
    this.services.clear();
  }
}

class TenantCapacityError extends Error {
  readonly statusCode = 503;
  readonly code = 'TENANT_BUSY';
  constructor() { super('The service is busy. Please try again shortly.'); }
}

/** Bounded LRU, with explicit request leases and worker-aware idle eviction. */
export class TenantContextManager {
  private readonly contexts = new Map<string, TenantContext>();
  private readonly requests = new WeakMap<FastifyRequest, TenantContext>();
  private readonly handlerCompletions = new WeakMap<FastifyRequest, () => void>();
  private opening: Promise<void> = Promise.resolve();
  private closing = false;

  constructor(
    private readonly identity: IdentityStore,
    private readonly config: AppConfig,
    private readonly ownerDb: Db,
    private readonly maxContexts = 32,
  ) {
    if (!Number.isSafeInteger(maxContexts) || maxContexts < 1) throw new Error('Invalid tenant context capacity');
  }

  async lease(request: FastifyRequest): Promise<() => void> {
    const userId = requireUserId(request);
    let releaseLock!: () => void;
    const previous = this.opening;
    this.opening = new Promise<void>((resolve) => { releaseLock = resolve; });
    await previous;
    let context: TenantContext;
    try {
      if (this.closing) throw new TenantCapacityError();
      const ledger = this.identity.getLedger(userId);
      if (ledger === undefined) throw new UnauthorizedError();
      const cached = this.contexts.get(userId);
      if (cached !== undefined) context = cached;
      else {
        if (this.contexts.size >= this.maxContexts) {
          const victim = [...this.contexts.values()].filter((value) => value.idle)
            .sort((a, b) => a.lastUsed - b.lastUsed)[0];
          if (victim === undefined) throw new TenantCapacityError();
          await victim.close();
          this.contexts.delete(victim.userId);
        }
        const isOwner = ledger.dbFile === this.config.dbFile;
        // A missing mapped ledger is a recovery error, never a fresh empty account.
        if (!statSync(ledger.dbFile, { throwIfNoEntry: false })?.isFile()) {
          throw new Error('Mapped ledger file is missing');
        }
        const db = isOwner ? this.ownerDb : openDatabase({ ...this.config, ...ledger });
        try { initializeDatabase(db, ledger.dataDir); }
        catch (error) { if (!isOwner) closeDatabase(db); throw error; }
        context = new TenantContext(userId, db, ledger.dbFile, ledger.dataDir, !isOwner);
        this.contexts.set(userId, context);
      }
      context.references += 1;
      context.lastUsed = Date.now();
      this.requests.set(request, context);
    } finally { releaseLock(); }
    let responseDone = false;
    let handlerDone = false;
    let released = false;
    const release = (): void => {
      if (released || !responseDone || !handlerDone) return;
      released = true;
      context.references -= 1;
      context.lastUsed = Date.now();
      this.requests.delete(request);
      this.handlerCompletions.delete(request);
    };
    this.handlerCompletions.set(request, () => { handlerDone = true; release(); });
    return () => { responseDone = true; release(); };
  }

  handlerFinished(request: FastifyRequest): void { this.handlerCompletions.get(request)?.(); }

  forRequest(request: FastifyRequest): TenantContext {
    const context = this.requests.get(request);
    if (context === undefined || context.userId !== requireUserId(request)) throw new UnauthorizedError();
    return context;
  }

  async drain(): Promise<void> {
    this.closing = true;
    await this.opening;
    await Promise.all([...this.contexts.values()].map((context) => context.drain()));
  }

  async close(): Promise<void> {
    await this.drain();
    await Promise.all([...this.contexts.values()].map((context) => context.close()));
    this.contexts.clear();
  }
}

export interface TenantRouteOptions {
  readonly db: Db;
  readonly tenants?: TenantContextManager | undefined;
}

/** Factories run once per open ledger, never once per request. */
export function createRouteServices<O extends TenantRouteOptions, T>(
  app: FastifyInstance,
  options: O,
  create: (options: O, lifecycle: TenantLifecycle) => T,
): (request: FastifyRequest) => T {
  const key = Symbol('route-services');
  if (options.tenants === undefined) {
    const legacy = new TenantContext('legacy', options.db, options.db.name, '', false);
    const services = create(options, legacy);
    app.addHook('preClose', async () => { await legacy.drain(); });
    return () => services;
  }
  const tenants = options.tenants;
  return (request) => {
    const tenant = tenants.forRequest(request);
    return tenant.service(key, (lifecycle) => {
      const scoped = { ...options, db: tenant.db, dbFile: tenant.dbFile, dataDir: tenant.dataDir, actorId: tenant.userId };
      if ('config' in options) {
        Object.assign(scoped, { config: { ...(options.config as AppConfig), dbFile: tenant.dbFile, dataDir: tenant.dataDir } });
      }
      return create(scoped, lifecycle);
    });
  };
}

/** Install inside the auth module, after its session guard. */
export function registerTenantHooks(app: FastifyInstance, tenants: TenantContextManager): void {
  // A socket can disappear while an awaited provider call is still using the DB.
  // Release only after BOTH the handler and its response/stream have finished.
  app.addHook('onRoute', (route) => {
    const handler = route.handler;
    route.handler = async function (request, reply) {
      try { return await handler.call(this, request, reply); }
      finally { tenants.handlerFinished(request); }
    };
  });
  app.addHook('preHandler', async (request, reply) => {
    const pathname = request.url.split('?', 1)[0] ?? '';
    if (request.routeOptions.url === undefined || !pathname.startsWith('/api/v1/') || pathname === '/api/v1/health' || pathname.startsWith('/api/v1/auth/') || pathname.startsWith('/api/v1/admin/')) return;
    const release = await tenants.lease(request);
    reply.raw.once('finish', release);
    reply.raw.once('close', release);
  });
}
