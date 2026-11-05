import { createRouteServices, type TenantContextManager } from '../tenancy/context.js';
/** Authenticated item inventory and photo routes. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/index.js';
import { ItemService } from '../services/item-service.js';
import { NotFoundError, ValidationError } from '../services/transaction-service.js';

export interface ItemRoutesOptions {
  readonly actorId?: string | undefined;
  readonly tenants?: TenantContextManager | undefined;
  readonly db: Db;
  readonly now?: (() => number) | undefined;
}

interface ItemParams {
  readonly id: string;
}

interface ItemListQuery {
  readonly status?: unknown;
  readonly category?: unknown;
  readonly q?: unknown;
  readonly limit?: unknown;
  readonly offset?: unknown;
}

export async function registerItemRoutes(
  app: FastifyInstance,
  options: ItemRoutesOptions,
): Promise<void> {
  const getServices = createRouteServices(app, options, (options, _lifecycle) => {
    const service = new ItemService(
      options.db,
    options,
    );

    return { service, options };
  });

  app.get('/api/v1/items', async (request: FastifyRequest<{ Querystring: ItemListQuery }>, reply) =>
    {
      const { service } = getServices(request);
      return reply.send(service.list(request.query));
    },
  );

  app.get('/api/v1/items/summary', async (_request: FastifyRequest, reply) =>
    {
      const { service } = getServices(_request);
      return reply.send(service.summary());
    },
  );

  app.get('/api/v1/items/:id', async (request: FastifyRequest<{ Params: ItemParams }>, reply) =>
    {
      const { service } = getServices(request);
      return reply.send(service.getByIdOrThrow(request.params.id));
    },
  );

  app.post('/api/v1/items', async (request: FastifyRequest, reply) =>
    {
      const { service } = getServices(request);
      return reply.status(201).send(service.create(request.body));
    },
  );

  app.patch('/api/v1/items/:id', async (request: FastifyRequest<{ Params: ItemParams }>, reply) =>
    {
      const { service } = getServices(request);
      return reply.send(service.update(request.params.id, request.body));
    },
  );

  app.delete(
    '/api/v1/items/:id',
    async (request: FastifyRequest<{ Params: ItemParams }>, reply) => {
      const { service } = getServices(request);
      service.remove(request.params.id);
      return reply.status(204).send();
    },
  );

  app.post(
    '/api/v1/items/:id/sell',
    async (request: FastifyRequest<{ Params: ItemParams }>, reply) =>
      {
      const { service } = getServices(request);
      return reply.send(service.sell(request.params.id, request.body));
    },
  );

  app.post(
    '/api/v1/items/:id/retire',
    async (request: FastifyRequest<{ Params: ItemParams }>, reply) =>
      {
      const { service } = getServices(request);
      return reply.send(service.retire(request.params.id, request.body));
    },
  );

  app.put(
    '/api/v1/items/:id/photo',
    async (request: FastifyRequest<{ Params: ItemParams }>, reply) => {
      const { service } = getServices(request);
      const contentType = request.headers['content-type']?.split(';', 1)[0]?.toLowerCase() ?? '';
      const body: unknown = request.body;
      if (
        contentType !== 'image/jpeg' &&
        contentType !== 'image/png' &&
        contentType !== 'image/webp'
      ) {
        throw new ValidationError('图片格式必须为 JPEG、PNG 或 WebP。');
      }
      if (!Buffer.isBuffer(body)) throw new ValidationError('请发送图片二进制内容。');
      service.putPhoto(request.params.id, contentType, body);
      return reply.status(204).send();
    },
  );

  app.get(
    '/api/v1/items/:id/photo',
    async (request: FastifyRequest<{ Params: ItemParams }>, reply: FastifyReply) => {
      const { service } = getServices(request);
      const photo = service.getPhoto(request.params.id);
      if (photo === undefined) throw new NotFoundError('物品图片不存在。');
      return reply
        .header('Content-Type', photo.mimeType)
        .header('Content-Disposition', 'inline')
        .header('X-Content-Type-Options', 'nosniff')
        .send(photo.bytes);
    },
  );

  app.delete(
    '/api/v1/items/:id/photo',
    async (request: FastifyRequest<{ Params: ItemParams }>, reply) => {
      const { service } = getServices(request);
      service.removePhoto(request.params.id);
      return reply.status(204).send();
    },
  );
}
