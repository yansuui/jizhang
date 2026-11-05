import type { FastifyInstance } from 'fastify';
import type { IdentityStore } from '../identity/store.js';
import { IdentityError } from '../identity/errors.js';
import { requireUserId } from '../plugins/auth.js';

export async function registerInvitationRoutes(
  app: FastifyInstance,
  identity: IdentityStore,
): Promise<void> {
  app.get('/api/v1/admin/invitations', (request) => ({
    invitations: identity.listInvitations(requireUserId(request)),
  }));
  app.post('/api/v1/admin/invitations', { bodyLimit: 1024 }, (request, reply) => {
    identity.requireAdministrator(requireUserId(request));
    if (
      request.body !== undefined &&
      (request.body === null ||
        typeof request.body !== 'object' ||
        Array.isArray(request.body) ||
        Object.keys(request.body).length !== 0)
    ) {
      throw new IdentityError(
        400,
        'VALIDATION',
        'Invitation creation does not accept custom permissions or expiry.',
      );
    }
    return reply.status(201).send(identity.createInvitation(requireUserId(request)));
  });
  app.delete<{ Params: { id: string } }>('/api/v1/admin/invitations/:id', (request) => {
    identity.revokeInvitation(requireUserId(request), request.params.id);
    return { ok: true };
  });
}
