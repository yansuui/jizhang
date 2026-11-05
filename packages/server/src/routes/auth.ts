/**
 * Authentication routes (T3 PRD R4).
 *
 *   GET  /api/v1/auth/me        → who am I (401 when signed out)
 *   POST /api/v1/auth/login     → open a session
 *   POST /api/v1/auth/logout    → close it
 *   POST /api/v1/auth/password  → rotate the password
 *
 * Every failure path returns the SAME message and status for "wrong username" and
 * "wrong password" (PRD AC3). A caller must not be able to learn whether the
 * account is configured, which matters on a public hostname.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import {
  clearSessionCookie,
  requireUserId,
  setSessionCookie,
  type AuthedRequest,
} from '../plugins/auth.js';
import type { AuthService } from '../services/auth-service.js';
import {
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  PasswordPolicyError,
} from '../services/password.js';
import type { IdentityStore } from '../identity/store.js';
import { IdentityError } from '../identity/errors.js';
import { AuthRequestLimiter } from '../identity/request-limiter.js';

export interface AuthRoutesOptions {
  readonly config: AppConfig;
  readonly authService: AuthService;
  readonly secureCookies: boolean;
  readonly identityStore?: IdentityStore;
}

/** Identical body for every credential failure. */
const INVALID_CREDENTIALS = {
  error: { code: 'INVALID_CREDENTIALS', message: 'Invalid username or password.' },
} as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

interface LoginBody {
  username?: unknown;
  password?: unknown;
}

interface ChangePasswordBody {
  currentPassword?: unknown;
  newPassword?: unknown;
}

interface RegisterBody {
  username?: unknown;
  password?: unknown;
  invitationCode?: unknown;
}

function identityResponse(authService: AuthService, userId: string, expiresAt: number) {
  const user = authService.findUserById(userId);
  if (user === undefined || user.status === 'disabled') {
    throw new IdentityError(401, 'UNAUTHORIZED', 'Authentication required.');
  }
  const role = user.role ?? 'member';
  return {
    id: user.id,
    username: user.username,
    role,
    capabilities: role === 'admin' ? ['manageInvitations'] : [],
    expiresAt,
  };
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  options: AuthRoutesOptions,
): Promise<void> {
  const { config, authService, secureCookies } = options;
  const limiter = new AuthRequestLimiter();

  app.get('/api/v1/auth/me', async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = (request as AuthedRequest).auth;
    if (auth === undefined) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required.' },
      });
    }

    return reply.send(identityResponse(authService, auth.userId, auth.expiresAtMs));
  });

  app.post(
    '/api/v1/auth/login',
    { bodyLimit: 4096 },
    async (request: FastifyRequest, reply: FastifyReply) =>
      limiter.run(request.ip, 'login', async () => {
        const body = (request.body ?? {}) as LoginBody;

        if (
          !isNonEmptyString(body.username) ||
          body.username.length > 256 ||
          !isNonEmptyString(body.password)
        ) {
          // Still the credentials error: a malformed body must not be distinguishable
          // from a wrong password either.
          return reply.status(401).send(INVALID_CREDENTIALS);
        }

        const username = body.username.trim();

        const result = await authService.login(username, body.password);
        if (!result.ok) {
          request.log.warn({ reason: result.reason }, 'login rejected');
          return reply.status(401).send(INVALID_CREDENTIALS);
        }

        setSessionCookie(reply, result.token, config.sessionTtlDays, secureCookies);
        request.log.info({ userId: result.userId }, 'login succeeded');
        return reply.send(identityResponse(authService, result.userId, result.expiresAtMs));
      }),
  );

  if (options.identityStore !== undefined) {
    const identity = options.identityStore;
    app.post('/api/v1/auth/register', { bodyLimit: 4096 }, async (request, reply) =>
      limiter.run(request.ip, 'register', async () => {
        const body = request.body as RegisterBody | undefined;
        if (
          body === null ||
          typeof body !== 'object' ||
          Array.isArray(body) ||
          Object.keys(body).some((key) => !['username', 'password', 'invitationCode'].includes(key))
        ) {
          throw new IdentityError(
            400,
            'VALIDATION',
            'Provide username, password and invitationCode only.',
          );
        }
        let user;
        try {
          user = await identity.register(body.username, body.password, body.invitationCode);
        } catch (error) {
          if (error instanceof PasswordPolicyError)
            throw new IdentityError(400, 'WEAK_PASSWORD', error.message);
          throw error;
        }
        const session = authService.createSession(user.id);
        if (!session.ok) throw new Error('Registered account could not start a session.');
        setSessionCookie(reply, session.token, config.sessionTtlDays, secureCookies);
        return reply.status(201).send(identityResponse(authService, user.id, session.expiresAtMs));
      }),
    );
  }

  app.post('/api/v1/auth/logout', async (request: FastifyRequest, reply: FastifyReply) => {
    const token = (request as AuthedRequest).sessionToken;
    if (token !== undefined) {
      authService.deleteSession(token);
    }
    clearSessionCookie(reply, secureCookies);
    return reply.send({ ok: true });
  });

  app.post(
    '/api/v1/auth/password',
    { bodyLimit: 4096 },
    async (request: FastifyRequest, reply: FastifyReply) =>
      limiter.run(request.ip, 'password', async () => {
        const userId = requireUserId(request);
        const body = (request.body ?? {}) as ChangePasswordBody;

        if (!isNonEmptyString(body.currentPassword) || !isNonEmptyString(body.newPassword)) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION',
              message: 'Both currentPassword and newPassword are required.',
            },
          });
        }

        if (
          body.newPassword.length < MIN_PASSWORD_LENGTH ||
          body.newPassword.length > MAX_PASSWORD_LENGTH
        ) {
          return reply.status(400).send({
            error: {
              code: 'WEAK_PASSWORD',
              message: `Password must be at least ${MIN_PASSWORD_LENGTH} and at most ${MAX_PASSWORD_LENGTH} characters long.`,
            },
          });
        }

        let changed: boolean;
        try {
          changed = await authService.changePassword(
            userId,
            body.currentPassword,
            body.newPassword,
          );
        } catch (error) {
          if (error instanceof PasswordPolicyError) {
            return reply
              .status(400)
              .send({ error: { code: 'WEAK_PASSWORD', message: error.message } });
          }
          throw error;
        }

        if (!changed) {
          return reply.status(401).send({
            error: { code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect.' },
          });
        }

        // Every session is gone, including this one, so clear the cookie to match the
        // server state instead of leaving the client with a dead token (PRD AC7).
        clearSessionCookie(reply, secureCookies);
        request.log.info('password changed; user sessions invalidated');
        return reply.send({ ok: true, reauthenticate: true });
      }),
  );
}
