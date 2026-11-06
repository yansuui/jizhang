import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AssistantWorkspaceService, CreateWorkspaceTurn } from '../services/assistant-workspace-service.js';
import type { AssistantCsvImportService } from '../services/assistant-csv-import-service.js';
import type { AssistantGenerationService } from '../services/assistant-generation-service.js';
import type { AssistantGenerationRunner } from '../services/assistant-generation-runner.js';
import type { ConversationActiveLock } from '../services/assistant-active-lock.js';
import type { AiConfigService } from '../services/ai-config-service.js';
import { supportsAssistantStream } from '../services/ai-provider-service.js';
import { workspaceCapabilities } from '../services/assistant-workspace-tools.js';
import { AssistantToolRegistry } from '../services/assistant-tool-registry.js';
import { workspaceError, workspaceRecord } from '../services/assistant-workspace-store.js';

interface WorkspaceServices {
  workspace: AssistantWorkspaceService; csvImports: AssistantCsvImportService; generations: AssistantGenerationService;
  runner: AssistantGenerationRunner; activeLock: ConversationActiveLock; aiConfigService: AiConfigService;
  now: () => number; withConversationLock: <T>(operation: () => T) => T;
}
export async function registerAssistantWorkspaceRoutes(app: FastifyInstance, resolve: (request: FastifyRequest) => WorkspaceServices): Promise<void> {
  const create = (s: WorkspaceServices): CreateWorkspaceTurn => (cid, text, requestId, workflowId, daily) => s.withConversationLock(() => s.workspace.context.db.transaction(() => {
    if (s.activeLock.legacyActive(cid) || s.activeLock.batchActive(cid)) workspaceError(409, 'ACTIVE', '当前会话仍在处理，请先等待或停止。');
    let delivery: 'stream' | 'buffered' = 'buffered';
    try { delivery = supportsAssistantStream(s.aiConfigService.getStoredOrThrow()) ? 'stream' : 'buffered'; } catch { /* Runner owns visible configuration failure. */ }
    const result = s.generations.create(cid, { version: 1, clientRequestId: requestId, input: { type: 'text', text } }, { delivery, today: new Date(s.now()).toLocaleDateString('en-CA') });
    s.workspace.store.bind(cid, result.generation.id, text, workflowId, daily);
    return result;
  })());
  const prefix = '/api/v1/assistant';
  app.get(`${prefix}/workspace/capabilities`, async () => workspaceCapabilities(new AssistantToolRegistry().catalog()));
  app.post(`${prefix}/data-import/preview`, { bodyLimit: 3 * 1024 * 1024 }, async (request) => resolve(request).csvImports.preview(request.body));
  app.post<{ Params: { id: string } }>(`${prefix}/data-import/:id/confirm`, { bodyLimit: 3 * 1024 * 1024 }, async (request) => resolve(request).csvImports.confirm(request.params.id, request.body));
  app.get<{ Params: { cid: string } }>(`${prefix}/conversations/:cid/workspace`, async (request) => {
    const s = resolve(request); s.workspace.conversations.get(request.params.cid); return { workflow: s.workspace.store.workflow(request.params.cid) };
  });
  app.get<{ Params: { cid: string; iid: string } }>(`${prefix}/conversations/:cid/workspace/interactions/:iid`, async (request) => resolve(request).workspace.interaction(request.params.cid, request.params.iid, workspaceRecord(request.query)));
  app.post<{ Params: { cid: string; iid: string } }>(`${prefix}/conversations/:cid/workspace/interactions/:iid/answer`, async (request, reply) => {
    const s = resolve(request); const result = s.workspace.answer(request.params.cid, request.params.iid, request.body, create(s));
    if (result.created) void s.runner.start(request.params.cid, result.generation.id);
    return reply.status(result.created ? 202 : 200).send(result);
  });
  app.get<{ Params: { cid: string; aid: string } }>(`${prefix}/conversations/:cid/workspace/actions/:aid`, async (request) => resolve(request).workspace.draft(request.params.cid, request.params.aid));
  app.post<{ Params: { cid: string; aid: string } }>(`${prefix}/conversations/:cid/workspace/actions/:aid/revise`, async (request) => resolve(request).workspace.revise(request.params.cid, request.params.aid, request.body));
  app.post<{ Params: { cid: string; aid: string } }>(`${prefix}/conversations/:cid/workspace/actions/:aid/continue`, async (request, reply) => {
    const s = resolve(request); const result = s.workspace.continueAction(request.params.cid, request.params.aid, request.body, create(s));
    if (result.created) void s.runner.start(request.params.cid, result.generation.id);
    return reply.status(result.created ? 202 : 200).send(result);
  });
  app.post<{ Params: { cid: string; mid: string } }>(`${prefix}/conversations/:cid/workspace/results/:mid/page`, async (request) => resolve(request).workspace.page(request.params.cid, request.params.mid, request.body));
  app.post<{ Params: { cid: string } }>(`${prefix}/conversations/:cid/workspace/organization/card`, async (request) => resolve(request).workspace.organizationCard(request.params.cid, request.body));
  app.post<{ Params: { cid: string } }>(`${prefix}/conversations/:cid/workspace/organization/prepare`, async (request) => resolve(request).workspace.organizationPrepare(request.params.cid, request.body));
  app.post<{ Params: { cid: string } }>(`${prefix}/conversations/:cid/workspace/daily-review`, async (request, reply) => {
    const s = resolve(request); const result = s.workspace.dailyReview(request.params.cid, request.body, create(s));
    if (result.created) void s.runner.start(request.params.cid, result.generation.id);
    return reply.status(result.created ? 202 : 200).send(result);
  });
}
