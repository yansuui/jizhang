import { randomUUID } from 'node:crypto';
import { AssistantConversationService } from './assistant-conversation-service.js';
import { AssistantGenerationService } from './assistant-generation-service.js';
import { AssistantToolRegistry, type AssistantToolContext, type AssistantPreparedTool } from './assistant-tool-registry.js';
import { assistantJsonObject, type AssistantJsonObject, type AssistantPendingActionDto } from './assistant-types.js';
import type { AssistantGenerationCreateResult } from './assistant-stream-types.js';
import { AssistantWorkspaceStore, dayScope, hashWorkspace, ledgerFingerprint, workspaceError, workspaceOnly, workspaceRecord, workspaceString } from './assistant-workspace-store.js';
import { MAX_ASSISTANT_MESSAGE_EVENT_BYTES } from './assistant-turn-policy.js';
import { projectAssistantReadResult } from './assistant-result-projection.js';
import { ItemService } from './item-service.js';
import { organizationPage } from './assistant-organization-page.js';
import { nativeCompletionMatches, nativeCompletionReference, verifyNativeCompletion } from './assistant-native-completion.js';

export type CreateWorkspaceTurn = (conversationId: string, text: string, requestId: string, workflowId: string, daily?: AssistantJsonObject) => AssistantGenerationCreateResult;
const immutable = (key: string): boolean => key === 'id' || key === 'operationId' || key === 'contractVersion' || /(?:token|revision|fingerprint|hash)$/i.test(key) || key.startsWith('expected');

/** Deterministic UI interactions wrap existing domain adapters; they never confirm writes. */
export class AssistantWorkspaceService {
  readonly store: AssistantWorkspaceStore;
  private readonly registry = new AssistantToolRegistry();
  constructor(readonly context: AssistantToolContext, readonly conversations: AssistantConversationService, readonly generations: AssistantGenerationService) {
    this.store = new AssistantWorkspaceStore(context.db, context.now);
  }
  private own(conversationId: string): void { if (this.conversations.get(conversationId).archived) workspaceError(409, 'STALE', '会话已归档，请使用当前会话。'); }
  private pending(conversationId: string, id: string): AssistantPendingActionDto {
    this.own(conversationId); const action = this.conversations.pending(id);
    if (action.conversationId !== conversationId) workspaceError(404, 'NOT_FOUND', '没有找到这份草案。');
    return action;
  }
  private request(conversationId: string, kind: string, requestId: string, body: unknown): Record<string, unknown> | null {
    workspaceString(requestId);
    const old = this.context.db.prepare('SELECT request_hash,response_json FROM assistant_workspace_requests WHERE conversation_id=? AND kind=? AND request_id=?').get(conversationId, kind, requestId) as { request_hash: string; response_json: string } | undefined;
    if (!old) return null;
    if (old.request_hash !== hashWorkspace(body)) workspaceError(409, 'CONFLICT', '这个请求编号已用于其他内容。');
    return workspaceRecord(JSON.parse(old.response_json));
  }
  private saveRequest(conversationId: string, kind: string, requestId: string, body: unknown, response: unknown): void {
    this.context.db.prepare('INSERT INTO assistant_workspace_requests(conversation_id,kind,request_id,request_hash,response_json) VALUES(?,?,?,?,?)').run(conversationId, kind, requestId, hashWorkspace(body), JSON.stringify(response));
  }
  interaction(conversationId: string, id: string, query: Record<string, unknown>): { interaction: AssistantJsonObject } {
    this.own(conversationId);
    workspaceOnly(query, ['offset', 'limit', 'q']);
    return { interaction: this.store.interaction(this.context, conversationId, id, Number(query['offset'] ?? 0), Number(query['limit'] ?? 30), typeof query['q'] === 'string' ? query['q'] : '') };
  }
  answer(conversationId: string, id: string, raw: unknown, create: CreateWorkspaceTurn): AssistantGenerationCreateResult & { workflow: AssistantJsonObject | null } {
    this.own(conversationId);
    const body = workspaceRecord(raw); workspaceOnly(body, ['clientRequestId', 'selectedIds', 'dateRange']);
    const requestId = workspaceString(body['clientRequestId']);
    return this.context.db.transaction(() => {
      const row = this.store.rowInteraction(conversationId, id);
      let answer: AssistantJsonObject;
      if (row.kind === 'date-range') {
        if (body['selectedIds'] !== undefined) workspaceError(400, 'INVALID', '日期卡不能选择资源编号。');
        const range = workspaceRecord(body['dateRange']); workspaceOnly(range, ['from', 'to', 'timeZone']);
        const from = dayScope(range['from'], range['timeZone']); const to = dayScope(range['to'], range['timeZone']);
        if (from.from > to.from || to.to - from.from > 3660 * 86400000) workspaceError(400, 'INVALID', '日期范围无效或过长。');
        answer = { kind: row.kind, dateRange: { from: from.date, to: to.date, timeZone: from.timeZone, fromMs: from.from, toMs: to.to } };
      } else {
        const ids = body['selectedIds'];
        if (body['dateRange'] !== undefined || !Array.isArray(ids) || ids.length < 1 || ids.length > (row.multiple ? 100 : 1) || ids.some((v) => typeof v !== 'string' || v.length > 200) || new Set(ids).size !== ids.length) workspaceError(400, 'INVALID', '请选择卡片中的有效记录。');
        const ordered = (ids as string[]).slice().sort();
        // Hash/replay before revalidation: an identical committed answer remains recoverable
        // after its subsequent confirmed write changes the ledger.
        answer = { kind: row.kind, selectedIds: ordered };
      }
      const answerHash = hashWorkspace(answer);
      this.request(conversationId, 'interaction', requestId, { interactionId: id, answerHash });
      if (row.answer_generation_id) {
        if (row.answer_hash !== answerHash) workspaceError(409, 'CONFLICT', '这张卡已选择其他内容。');
        return { created: false, generation: this.generations.get(conversationId, row.answer_generation_id), workflow: this.store.workflow(conversationId, row.workflow_id) };
      }
      if (row.status !== 'pending' || row.expires_at < this.context.now() || this.generations.get(conversationId, row.generation_id).status !== 'completed' || row.fingerprint !== ledgerFingerprint(this.context)) workspaceError(409, 'STALE', '选择卡已过期或账本发生变化，请重新读取。');
      if (row.kind !== 'date-range') {
        const allowed = new Map(this.store.candidates(this.context, row).map((v) => [v.id, v]));
        const ids = answer['selectedIds'] as string[];
        if (ids.some((v) => !allowed.has(v))) workspaceError(409, 'STALE', '选中记录不属于这张卡。');
        answer = { ...answer, items: ids.map((v) => ({ ...allowed.get(v)! })) };
      }
      this.store.merge(row.workflow_id, `selection_${row.kind.replace('-', '_')}`, answer);
      this.store.rememberSelection(row.workflow_id, { interactionId: row.id, question: row.title, ...answer });
      const result = create(conversationId, `已通过选择卡核对${row.title}。请继续原任务；只使用已验证的选择。`, requestId, row.workflow_id);
      this.context.db.prepare('UPDATE assistant_interactions SET status=\'answered\',answer_hash=?,answer_generation_id=? WHERE id=?').run(answerHash, result.generation.id, id);
      this.saveRequest(conversationId, 'interaction', requestId, { interactionId: id, answerHash }, { generationId: result.generation.id });
      return { ...result, workflow: this.store.workflow(conversationId, row.workflow_id) };
    })();
  }
  draft(conversationId: string, id: string): { action: Record<string, unknown> } {
    const action = this.pending(conversationId, id);
    const tool = this.registry.get(action.toolName); if (!tool) workspaceError(409, 'STALE', '这项功能已停用。');
    const schema = tool.definition.inputSchema;
    const properties = Object.fromEntries(Object.entries(workspaceRecord(schema['properties'] ?? {})).filter(([key]) => !immutable(key)));
    return { action: { id: action.id, conversationId, status: action.status, toolName: action.toolName, arguments: action.arguments,
      inputSchema: { ...schema, properties, required: Array.isArray(schema['required']) ? schema['required'].filter((v) => typeof v === 'string' && !immutable(v)) : [] } } };
  }
  async revise(conversationId: string, id: string, raw: unknown): Promise<Record<string, unknown>> {
    const body = workspaceRecord(raw); workspaceOnly(body, ['clientRequestId', 'arguments']);
    const requestId = workspaceString(body['clientRequestId']);
    const old = this.request(conversationId, `revise:${id}`, requestId, body); if (old) return this.refreshedResponse(conversationId, old);
    const action = this.pending(conversationId, id);
    if (action.status !== 'pending' || action.attachment) workspaceError(409, 'STALE', '这份草案不能再修改，请使用对应审核工作区。');
    const args = assistantJsonObject(body['arguments'], '修改参数');
    const checkImmutable = (before: unknown, after: unknown): void => {
      if (before === null || typeof before !== 'object' || Array.isArray(before)) return;
      const next = workspaceRecord(after);
      for (const [key, value] of Object.entries(before)) {
        if (immutable(key) && hashWorkspace(value) !== hashWorkspace(next[key])) workspaceError(400, 'INVALID', '版本、操作编号和来源校验字段不能修改。');
        if (value !== null && typeof value === 'object' && !Array.isArray(value) && next[key] !== undefined) checkImmutable(value, next[key]);
      }
    };
    checkImmutable(action.arguments, args);
    const prepared = await this.registry.prepare(this.context, action.toolName, args);
    return this.context.db.transaction(() => {
      const replay = this.request(conversationId, `revise:${id}`, requestId, body); if (replay) return this.refreshedResponse(conversationId, replay);
      if (this.pending(conversationId, id).status !== 'pending') workspaceError(409, 'STALE', '草案状态已变化，请重新查看。');
      this.conversations.setPendingStatus(id, 'cancelled', null);
      const oldMessage = this.conversations.messages(conversationId).find((m) => m.content.card?.actionId === id);
      if (oldMessage) this.conversations.updateCardStatus(oldMessage.id, 'cancelled');
      const response = this.persistPrepared(conversationId, prepared, action.sourceMessageId, `已替代旧草案，请核对新内容后确认。`);
      const replacement = workspaceRecord(response['action']);
      const link = this.ensureActionWorkflow(conversationId, action);
      this.context.db.prepare('INSERT INTO assistant_workspace_actions(action_id,conversation_id,workflow_id) VALUES(?,?,?)').run(replacement['id'], conversationId, link);
      this.saveRequest(conversationId, `revise:${id}`, requestId, body, response);
      return response;
    })();
  }
  private refreshedResponse(conversationId: string, response: Record<string, unknown>): Record<string, unknown> {
    this.own(conversationId); const id = workspaceString(workspaceRecord(response['action'])['id']); const action = this.pending(conversationId, id);
    return { ...response, messages: this.conversations.messages(conversationId), action: { id, conversationId, status: action.status } };
  }
  private persistPrepared(conversationId: string, prepared: AssistantPreparedTool, sourceMessageId: string, text = ''): Record<string, unknown> {
    const id = randomUUID();
    const content = { version: 1 as const, text, card: { version: 1 as const, actionId: id, toolName: prepared.toolName, operation: prepared.operation,
      summary: prepared.summary, writes: true as const, affected: prepared.affected, values: prepared.values, warnings: prepared.warnings,
      fingerprint: prepared.fingerprint, status: 'pending' as const, preview: prepared.preview } };
    if (Buffer.byteLength(JSON.stringify(content)) + 1024 > MAX_ASSISTANT_MESSAGE_EVENT_BYTES) workspaceError(400, 'LIMIT', '预览内容较多，请缩小操作范围后分批核对。');
    const action = this.conversations.createPendingAction({ id, conversationId, sourceMessageId, toolName: prepared.toolName, arguments: prepared.arguments, preview: prepared.preview, fingerprint: prepared.fingerprint });
    this.conversations.appendMessage({ conversationId, role: 'assistant', kind: 'tool-card', content });
    return { messages: this.conversations.messages(conversationId), action: { id, conversationId, status: action.status } };
  }
  private ensureActionWorkflow(conversationId: string, action: AssistantPendingActionDto): string {
    const link = this.context.db.prepare('SELECT workflow_id FROM assistant_workspace_actions WHERE action_id=? AND conversation_id=?').get(action.id, conversationId) as { workflow_id: string } | undefined;
    if (link) return link.workflow_id;
    // The action/terminal commit is authoritative. Recover its original generation
    // binding if the process stopped before the best-effort action-index insert.
    const sourceBinding = this.context.db.prepare(`SELECT w.workflow_id FROM assistant_generations g
      JOIN assistant_workspace_generations w ON w.generation_id=g.id WHERE g.conversation_id=? AND g.user_message_id=?`).get(conversationId, action.sourceMessageId) as { workflow_id: string } | undefined;
    if (sourceBinding) {
      this.context.db.prepare('INSERT INTO assistant_workspace_actions(action_id,conversation_id,workflow_id) VALUES(?,?,?)').run(action.id, conversationId, sourceBinding.workflow_id);
      return sourceBinding.workflow_id;
    }
    const source = this.conversations.getMessage(action.sourceMessageId);
    const workflowId = this.store.createWorkflow(conversationId, source.content.text ?? '继续已确认的账本操作');
    this.context.db.prepare('INSERT INTO assistant_workspace_actions(action_id,conversation_id,workflow_id) VALUES(?,?,?)').run(action.id, conversationId, workflowId);
    return workflowId;
  }
  continueAction(conversationId: string, id: string, raw: unknown, create: CreateWorkspaceTurn): AssistantGenerationCreateResult & { workflow: AssistantJsonObject | null } {
    const body = workspaceRecord(raw); workspaceOnly(body, ['clientRequestId']); const requestId = workspaceString(body['clientRequestId']);
    return this.context.db.transaction(() => {
      const action = this.pending(conversationId, id);
      this.request(conversationId, 'continue', requestId, { actionId: id });
      if (action.status !== 'confirmed') workspaceError(409, 'STALE', '请先确认原草案，再继续任务。');
      const workflowId = this.ensureActionWorkflow(conversationId, action);
      const link = this.context.db.prepare('SELECT continuation_generation_id FROM assistant_workspace_actions WHERE action_id=?').get(id) as { continuation_generation_id: string | null };
      if (link.continuation_generation_id) return { created: false, generation: this.generations.get(conversationId, link.continuation_generation_id), workflow: this.store.workflow(conversationId, workflowId) };
      const args = action.arguments;
      const result = action.result ?? {};
      const tx = workspaceRecord(result['transaction'] ?? {});
      const resourceId = typeof args['id'] === 'string' ? args['id'] : typeof tx['id'] === 'string' ? tx['id'] : undefined;
      const fullBalances = this.context.services.balances.balances();
      const balances = { ...fullBalances, items: fullBalances.items.slice(0, 100), total: fullBalances.items.length, offset: 0, limit: 100, hasMore: fullBalances.items.length > 100 };
      let readBack: unknown = { balances };
      if (resourceId && action.toolName.startsWith('transaction.')) {
        const current = this.context.services.transactions.getById(resourceId);
        const transaction = current ? { ...current,
          ...(current.refundDetails ? { refundDetails: current.refundDetails.slice(0, 100), refundDetailsTotal: current.refundDetails.length, refundDetailsHaveMore: current.refundDetails.length > 100 } : {}),
          ...(current.refundLinkedTxIds ? { refundLinkedTxIds: current.refundLinkedTxIds.slice(0, 100), refundLinkedTotal: current.refundLinkedTxIds.length, refundLinkedHaveMore: current.refundLinkedTxIds.length > 100 } : {}) } : null;
        readBack = { transaction, balances };
      }
      else if (resourceId && action.toolName.startsWith('item.')) readBack = { item: new ItemService(this.context.db, { now: this.context.now, actorId: this.context.actorId }).getById(resourceId) ?? null };
      const facts = projectAssistantReadResult({ toolName: action.toolName, summary: '原操作已由用户确认，已重新读取当前结果。', data: assistantJsonObject({ actionId: id, toolName: action.toolName, result, readBack, checkedAt: this.context.now() }, '确认事实') }, {}).data;
      this.store.merge(workflowId, 'lastConfirmedAction', facts);
      const turn = create(conversationId, '原草案已由用户确认并执行。请核对权威结果，继续原任务；任何新的修改仍须单独确认。', requestId, workflowId);
      this.context.db.prepare('UPDATE assistant_workspace_actions SET continuation_generation_id=? WHERE action_id=?').run(turn.generation.id, id);
      this.saveRequest(conversationId, 'continue', requestId, { actionId: id }, { generationId: turn.generation.id });
      this.store.phase(turn.generation.id, 'reporting');
      return { ...turn, workflow: this.store.workflow(conversationId, workflowId) };
    })();
  }
  async page(conversationId: string, messageId: string, raw: unknown): Promise<Record<string, unknown>> {
    this.own(conversationId); const body = workspaceRecord(raw); workspaceOnly(body, ['offset', 'limit']);
    const row = this.context.db.prepare('SELECT tool_name,arguments_json FROM assistant_workspace_results WHERE message_id=? AND conversation_id=?').get(messageId, conversationId) as { tool_name: string; arguments_json: string } | undefined;
    if (!row) workspaceError(404, 'NOT_FOUND', '这条结果没有可继续的分页。');
    const args = assistantJsonObject(JSON.parse(row.arguments_json), '原查询');
    if (row.tool_name === 'organization.preview') {
      const original = this.conversations.getMessage(messageId).content.result;
      const preview = await this.context.services.organization.preview({ explain: false });
      if (preview.previewHash !== original?.data['previewHash']) workspaceError(409, 'STALE', '整理范围已变化，请重新预览。');
      return { result: { version: 1, ...projectAssistantReadResult(organizationPage(preview, Number(body['offset']), Number(body['limit'])), {}) } };
    }
    const definition = this.registry.get(row.tool_name)?.definition;
    const props = workspaceRecord(definition?.inputSchema['properties'] ?? {});
    if (!('offset' in props) || !('limit' in props)) workspaceError(400, 'INVALID', '这项查询不支持偏移分页。');
    const result = await this.registry.read(this.context, row.tool_name, { ...args, offset: body['offset'], limit: body['limit'] });
    return { result: { version: 1, ...result } };
  }
  async organizationCard(conversationId: string, raw: unknown): Promise<Record<string, unknown>> {
    this.own(conversationId); const body = workspaceRecord(raw); workspaceOnly(body, ['runId', 'offset', 'limit']);
    const result = await this.registry.read(this.context, 'spending.card', body);
    return { result: { version: 1, ...result } };
  }
  async organizationPrepare(conversationId: string, raw: unknown): Promise<Record<string, unknown>> {
    this.own(conversationId); const body = workspaceRecord(raw); workspaceOnly(body, ['clientRequestId', 'kind', 'runId', 'previewMessageId', 'actionIds']);
    const requestId = workspaceString(body['clientRequestId']); const replay = this.request(conversationId, 'organization', requestId, body); if (replay) return this.refreshedResponse(conversationId, replay);
    const ids = body['actionIds'];
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some((v) => typeof v !== 'string') || new Set(ids).size !== ids.length) workspaceError(400, 'INVALID', '请明确选择1至100条有效建议。');
    let name: string; let args: AssistantJsonObject;
    let originalMessage: import('./assistant-types.js').AssistantMessageDto | undefined;
    if (body['kind'] === 'spending') {
      name = 'spending.apply'; args = { runId: workspaceString(body['runId']), actionIds: ids as string[] };
      originalMessage = this.conversations.messages(conversationId).find((message) => {
        const run = message.content.result?.data['run'];
        return !!run && typeof run === 'object' && !Array.isArray(run) && workspaceRecord(run)['runId'] === body['runId'];
      });
    }
    else if (body['kind'] === 'structural') {
      const message = this.conversations.getMessage(workspaceString(body['previewMessageId']));
      if (message.conversationId !== conversationId || message.content.result?.toolName !== 'organization.preview' || typeof message.content.result.data['previewHash'] !== 'string') workspaceError(404, 'NOT_FOUND', '没有找到原整理预览。');
      name = 'organization.apply'; args = { previewHash: message.content.result.data['previewHash'], actionIds: ids as string[] };
      originalMessage = message;
    } else workspaceError(400, 'INVALID', '整理类型无效。');
    const prepared = await this.registry.prepare(this.context, name, args);
    return this.context.db.transaction(() => {
      this.own(conversationId); const old = this.request(conversationId, 'organization', requestId, body); if (old) return this.refreshedResponse(conversationId, old);
      const source = this.conversations.appendMessage({ conversationId, role: 'user', kind: 'text', content: { version: 1, text: `已通过卡片选择 ${ids.length} 条整理建议，请生成待确认预览。` } });
      const response = this.persistPrepared(conversationId, prepared, source.id);
      const existing = originalMessage?.content.generationId ? this.store.binding(originalMessage.content.generationId) : undefined;
      const workflowId = existing?.workflow_id ?? this.store.createWorkflow(conversationId, `核对并应用明确选择的${body['kind'] === 'spending' ? '历史账单' : '分类与标签'}整理建议。`);
      this.context.db.prepare('INSERT INTO assistant_workspace_actions(action_id,conversation_id,workflow_id) VALUES(?,?,?)').run(workspaceRecord(response['action'])['id'], conversationId, workflowId);
      this.context.db.prepare("UPDATE assistant_workflows SET phase='awaiting-confirmation',updated_at=? WHERE id=?").run(this.context.now(), workflowId);
      this.saveRequest(conversationId, 'organization', requestId, body, response); return response;
    })();
  }
  dailyReview(conversationId: string, raw: unknown, create: CreateWorkspaceTurn): AssistantGenerationCreateResult & { workflow: AssistantJsonObject | null } {
    this.own(conversationId); const body = workspaceRecord(raw); workspaceOnly(body, ['clientRequestId', 'date', 'timeZone']); const requestId = workspaceString(body['clientRequestId']);
    const scope = dayScope(body['date'], body['timeZone']);
    return this.context.db.transaction(() => {
      const replay = this.request(conversationId, 'daily', requestId, body);
      if (replay) {
        const id = workspaceString(replay['generationId']); return { created: false, generation: this.generations.get(conversationId, id), workflow: this.store.workflow(conversationId, workspaceString(replay['workflowId'])) };
      }
      const text = `请复盘 ${scope.date} 的账本，时区 ${scope.timeZone}。使用权威当日事实，只读，不修改账本；潜在异常仅作为核对建议。`;
      const workflowId = this.store.createWorkflow(conversationId, text);
      const result = create(conversationId, text, requestId, workflowId, { date: scope.date, timeZone: scope.timeZone });
      this.saveRequest(conversationId, 'daily', requestId, body, { generationId: result.generation.id, workflowId });
      return { ...result, workflow: this.store.workflow(conversationId, workflowId) };
    })();
  }
  nativeCompletion(conversationId: string, raw: unknown, create: CreateWorkspaceTurn): AssistantGenerationCreateResult & { workflow: AssistantJsonObject | null } {
    this.own(conversationId);
    const body = workspaceRecord(raw); workspaceOnly(body, ['clientRequestId', 'sourceMessageId', 'reference']);
    const requestId = workspaceString(body['clientRequestId']); const sourceMessageId = workspaceString(body['sourceMessageId']);
    const reference = nativeCompletionReference(body['reference']);
    const identity = { sourceMessageId, reference };
    return this.context.db.transaction(() => {
      const source = this.conversations.getMessage(sourceMessageId);
      if (source.conversationId !== conversationId || source.role !== 'assistant' || source.content.result?.toolName !== 'workspace.open' || !source.content.generationId) workspaceError(404, 'NOT_FOUND', '没有找到当前会话的原生入口。');
      const nativeAction = source.content.result.data['nativeAction'];
      if (!nativeAction || typeof nativeAction !== 'object' || Array.isArray(nativeAction) || !nativeCompletionMatches(workspaceRecord(nativeAction), reference)) workspaceError(409, 'CONFLICT', '操作回执与原生入口不一致。');
      const binding = this.store.binding(source.content.generationId);
      if (!binding || this.generations.get(conversationId, source.content.generationId).status !== 'completed') workspaceError(409, 'STALE', '原生入口尚未完成或已失效。');
      const receiptId = hashWorkspace(identity);
      const requestReplay = this.request(conversationId, 'native', requestId, identity);
      const replay = requestReplay ?? this.request(conversationId, 'native-receipt', receiptId, identity);
      if (replay) {
        if (!requestReplay) this.saveRequest(conversationId, 'native', requestId, identity, replay);
        return { created: false, generation: this.generations.get(conversationId, workspaceString(replay['generationId'])), workflow: this.store.workflow(conversationId, binding.workflow_id) };
      }
      const verified = verifyNativeCompletion(this.context, conversationId, reference, source.createdAt);
      const facts = { sourceMessageId, ...verified, checkedAt: this.context.now() };
      this.store.merge(binding.workflow_id, 'lastNativeOutcome', facts);
      this.conversations.appendMessage({ conversationId, role: 'assistant', kind: 'result', content: { version: 1, text: '已重新核实原生工作区结果，将继续原任务。', result: { version: 1, toolName: 'workspace.open', summary: '服务器已核实原生结果；设备保存、分享和操作来源仅按明确证据描述。', data: { nativeCompletion: facts } } } });
      const turn = create(conversationId, '原生工作区已返回服务器核实的结果。请读取 lastNativeOutcome，继续原任务；不能推断设备分享或操作来源，任何新的修改仍须单独确认。', requestId, binding.workflow_id);
      const response = { generationId: turn.generation.id };
      this.saveRequest(conversationId, 'native', requestId, identity, response);
      this.saveRequest(conversationId, 'native-receipt', receiptId, identity, response);
      this.store.phase(turn.generation.id, 'reporting');
      return { ...turn, workflow: this.store.workflow(conversationId, binding.workflow_id) };
    })();
  }
}
