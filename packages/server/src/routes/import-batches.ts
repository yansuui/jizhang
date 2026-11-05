/**
 * Merged (multi-file) bill import batch API.
 *
 * Registered through the assistant route options so it lives inside the authenticated plugin:
 * the cookie/session guard and the CSRF hook apply exactly as they do to every other assistant
 * route, which is the trap `spec/backend/index.md` warns about ("a hook and the routes it
 * protects must be registered in ONE plugin").
 *
 * Boundaries this file respects:
 *   * `GET` never starts model work;
 *   * the review/confirm endpoints never call a provider;
 *   * every route re-checks that the batch belongs to the conversation in the path;
 *   * the legacy single-file import routes are untouched.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AssistantConversationService } from '../services/assistant-conversation-service.js';
import { ImportBatchAnalysisRunner } from '../services/import-batch-analysis.js';
import {
  ImportBatchActiveError,
  ImportBatchInvalidError,
  MERGED_BODY_LIMIT,
  MERGED_COMPARISON_PAGE_DEFAULT,
  MERGED_COMPARISON_PAGE_MAX,
  MERGED_MAX_CATEGORY_NAME_CHARS,
  MERGED_MAX_NOTE_CHARS,
  type ImportBatchConflictDecision,
  type ImportCategoryAssignment,
} from '../services/import-batch-types.js';
import { parseImportBatchFiles, parseOriginalFiles } from '../services/import-batch-service.js';

export interface ImportBatchRoutesOptions {
  readonly analysis?: ImportBatchAnalysisRunner;
  readonly resolveAnalysis?: (request: FastifyRequest) => ImportBatchAnalysisRunner;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ImportBatchInvalidError(`${field} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value)) throw new ImportBatchInvalidError(`${field} 必须是数组。`);
  if (value.length > max) throw new ImportBatchInvalidError(`${field} 最多 ${max} 项。`);
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item === '' || item.length > 200) {
      throw new ImportBatchInvalidError(`${field} 中含无效值。`);
    }
    out.push(item);
  }
  return out;
}

function parseAssignments(value: unknown, max: number): Record<string, ImportCategoryAssignment> {
  const raw = record(value, 'categoryAssignments');
  const entries = Object.entries(raw);
  if (entries.length > max) throw new ImportBatchInvalidError('分类指派数量超出限制。');
  const out: Record<string, ImportCategoryAssignment> = {};
  for (const [itemId, assignment] of entries) {
    if (itemId === '' || itemId.length > 200) throw new ImportBatchInvalidError('分类指派的账单编号无效。');
    const object = record(assignment, 'categoryAssignments[]');
    if (object['kind'] === 'existing') {
      const categoryId = object['categoryId'];
      if (typeof categoryId !== 'string' || categoryId === '' || categoryId.length > 100) {
        throw new ImportBatchInvalidError('现有分类编号无效。');
      }
      out[itemId] = { kind: 'existing', categoryId };
      continue;
    }
    if (object['kind'] === 'suggestion') {
      const suggestionId = object['suggestionId'];
      if (typeof suggestionId !== 'string' || suggestionId === '' || suggestionId.length > 100) {
        throw new ImportBatchInvalidError('新分类建议编号无效。');
      }
      out[itemId] = { kind: 'suggestion', suggestionId };
      continue;
    }
    throw new ImportBatchInvalidError('分类指派必须是 existing 或 suggestion。');
  }
  return out;
}

function parseNoteOverrides(value: unknown, max: number): Record<string, string> {
  const raw = record(value, 'noteOverrides');
  const entries = Object.entries(raw);
  if (entries.length > max) throw new ImportBatchInvalidError('备注覆盖数量超出限制。');
  const out: Record<string, string> = {};
  for (const [itemId, note] of entries) {
    if (itemId === '' || itemId.length > 200) throw new ImportBatchInvalidError('备注覆盖的账单编号无效。');
    if (typeof note !== 'string' || note.length > MERGED_MAX_NOTE_CHARS) {
      throw new ImportBatchInvalidError(`备注最多 ${MERGED_MAX_NOTE_CHARS} 个字符，空字符串表示清空备注。`);
    }
    out[itemId] = note;
  }
  return out;
}

function parseApproved(value: unknown): {
  suggestionId: string;
  resolution: 'create';
  reuseCategoryId: string | null;
  name: string;
  type: number;
  parentId: string | null;
}[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ImportBatchInvalidError('approvedCategories 必须是数组。');
  if (value.length > 20) throw new ImportBatchInvalidError('一次最多批准 20 个新分类。');
  return value.map((entry) => {
    const object = record(entry, 'approvedCategories[]');
    const suggestionId = object['suggestionId'];
    if (typeof suggestionId !== 'string' || suggestionId === '') throw new ImportBatchInvalidError('新分类建议编号无效。');
    if (object['resolution'] !== undefined && object['resolution'] !== 'create') {
      throw new ImportBatchInvalidError('approvedCategories[].resolution 仅支持 create。');
    }
    const reuseCategoryId = object['reuseCategoryId'] ?? null;
    if (reuseCategoryId !== null && (typeof reuseCategoryId !== 'string' || reuseCategoryId === '')) {
      throw new ImportBatchInvalidError('reuseCategoryId 必须是分类编号或 null。');
    }
    const name = object['name'];
    if (typeof name !== 'string' || name.trim() === '' || name.trim().length > MERGED_MAX_CATEGORY_NAME_CHARS) {
      throw new ImportBatchInvalidError(`分类名称需为 1–${MERGED_MAX_CATEGORY_NAME_CHARS} 个字符。`);
    }
    const type = object['type'];
    if (type !== 0 && type !== 1) throw new ImportBatchInvalidError('分类类型必须是 0（支出）或 1（收入）。');
    const parentId = object['parentId'] ?? null;
    if (parentId !== null && typeof parentId !== 'string') throw new ImportBatchInvalidError('parentId 必须是分类编号或 null。');
    return { suggestionId, resolution: 'create' as const, reuseCategoryId, name: name.trim(), type, parentId };
  });
}

function parseConflictDecisions(value: unknown): ImportBatchConflictDecision[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ImportBatchInvalidError('conflictDecisions 必须是数组。');
  return value.map((entry) => {
    const object = record(entry, 'conflictDecisions[]');
    const conflictGroup = object['conflictGroup'];
    if (typeof conflictGroup !== 'string' || conflictGroup === '') throw new ImportBatchInvalidError('冲突分组编号无效。');
    const chosenItemId = object['chosenItemId'] ?? null;
    if (chosenItemId !== null && (typeof chosenItemId !== 'string' || chosenItemId === '')) {
      throw new ImportBatchInvalidError('chosenItemId 必须是账单编号或 null。');
    }
    return { conflictGroup, chosenItemId };
  });
}

function integer(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new ImportBatchInvalidError(`${field} 必须是整数。`);
  return value;
}

function queryValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export async function registerImportBatchRoutes(
  app: FastifyInstance,
  options: ImportBatchRoutesOptions,
): Promise<void> {
  const getServices = (request: FastifyRequest) => {
    const analysis = options.resolveAnalysis?.(request) ?? options.analysis;
    if (analysis === undefined) throw new Error("Import analysis context unavailable");
    return { batches: analysis.service, analysis };
  };

  app.post<{ Params: { conversationId: string } }>(
    '/api/v1/assistant/conversations/:conversationId/import-batches',
    { bodyLimit: MERGED_BODY_LIMIT },
    async (request, reply) => {
      const { batches, analysis } = getServices(request);
      const body = record(request.body, 'body');
      const files = parseImportBatchFiles(body['files']);
      const clientRequestId = body['clientRequestId'];
      if (typeof clientRequestId !== 'string') throw new ImportBatchInvalidError('clientRequestId 必须是文本。');
      const analyse = body['analyse'] === undefined ? true : body['analyse'] === true;
      if (body['analyse'] !== undefined && typeof body['analyse'] !== 'boolean') {
        throw new ImportBatchInvalidError('analyse 必须是布尔值。');
      }
      const created = batches.create(request.params.conversationId, { files, analyse, clientRequestId });
      batches.appendCard(
        request.params.conversationId,
        created.batch.batchId,
        `已读取 ${created.batch.files.length} 个账单文件，融合后共 ${created.batch.summary.totalItems} 条待核对记录。`,
      );
      if (created.created && analyse && created.batch.files.every((file) => file.parseStatus === 'ok')) {
        if (!analysis.start(request.params.conversationId, created.batch.batchId)) {
          throw new ImportBatchActiveError();
        }
      } else if (!created.created) {
        // Replay: nothing to start; the stored analysis state is returned as-is.
      }
      return reply.status(created.created ? 201 : 200).send({ batch: batches.get(request.params.conversationId, created.batch.batchId) });
    },
  );

  app.get<{ Params: { conversationId: string; batchId: string } }>(
    '/api/v1/assistant/conversations/:conversationId/import-batches/:batchId',
    async (request, reply) => {
      const { batches } = getServices(request);
      reply.header('Cache-Control', 'no-store');
      return { batch: batches.get(request.params.conversationId, request.params.batchId) };
    },
  );

  app.get<{
    Params: { conversationId: string; batchId: string };
    Querystring: { limit?: unknown; cursor?: unknown; filter?: unknown; includeVersion?: unknown };
  }>(
    '/api/v1/assistant/conversations/:conversationId/import-batches/:batchId/rows',
    async (request, reply) => {
      const { batches } = getServices(request);
      reply.header('Cache-Control', 'no-store');
      return batches.rows(request.params.conversationId, request.params.batchId, {
        limit: request.query.limit,
        cursor: queryValue(request.query.cursor),
        filter: queryValue(request.query.filter),
        includeVersion: request.query.includeVersion,
      });
    },
  );

  app.get<{
    Params: { conversationId: string; batchId: string; itemId: string };
    Querystring: { limit?: unknown; cursor?: unknown };
  }>(
    '/api/v1/assistant/conversations/:conversationId/import-batches/:batchId/rows/:itemId/duplicates',
    async (request, reply) => {
      const { batches } = getServices(request);
      reply.header('Cache-Control', 'no-store');
      return batches.duplicates(
        request.params.conversationId,
        request.params.batchId,
        request.params.itemId,
        request.query.limit,
        queryValue(request.query.cursor),
      );
    },
  );

  app.get<{
    Params: { conversationId: string; batchId: string };
    Querystring: { includeVersion?: unknown };
  }>(
    '/api/v1/assistant/conversations/:conversationId/import-batches/:batchId/categories',
    async (request, reply) => {
      const { batches } = getServices(request);
      reply.header('Cache-Control', 'no-store');
      return batches.categories(request.params.conversationId, request.params.batchId, request.query.includeVersion);
    },
  );

  app.post<{ Params: { conversationId: string; batchId: string } }>(
    '/api/v1/assistant/conversations/:conversationId/import-batches/:batchId/review',
    { bodyLimit: MERGED_BODY_LIMIT },
    async (request, reply) => {
      const { batches } = getServices(request);
      const body = record(request.body, 'body');
      const selectedItemIds = stringArray(body['selectedItemIds'], 'selectedItemIds', 500);
      const viewRevision = body['viewRevision'];
      if (typeof viewRevision !== 'string' || viewRevision === '') {
        throw new ImportBatchInvalidError('viewRevision 不能为空，请先读取当前批次视图。');
      }
      return reply.status(200).send(
        batches.review(request.params.conversationId, request.params.batchId, {
          version: integer(body['version'], 'version'),
          analysisRevision: integer(body['analysisRevision'], 'analysisRevision'),
          viewRevision,
          selectedItemIds,
          categoryAssignments: parseAssignments(body['categoryAssignments'], 500),
          noteOverrides: parseNoteOverrides(body['noteOverrides'], 500),
          approvedCategories: parseApproved(body['approvedCategories']),
          conflictDecisions: parseConflictDecisions(body['conflictDecisions']),
        }),
      );
    },
  );

  app.post<{ Params: { conversationId: string; batchId: string } }>(
    '/api/v1/assistant/conversations/:conversationId/import-batches/:batchId/analyse',
    { bodyLimit: MERGED_BODY_LIMIT },
    async (request, reply) => {
      const { batches, analysis } = getServices(request);
      const body = record(request.body, 'body');
      const clientRequestId = body['clientRequestId'];
      if (typeof clientRequestId !== 'string') throw new ImportBatchInvalidError('clientRequestId 必须是文本。');
      const files = parseOriginalFiles(body['files']);
      const result = batches.analyse(request.params.conversationId, request.params.batchId, { files, clientRequestId });
      if (result.created && !analysis.start(request.params.conversationId, request.params.batchId)) {
        batches.markAnalysisNotStarted(request.params.batchId, '当前会话仍有进行中的 AI 生成，本次分析未开始，请稍后显式重试。');
        throw new ImportBatchActiveError();
      }
      return reply.status(result.created ? 202 : 200).send({ batch: batches.get(request.params.conversationId, request.params.batchId) });
    },
  );

  app.post<{ Params: { conversationId: string; batchId: string; fileIndex: string } }>(
    '/api/v1/assistant/conversations/:conversationId/import-batches/:batchId/files/:fileIndex/remove',
    { bodyLimit: MERGED_BODY_LIMIT },
    async (request, reply) => {
      const { batches } = getServices(request);
      const body = record(request.body, 'body');
      const files = parseImportBatchFiles(body['files']);
      const outcome = batches.mutateFiles(
        request.params.conversationId,
        request.params.batchId,
        'remove',
        Number(request.params.fileIndex),
        {
          expectedVersion: integer(body['expectedVersion'], 'expectedVersion'),
          clientRequestId: String(body['clientRequestId'] ?? ''),
          targetFileIndex: body['targetFileIndex'] === undefined ? undefined : integer(body['targetFileIndex'], 'targetFileIndex'),
          files,
        },
      );
      return reply.status(200).send(outcome);
    },
  );

  app.post<{ Params: { conversationId: string; batchId: string; fileIndex: string } }>(
    '/api/v1/assistant/conversations/:conversationId/import-batches/:batchId/files/:fileIndex/replace',
    { bodyLimit: MERGED_BODY_LIMIT },
    async (request, reply) => {
      const { batches } = getServices(request);
      const body = record(request.body, 'body');
      const files = parseImportBatchFiles(body['files']);
      const outcome = batches.mutateFiles(
        request.params.conversationId,
        request.params.batchId,
        'replace',
        Number(request.params.fileIndex),
        {
          expectedVersion: integer(body['expectedVersion'], 'expectedVersion'),
          clientRequestId: String(body['clientRequestId'] ?? ''),
          files,
        },
      );
      return reply.status(200).send(outcome);
    },
  );

  app.post<{ Params: { conversationId: string; batchId: string } }>(
    '/api/v1/assistant/conversations/:conversationId/import-batches/:batchId/confirm',
    { bodyLimit: MERGED_BODY_LIMIT },
    async (request, reply) => {
      const { batches } = getServices(request);
      const body = record(request.body, 'body');
      const reviewToken = body['reviewToken'];
      if (typeof reviewToken !== 'string' || reviewToken === '') throw new ImportBatchInvalidError('reviewToken 不能为空。');
      const files = parseOriginalFiles(body['files']);
      const result = batches.confirm(request.params.conversationId, request.params.batchId, {
        reviewToken,
        expectedVersion: integer(body['expectedVersion'], 'expectedVersion'),
        files,
      });
      return reply.status(200).send({ batch: result.batch, result: result.result });
    },
  );

  app.post<{ Params: { conversationId: string; batchId: string } }>(
    '/api/v1/assistant/conversations/:conversationId/import-batches/:batchId/cancel',
    async (request, reply) => {
      const { batches } = getServices(request);
      const body = request.body === undefined ? {} : record(request.body, 'body');
      const batch = batches.cancel(request.params.conversationId, request.params.batchId, {
        expectedVersion: integer(body['expectedVersion'], 'expectedVersion'),
        clientRequestId: String(body['clientRequestId'] ?? ''),
      });
      return reply.status(200).send({ batch });
    },
  );

  // Documented comparison page bounds; the service enforces them, this keeps them discoverable.
  void MERGED_COMPARISON_PAGE_DEFAULT;
  void MERGED_COMPARISON_PAGE_MAX;
  void AssistantConversationService;
}
