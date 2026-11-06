/** Authenticated public proxy for the private item-cutout worker. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/index.js';
import { requireUserId } from '../plugins/auth.js';
import { ItemCutoutClient } from '../services/item-cutout-client.js';
import { validateItemPhotoBytes } from '../services/item-service.js';
import { NotFoundError, ValidationError } from '../services/transaction-service.js';

export interface ItemCutoutRoutesOptions {
  readonly serviceUrl: string | undefined;
  readonly fetchImpl?: typeof fetch;
  readonly identityDb?: Db | undefined;
}

interface JobParams {
  readonly jobId: string;
}

interface CandidateParams extends JobParams {
  readonly candidateId: string;
}

export async function registerItemCutoutRoutes(
  app: FastifyInstance,
  options: ItemCutoutRoutesOptions,
): Promise<void> {
  const client = new ItemCutoutClient(options.serviceUrl, options.fetchImpl ?? fetch);
  const assertOwner = (request: FastifyRequest, jobId: string): void => {
    if (options.identityDb === undefined) return; // Explicit single-user test/legacy mode.
    const row = options.identityDb.prepare(
      'SELECT 1 FROM cutout_job_owners WHERE job_id = ? AND user_id = ?',
    ).get(jobId, requireUserId(request));
    if (row === undefined) throw new NotFoundError('Image processing job not found.');
  };

  app.post('/api/v1/items/cutouts', async (request: FastifyRequest, reply) => {
    reply.header('Cache-Control', 'no-store');
    const contentType = request.headers['content-type']?.split(';', 1)[0]?.toLowerCase() ?? '';
    const body: unknown = request.body;
    if (!['image/webp', 'image/jpeg', 'image/png'].includes(contentType)) {
      throw new ValidationError('AI 抠图输入必须为压缩后的 JPEG、PNG 或 WebP 图片。');
    }
    if (!Buffer.isBuffer(body)) throw new ValidationError('请发送图片二进制内容。');
    validateItemPhotoBytes(contentType, body);
    const job = await client.createJob(body, contentType);
    if (options.identityDb !== undefined) {
      try {
        options.identityDb.prepare(
          'INSERT INTO cutout_job_owners (job_id, user_id, created_at) VALUES (?, ?, ?)',
        ).run(job.jobId, requireUserId(request), Date.now());
      } catch (error) {
        // Do not publish an unowned worker job. If creation collided with an existing
        // mapping, cancelling it would affect another user; leave that job alone.
        const existing = options.identityDb.prepare('SELECT 1 FROM cutout_job_owners WHERE job_id = ?').get(job.jobId);
        if (existing === undefined) await client.cancelJob(job.jobId).catch(() => undefined);
        throw error;
      }
    }
    return reply.status(202).send(job);
  });

  app.get(
    '/api/v1/items/cutouts/:jobId',
    async (request: FastifyRequest<{ Params: JobParams }>, reply) => {
      assertOwner(request, request.params.jobId);
      reply.header('Cache-Control', 'no-store');
      return reply.send(await client.getJob(request.params.jobId));
    },
  );

  app.delete(
    '/api/v1/items/cutouts/:jobId',
    async (request: FastifyRequest<{ Params: JobParams }>, reply) => {
      assertOwner(request, request.params.jobId);
      reply.header('Cache-Control', 'no-store');
      await client.cancelJob(request.params.jobId);
      return reply.status(204).send();
    },
  );

  app.get(
    '/api/v1/items/cutouts/:jobId/candidates/:candidateId/preview',
    async (request: FastifyRequest<{ Params: CandidateParams }>, reply: FastifyReply) => {
      assertOwner(request, request.params.jobId);
      reply
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff');
      const bytes = await client.getCandidatePreview(
        request.params.jobId,
        request.params.candidateId,
      );
      return reply
        .header('Content-Type', 'image/webp')
        .header('Content-Disposition', 'inline')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'no-store')
        .send(bytes);
    },
  );

  app.get(
    '/api/v1/items/cutouts/:jobId/candidates/:candidateId/image',
    async (request: FastifyRequest<{ Params: CandidateParams }>, reply: FastifyReply) => {
      assertOwner(request, request.params.jobId);
      reply
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff');
      const bytes = await client.getCandidateImage(
        request.params.jobId,
        request.params.candidateId,
      );
      return reply
        .header('Content-Type', 'image/png')
        .header('Content-Disposition', 'inline; filename="item-cutout.png"')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'no-store')
        .send(bytes);
    },
  );
}
