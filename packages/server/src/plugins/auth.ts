/**
 * The authentication module.
 *
 * The guard hook and the auth routes MUST be registered in ONE encapsulated
 * context. Registering them as two sibling `app.register(...)` calls silently
 * breaks the guard: Fastify hooks only apply to routes registered in the same (or
 * a descendant) context, so the routes escape the guard entirely — which shows up
 * as a missing 403 on a CSRF-less POST and a missing 401 on a protected route,
 * while `/api/v1/health` (registered at the root, before this module) still looks
 * correct.
 *
 * Keeping the whole thing in one plugin makes that mistake impossible to repeat.
 */
import cookie from '@fastify/cookie';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { AppConfig } from '../config.js';
import { registerAuthRoutes } from '../routes/auth.js';
import type { AuthService } from '../services/auth-service.js';
import type { IdentityStore } from '../identity/store.js';
import { registerInvitationRoutes } from '../routes/invitations.js';

/** Cookie name. Prefixed to avoid collisions with anything else on the domain. */
export const SESSION_COOKIE = 'jizhang_session';

/** Header a mutating request must carry (CSRF defence in depth). */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_HEADER_VALUE = 'fetch';

/**
 * Routes reachable without a session, as `METHOD /path`.
 *
 * `health` must stay open: the container HEALTHCHECK and any uptime monitor call
 * it, and it exposes only a version string and uptime (PRD AC10). `login` cannot
 * require a session by definition, and is still subject to the CSRF header check
 * so a cross-site form cannot silently establish a session.
 */
const PUBLIC_ROUTES = new Set<string>(['GET /api/v1/health', 'POST /api/v1/auth/login']);

/** Fastify request decorated with the resolved session. */
export interface AuthedRequest extends FastifyRequest {
  auth?: { userId: string; expiresAtMs: number } | undefined;
  sessionToken?: string | undefined;
}

export interface AuthModuleOptions {
  readonly config: AppConfig;
  readonly authService: AuthService;
  readonly identityStore?: IdentityStore;
  /** `Secure` cookies require HTTPS; false for plain-http local runs. */
  readonly secureCookies: boolean;
  /**
   * Protected route registrars.
   *
   * They are invoked INSIDE this plugin on purpose: Fastify hooks only apply to
   * routes registered in the same or a descendant context, so a route registered
   * by the caller as a sibling of this module would silently escape the guard.
   * Passing them here makes that structurally impossible.
   */
  readonly extraRoutes?: readonly ((app: FastifyInstance) => Promise<void> | void)[];
}

export class UnauthorizedError extends Error {
  readonly statusCode = 401;
  readonly code = 'UNAUTHORIZED';
  constructor(message = 'Authentication required.') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class CsrfError extends Error {
  readonly statusCode = 403;
  readonly code = 'CSRF_REQUIRED';
  constructor() {
    super(`Mutating requests must send the ${CSRF_HEADER}: ${CSRF_HEADER_VALUE} header.`);
    this.name = 'CsrfError';
  }
}

function isMutating(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

/** Path without the query string. */
function pathOf(url: string): string {
  const index = url.indexOf('?');
  return index === -1 ? url : url.slice(0, index);
}

export const authModule = fp<AuthModuleOptions>(
  async (app: FastifyInstance, options: AuthModuleOptions) => {
    await app.register(cookie);

    app.decorateRequest('auth', undefined);
    app.decorateRequest('sessionToken', undefined);

    // ── Resolve the session (never rejects) ───────────────────────────────────
    app.addHook('onRequest', async (request: FastifyRequest) => {
      const token = request.cookies[SESSION_COOKIE];
      if (typeof token !== 'string' || token === '') return;

      const session = options.authService.resolveSession(token);
      if (session === undefined) return;

      (request as AuthedRequest).auth = session;
      (request as AuthedRequest).sessionToken = token;
    });

    // ── Enforce, for /api routes that are not explicitly public ───────────────
    app.addHook('onRequest', async (request: FastifyRequest) => {
      const route = `${request.method.toUpperCase()} ${pathOf(request.url)}`;
      if (
        PUBLIC_ROUTES.has(route) ||
        (options.identityStore !== undefined && route === 'POST /api/v1/auth/register')
      ) {
        // Login still has to prove the request came from our own page.
        if (isMutating(request.method) && request.headers[CSRF_HEADER] !== CSRF_HEADER_VALUE) {
          throw new CsrfError();
        }
        return;
      }

      // Only guard the API. Static assets and the SPA shell must stay reachable,
      // otherwise the login page itself could not load.
      if (!pathOf(request.url).startsWith('/api/')) return;

      if (isMutating(request.method) && request.headers[CSRF_HEADER] !== CSRF_HEADER_VALUE) {
        throw new CsrfError();
      }

      if ((request as AuthedRequest).auth === undefined) {
        throw new UnauthorizedError();
      }
    });

    // Routes live INSIDE this plugin so the hooks above apply to them.
    await registerAuthRoutes(app, options);
    if (options.identityStore !== undefined)
      await registerInvitationRoutes(app, options.identityStore);

    // Protected resources (transactions, budgets, ...) are registered here too.
    for (const register of options.extraRoutes ?? []) {
      await register(app);
    }
  },
  { name: 'jizhang-auth' },
);

/** Sets the session cookie. `ttlDays` mirrors the session TTL. */
export function setSessionCookie(
  reply: import('fastify').FastifyReply,
  token: string,
  ttlDays: number,
  secure: boolean,
): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure,
    sameSite: 'lax',
    maxAge: Math.floor(ttlDays * 86_400),
  });
}

/** Clears the session cookie (logout, password change). */
export function clearSessionCookie(reply: import('fastify').FastifyReply, secure: boolean): void {
  reply.clearCookie(SESSION_COOKIE, {
    path: '/',
    httpOnly: true,
    secure,
    sameSite: 'lax',
  });
}

/** The authenticated user id; throws 401 if the guard somehow let a hole through. */
export function requireUserId(request: FastifyRequest): string {
  const auth = (request as AuthedRequest).auth;
  if (auth === undefined) throw new UnauthorizedError();
  return auth.userId;
}
