import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import { assistantBusinessFingerprint } from './assistant-business-fingerprint.js';
import { AssistantError, assistantJsonObject, type AssistantJsonObject } from './assistant-types.js';
import type { AssistantToolContext } from './assistant-tool-registry.js';
import { ItemService } from './item-service.js';
import { FinancialGoalsService } from './financial-goals-service.js';
import { salarySourceToken } from './financial-planning-types.js';
import { canonicalFinancialPayload } from './financial-operation-store.js';

export const WORKSPACE_KINDS = ['account', 'category', 'tag', 'transaction', 'salary', 'date-range', 'item', 'recurring', 'recurring-occurrence', 'goal', 'fund-source', 'transfer', 'trash'] as const;
export type WorkspaceKind = typeof WORKSPACE_KINDS[number];
export const NATIVE_ACTIONS = [
  { destination: 'provider-settings', title: '助手配置' }, { destination: 'invitations', title: '邀请码管理', requiresCapability: 'manageInvitations' },
  { destination: 'password', title: '修改密码' }, { destination: 'data-import', title: '导入账本 CSV' },
  { destination: 'platform-import', title: '导入微信或支付宝账单' }, { destination: 'data-export', title: '导出账本' },
  { destination: 'item-photo', title: '物品照片', requiresItem: true }, { destination: 'item-cutout', title: '物品抠图', requiresItem: true },
  { destination: 'reminders', title: '记账与复盘提醒' }, { destination: 'logout', title: '退出登录' }, { destination: 'server-switch', title: '切换服务器' },
] as const;
export const hashWorkspace = (value: unknown): string => createHash('sha256').update(value === undefined ? 'undefined' : canonicalFinancialPayload(value)).digest('hex');
export function workspaceError(status: number, code: string, message: string): never { throw new AssistantError(status, `ASSISTANT_WORKSPACE_${code}`, message); }
export function workspaceRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) workspaceError(400, 'INVALID', '请求内容无效。');
  return value as Record<string, unknown>;
}
export function workspaceString(value: unknown, max = 120): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) workspaceError(400, 'INVALID', '编号或文本无效。');
  return value;
}
export function workspaceOnly(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) workspaceError(400, 'INVALID', '请求包含不支持的字段。');
}
export function ledgerFingerprint(c: AssistantToolContext): string { return assistantBusinessFingerprint(c.db, 'workspace', {}, c.now()); }
export function dayScope(date: unknown, timeZone: unknown): { date: string; timeZone: string; from: number; to: number } {
  if (typeof date !== 'string' || !/^[2-9]\d{3}-\d{2}-\d{2}$/.test(date) || timeZone !== 'Asia/Shanghai') workspaceError(400, 'INVALID', '请使用有效日期和账本时区 Asia/Shanghai。');
  const midnight = Date.parse(`${date}T00:00:00+08:00`);
  if (!Number.isFinite(midnight) || new Date(midnight + 8 * 3600000).toISOString().slice(0, 10) !== date) workspaceError(400, 'INVALID', '日期无效。');
  return { date, timeZone, from: midnight, to: midnight + 86400000 };
}
interface WorkflowRow { id: string; conversation_id: string; original_request: string; phase: string; facts_json: string; updated_at: number }
interface InteractionRow {
  id: string; workflow_id: string; conversation_id: string; generation_id: string; kind: WorkspaceKind; title: string;
  multiple: number; filters_json: string; fingerprint: string; expires_at: number; status: string; answer_hash: string | null; answer_generation_id: string | null;
}
export interface SelectionItem { id: string; title: string; subtitle?: string; amountCents?: number; date?: number; facts?: AssistantJsonObject }

/** Bounded private state, independent of how many chat messages still fit the prompt. */
export class AssistantWorkspaceStore {
  constructor(readonly db: Db, readonly now: () => number = Date.now) {}
  enabled(generationId: string): boolean { return this.binding(generationId) !== undefined; }
  binding(generationId: string): { workflow_id: string; daily_json: string | null } | undefined {
    return this.db.prepare('SELECT workflow_id,daily_json FROM assistant_workspace_generations WHERE generation_id=?').get(generationId) as { workflow_id: string; daily_json: string | null } | undefined;
  }
  bind(conversationId: string, generationId: string, original: string, workflowId?: string, daily?: AssistantJsonObject): void {
    if (this.binding(generationId)) return;
    if (!workflowId) {
      this.db.prepare("UPDATE assistant_interactions SET status='cancelled' WHERE conversation_id=? AND status='pending'").run(conversationId);
      this.db.prepare("UPDATE assistant_workflows SET phase='cancelled',updated_at=? WHERE conversation_id=? AND phase='awaiting-selection'").run(this.now(), conversationId);
    }
    const id = workflowId ?? this.createWorkflow(conversationId, original);
    const row = this.db.prepare('SELECT facts_json FROM assistant_workflows WHERE id=? AND conversation_id=?').get(id, conversationId) as { facts_json: string } | undefined;
    if (!row) workspaceError(404, 'NOT_FOUND', '没有找到原任务。');
    const frozenDaily = workspaceRecord(JSON.parse(row.facts_json))['dailyReview'];
    if (daily && frozenDaily && hashWorkspace(daily) !== hashWorkspace(frozenDaily)) workspaceError(409, 'CONFLICT', '复盘日期与原任务不同。');
    const effectiveDaily = daily ?? frozenDaily;
    if (daily) this.merge(id, 'dailyReview', daily);
    this.db.prepare('INSERT INTO assistant_workspace_generations(generation_id,workflow_id,daily_json) VALUES(?,?,?)').run(generationId, id, effectiveDaily ? JSON.stringify(effectiveDaily) : null);
    this.db.prepare('UPDATE assistant_workflows SET phase=?,updated_at=? WHERE id=? AND conversation_id=?').run(effectiveDaily ? 'reporting' : 'reading', this.now(), id, conversationId);
  }
  createWorkflow(conversationId: string, original: string): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO assistant_workflows(id,conversation_id,original_request,phase,created_at,updated_at) VALUES(?,?,?,\'reading\',?,?)').run(id, conversationId, original.slice(0, 2000), this.now(), this.now());
    return id;
  }
  workflow(conversationId: string, id?: string): AssistantJsonObject | null {
    this.reconcile(conversationId);
    const row = (id ? this.db.prepare('SELECT * FROM assistant_workflows WHERE id=? AND conversation_id=?').get(id, conversationId)
      : this.db.prepare('SELECT * FROM assistant_workflows WHERE conversation_id=? ORDER BY updated_at DESC,rowid DESC LIMIT 1').get(conversationId)) as WorkflowRow | undefined;
    if (!row) return null;
    const generation = this.db.prepare('SELECT generation_id FROM assistant_workspace_generations WHERE workflow_id=? ORDER BY rowid DESC LIMIT 1').get(row.id) as { generation_id: string } | undefined;
    return { version: 1, id: row.id, originalRequest: row.original_request, phase: row.phase, generationId: generation?.generation_id ?? null, updatedAt: row.updated_at };
  }
  reconcile(conversationId?: string): void {
    const rows = (conversationId ? this.db.prepare("SELECT id,conversation_id,phase FROM assistant_workflows WHERE conversation_id=? AND phase NOT IN ('completed','cancelled','failed')").all(conversationId)
      : this.db.prepare("SELECT id,conversation_id,phase FROM assistant_workflows WHERE phase NOT IN ('completed','cancelled','failed')").all()) as { id: string; conversation_id: string; phase: string }[];
    for (const row of rows) {
      const conversation = this.db.prepare('SELECT archived FROM assistant_conversations WHERE id=?').get(row.conversation_id) as { archived: number } | undefined;
      const generation = this.db.prepare(`SELECT g.status FROM assistant_workspace_generations w JOIN assistant_generations g ON g.id=w.generation_id WHERE w.workflow_id=? ORDER BY w.rowid DESC LIMIT 1`).get(row.id) as { status: string } | undefined;
      let phase = row.phase;
      if (!conversation || conversation.archived || generation?.status === 'cancelled' || generation?.status === 'interrupted') phase = 'cancelled';
      else if (generation?.status === 'failed') phase = 'failed';
      else if (row.phase === 'awaiting-confirmation') {
        const actions = this.db.prepare('SELECT p.status,w.continuation_generation_id FROM assistant_workspace_actions w JOIN assistant_pending_actions p ON p.id=w.action_id WHERE w.workflow_id=?').all(row.id) as { status: string; continuation_generation_id: string | null }[];
        if (actions.length && !actions.some((v) => v.status === 'pending')) phase = actions.some((v) => v.status === 'confirmed' && !v.continuation_generation_id) ? 'awaiting-continuation' : 'cancelled';
      }
      if (phase !== row.phase) this.db.prepare('UPDATE assistant_workflows SET phase=?,updated_at=? WHERE id=?').run(phase, this.now(), row.id);
      if (phase === 'cancelled' || phase === 'failed') this.db.prepare("UPDATE assistant_interactions SET status='cancelled' WHERE workflow_id=? AND status='pending'").run(row.id);
    }
  }
  facts(generationId: string): AssistantJsonObject | null {
    const bound = this.binding(generationId); if (!bound) return null;
    const row = this.db.prepare('SELECT original_request,facts_json FROM assistant_workflows WHERE id=?').get(bound.workflow_id) as WorkflowRow;
    return { originalRequest: row.original_request, ...assistantJsonObject(JSON.parse(row.facts_json), '任务事实'), ...(bound.daily_json ? { dailyReview: assistantJsonObject(JSON.parse(bound.daily_json), '每日复盘') } : {}) };
  }
  phase(generationId: string, phase: string): void {
    const bound = this.binding(generationId); if (bound) this.db.prepare('UPDATE assistant_workflows SET phase=?,updated_at=? WHERE id=?').run(phase, this.now(), bound.workflow_id);
  }
  merge(workflowId: string, key: string, value: unknown): void {
    const row = this.db.prepare('SELECT facts_json FROM assistant_workflows WHERE id=?').get(workflowId) as { facts_json: string };
    const facts = { ...workspaceRecord(JSON.parse(row.facts_json)), [key]: value };
    if (Buffer.byteLength(JSON.stringify(facts)) > 64 * 1024) workspaceError(400, 'LIMIT', '任务选择较多，请分成较小的任务。');
    this.db.prepare('UPDATE assistant_workflows SET facts_json=?,updated_at=? WHERE id=?').run(JSON.stringify(facts), this.now(), workflowId);
  }
  rememberSelection(workflowId: string, value: AssistantJsonObject): void {
    const row = this.db.prepare('SELECT facts_json FROM assistant_workflows WHERE id=?').get(workflowId) as { facts_json: string };
    const previous = workspaceRecord(JSON.parse(row.facts_json))['selections'];
    const selections = Array.isArray(previous) ? previous : [];
    if (selections.length >= 32) workspaceError(400, 'LIMIT', '这项任务的选择较多，请拆分为较小任务。');
    this.merge(workflowId, 'selections', [...selections, value]);
  }
  rowInteraction(conversationId: string, id: string): InteractionRow {
    const row = this.db.prepare('SELECT * FROM assistant_interactions WHERE id=? AND conversation_id=?').get(id, conversationId) as InteractionRow | undefined;
    if (!row) workspaceError(404, 'NOT_FOUND', '没有找到这张选择卡。');
    return row;
  }
  createSelection(c: AssistantToolContext, args: AssistantJsonObject): AssistantJsonObject {
    if (!c.conversationId || !c.generationId) workspaceError(400, 'INVALID', '请在支持选择卡的对话中使用。');
    const binding = this.binding(c.generationId); if (!binding) workspaceError(400, 'INVALID', '当前客户端不支持选择卡。');
    const kind = args['kind'] as WorkspaceKind;
    let effectiveArgs = args;
    const previous = this.facts(c.generationId)?.['selection_date_range'];
    if (['transaction', 'salary', 'fund-source', 'goal'].includes(kind) && previous && typeof previous === 'object' && !Array.isArray(previous)) {
      const range = workspaceRecord(previous)['dateRange'];
      if (range && typeof range === 'object' && !Array.isArray(range)) {
        const bounds = workspaceRecord(range);
        effectiveArgs = { ...args, ...(args['from'] === undefined && typeof bounds['fromMs'] === 'number' ? { from: bounds['fromMs'] } : {}), ...(args['to'] === undefined && typeof bounds['toMs'] === 'number' ? { to: bounds['toMs'] } : {}) };
      }
    }
    const id = randomUUID();
    this.db.prepare(`INSERT INTO assistant_interactions(id,workflow_id,conversation_id,generation_id,kind,title,multiple,filters_json,fingerprint,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(id, binding.workflow_id, c.conversationId, c.generationId, kind, args['question'], args['multiple'] === true ? 1 : 0, JSON.stringify(effectiveArgs), ledgerFingerprint(c), this.now() + 1200000);
    this.phase(c.generationId, 'awaiting-selection');
    return this.interaction(c, c.conversationId, id, 0, 30);
  }
  candidates(c: AssistantToolContext, row: InteractionRow, extraSearch = ''): SelectionItem[] {
    const filter = workspaceRecord(JSON.parse(row.filters_json));
    const type = filter['type'] === 0 || filter['type'] === 1 ? filter['type'] : undefined;
    const salaryRows = () => {
      const clauses = ['deleted=0']; const values: (string | number)[] = [];
      for (const [key, sql] of [['from', 'date>=?'], ['to', 'date<?'], ['accountId', 'account_id=?']] as const) {
        const value = filter[key]; if (typeof value === 'number' || typeof value === 'string') { clauses.push(sql); values.push(value); }
      }
      if (typeof filter['q'] === 'string') { clauses.push('instr(lower(note),lower(?))>0'); values.push(filter['q']); }
      const rows = c.db.prepare(`SELECT id,amount_cents,date,account_id,deleted FROM salary_records WHERE ${clauses.join(' AND ')} ORDER BY date DESC,id LIMIT 10001`).all(...values) as { id: string; amount_cents: number; date: number; account_id: string; deleted: number }[];
      if (rows.length > 10000) workspaceError(400, 'LIMIT', '收入来源较多，请缩小日期范围。');
      return rows;
    };
    let items: SelectionItem[];
    switch (row.kind) {
      case 'account': items = c.services.masterData.listAccounts().map((v) => ({ id: v.id, title: v.name, subtitle: `账户类型 ${v.type}` })); break;
      case 'category': {
        const rows = c.services.masterData.listCategories(type); const names = new Map(rows.map((v) => [v.id, v.name]));
        items = rows.map((v) => ({ id: v.id, title: v.name, subtitle: `${v.type === 0 ? '支出' : '收入'}${v.parentId ? ` · ${names.get(v.parentId) ?? '历史上级分类'}` : ' · 顶级分类'}` })); break;
      }
      case 'tag': {
        const rows = c.db.prepare('SELECT id,name,parent_id FROM tags WHERE deleted=0 ORDER BY name,id').all() as { id: string; name: string; parent_id: string | null }[];
        const names = new Map(rows.map((v) => [v.id, v.name]));
        items = rows.map((v) => ({ id: v.id, title: v.name, ...(v.parent_id ? { subtitle: names.get(v.parent_id) ?? '历史上级标签' } : { subtitle: '顶级标签' }) })); break;
      }
      case 'salary': {
        items = salaryRows().map((row) => c.services.salaries.getByIdOrThrow(row.id)).map((v) => ({ id: v.id, title: v.note || '分配收入', amountCents: v.amountCents, date: v.date, subtitle: v.accountId })); break;
      }
      case 'fund-source': {
        items = salaryRows().map((v) => ({ id: v.id, title: c.services.salaries.getByIdOrThrow(v.id).note || '收入来源', amountCents: v.amount_cents, date: v.date, subtitle: v.account_id,
          facts: { salaryId: v.id, expectedSourceToken: salarySourceToken(v), salary: assistantJsonObject(c.services.salaries.getByIdOrThrow(v.id), '分配来源') } })); break;
      }
      case 'item': {
        const service = new ItemService(c.db, { now: c.now, actorId: c.actorId }); const first = service.list({ limit: 100 });
        if (first.total > 10000) workspaceError(400, 'LIMIT', '物品较多，请分批选择。');
        const rows = [...first.items]; for (let offset = rows.length; offset < first.total; offset += 100) rows.push(...service.list({ limit: 100, offset }).items);
        items = rows.map((v) => ({ id: v.id, title: v.name, subtitle: `${v.category ?? ''} · ${v.status}`, ...(v.purchasePriceCents === null ? {} : { amountCents: v.purchasePriceCents }), date: v.purchaseDate })); break;
      }
      case 'recurring': items = c.services.recurring.listRules().map((v) => ({ id: v.id, title: v.name, amountCents: v.amountCents, subtitle: `${v.frequency} · ${v.enabled ? '启用' : '停用'}` })); break;
      case 'recurring-occurrence': {
        const names = new Map(c.services.recurring.listRules().map((v) => [v.id, v.name]));
        items = c.services.recurring.listPending().map((v) => ({ id: v.id, title: names.get(v.ruleId) ?? v.note ?? '待确认周期账单', amountCents: v.amountCents, date: v.plannedDate })); break;
      }
      case 'goal': {
        const service = new FinancialGoalsService(c.db, { now: c.now, actorId: c.actorId });
        const query = { ...(typeof filter['from'] === 'number' ? { from: filter['from'] } : {}), ...(typeof filter['to'] === 'number' ? { to: filter['to'] } : {}) };
        let page = service.listEntries({ ...query, limit: 100 }); const rows = [...page.items];
        while (page.hasMore && page.nextCursor) { if (rows.length >= 10000) workspaceError(400, 'LIMIT', '目标记录较多，请分批选择。'); page = service.listEntries({ ...query, limit: 100, cursor: page.nextCursor }); rows.push(...page.items); }
        items = rows.map((v) => ({ id: v.id, title: v.note || (v.goal === 'reserve' ? '储备目标' : '投资目标'), amountCents: v.amountCents, date: v.date, subtitle: `${v.goal} · ${v.kind}`, facts: { revision: page.revision } })); break;
      }
      case 'transfer': {
        const first = c.services.transfers.list({ limit: 500 }); if (first.total > 10000) workspaceError(400, 'LIMIT', '转账较多，请分批选择。');
        const rows = [...first.items]; for (let offset = rows.length; offset < first.total; offset += 500) rows.push(...c.services.transfers.list({ limit: 500, offset }).items);
        items = rows.map((v) => ({ id: v.id, title: v.note || '账户转账', amountCents: v.amountCents, date: v.date, subtitle: `${v.fromAccountId} → ${v.toAccountId}` })); break;
      }
      case 'trash': {
        const total = c.services.transactions.countDeleted(); if (total > 10000) workspaceError(400, 'LIMIT', '回收站记录较多，请分批选择。');
        items = []; for (let offset = 0; offset < total; offset += 500) items.push(...c.services.transactions.listDeleted(500, offset).map((v) => ({ id: v.id, title: v.note || '已删除账单', amountCents: v.amountCents, date: v.date })));
        break;
      }
      case 'transaction': {
        const query = { ...(type === undefined ? {} : { type }), ...(typeof filter['q'] === 'string' ? { q: filter['q'] } : {}),
          ...(typeof filter['from'] === 'number' ? { from: filter['from'] } : {}), ...(typeof filter['to'] === 'number' ? { to: filter['to'] } : {}),
          ...(typeof filter['accountId'] === 'string' ? { accountId: filter['accountId'] } : {}), ...(typeof filter['categoryId'] === 'string' ? { categoryId: filter['categoryId'] } : {}), ...(typeof filter['tagId'] === 'string' ? { tagId: filter['tagId'] } : {}) };
        const data = c.services.transactions.list({ ...query, limit: 500 });
        if (data.total > 10000) workspaceError(400, 'LIMIT', '记录较多，请缩小查询范围。');
        const rows = [...data.items];
        for (let offset = rows.length; offset < data.total; offset += 500) rows.push(...c.services.transactions.list({ ...query, limit: 500, offset }).items);
        const accounts = new Map(c.services.masterData.listAccounts(true).map((v) => [v.id, v.name]));
        const categories = new Map(c.services.masterData.listCategories(undefined, true).map((v) => [v.id, v.name]));
        items = rows.map((v) => ({ id: v.id, title: v.note || (v.type === 0 ? '支出' : '收入'), subtitle: `${accounts.get(v.accountId) ?? v.accountId} · ${categories.get(v.categoryId) ?? v.categoryId}`, amountCents: v.amountCents, date: v.date })); break;
      }
      default: return [];
    }
    const q = `${typeof filter['q'] === 'string' && row.kind !== 'transaction' ? filter['q'] : ''} ${extraSearch}`.trim().toLocaleLowerCase();
    return (q ? items.filter((v) => `${v.title} ${v.subtitle ?? ''}`.toLocaleLowerCase().includes(q)) : items).map((v) => ({ ...v, title: v.title.slice(0, 200) }));
  }
  interaction(c: AssistantToolContext, conversationId: string, id: string, offset = 0, limit = 30, q = ''): AssistantJsonObject {
    const row = this.rowInteraction(conversationId, id);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || q.length > 200) workspaceError(400, 'INVALID', '分页条件无效。');
    const all = this.candidates(c, row, q);
    return { version: 1, type: 'selection', id: row.id, kind: row.kind, title: row.title, multiple: row.multiple === 1,
      expiresAt: row.expires_at, status: row.status, items: all.slice(offset, offset + limit).map((v) => ({ ...v, title: v.title.slice(0, 200), ...(v.subtitle ? { subtitle: v.subtitle.slice(0, 200) } : {}) })),
      page: { offset, limit, total: all.length, hasMore: offset + limit < all.length } };
  }
  recordResult(messageId: string, conversationId: string, name: string, args: AssistantJsonObject): void {
    this.db.prepare('INSERT OR IGNORE INTO assistant_workspace_results(message_id,conversation_id,tool_name,arguments_json) VALUES(?,?,?,?)').run(messageId, conversationId, name, JSON.stringify(args));
  }
  linkAction(actionId: string, conversationId: string, generationId: string): void {
    const bound = this.binding(generationId); if (!bound) return;
    this.db.prepare('INSERT OR IGNORE INTO assistant_workspace_actions(action_id,conversation_id,workflow_id) VALUES(?,?,?)').run(actionId, conversationId, bound.workflow_id);
    this.phase(generationId, 'awaiting-confirmation');
  }
}
