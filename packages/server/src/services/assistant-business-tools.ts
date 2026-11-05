/** Explicit business adapters for the assistant. No URLs, SQL or service names come from the model. */
import { createHash, randomUUID } from 'node:crypto';
import { dateOnly, resolveStatsWindow } from '@jizhang/shared';
import type { Db } from '../db/index.js';
import { FinancialFundService } from './financial-fund-service.js';
import { FinancialGoalsService } from './financial-goals-service.js';
import { FinancialPlanService } from './financial-plan-service.js';
import { FinancialPlanningService } from './financial-planning-service.js';
import { MonthlyPlanService } from './monthly-plan-service.js';
import { ItemService } from './item-service.js';
import { AiSpendingOrganizationService } from './ai-spending-organization-service.js';
import type { InternalTool, AssistantToolContext, AssistantToolDefinition } from './assistant-tool-registry.js';
import { AssistantActionStaleError, AssistantValidationError, assistantJsonObject, type AssistantJsonObject, type AssistantJsonValue, type AssistantToolName } from './assistant-types.js';

type Context = AssistantToolContext;
type Args = AssistantJsonObject;
type Fields = Readonly<Record<string, AssistantJsonObject>>;
const text = { type: 'string', minLength: 1, maxLength: 200 } as const;
const integer = { type: 'integer', minimum: 0 } as const;
const money = { type: 'integer', minimum: 1 } as const;
const boolean = { type: 'boolean' } as const;
const object = { type: 'object' } as const;
const array = { type: 'array', maxItems: 100 } as const;
const page = { limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: integer } as const;
const id = { id: text } as const;
const operation = { operationId: { ...text, description: 'Omit for a new draft; the server generates and persists its UUID.' } } as const;
const ratios = { type: 'object', required: ['growth', 'reserve', 'essentials', 'joy'], additionalProperties: false,
  properties: { growth: integer, reserve: integer, essentials: integer, joy: integer } } as const;
const sourceRef = { type: 'object', required: ['salaryId', 'expectedSourceToken'], additionalProperties: false, properties: { salaryId: text, expectedSourceToken: text } } as const;
const proposal = { type: 'object', additionalProperties: false,
  required: ['periodId', 'expectedRevision', 'expectedConfigRevision', 'expectedMappingRevision', 'selectedSources', 'mappingPolicy', 'reason'],
  properties: { periodId: { type: ['string', 'null'] }, expectedRevision: integer, expectedConfigRevision: integer, expectedMappingRevision: integer,
    selectedSources: { ...array, items: sourceRef }, mappingPolicy: { enum: ['preserve', 'current'] }, reason: { enum: ['salary-confirmation', 'income-reconciliation', 'mapping-restatement'] } } } as const;

function json(value: unknown): Args { return assistantJsonObject(value, '业务工具'); }
function projectedResult(value: unknown): Args {
  const omitted: { path: string; total: number; shown: number }[] = [];
  const inspect = (input: unknown, path: string, depth: number): void => {
    if (depth > 8 || input === null || typeof input !== 'object') return;
    if (Array.isArray(input)) {
      if (input.length > 200) omitted.push({ path, total: input.length, shown: 200 });
      input.slice(0, 200).forEach((child, index) => inspect(child, `${path}[${index}]`, depth + 1));
    } else for (const [key, child] of Object.entries(input)) inspect(child, `${path}.${key}`, depth + 1);
  };
  inspect(value, '$', 0);
  const result = json(value);
  return omitted.length ? { ...result, truncatedCollections: omitted.slice(0, 100) } : result;
}
function str(args: Args, key: string): string { return args[key] as string; }
function num(args: Args, key: string, fallback = 0): number { return typeof args[key] === 'number' ? args[key] : fallback; }
function fields(args: Args, omit: readonly string[]): Args { return Object.fromEntries(Object.entries(args).filter(([key]) => !omit.includes(key))); }
function paged<T>(values: readonly T[], args: Args) {
  const offset = num(args, 'offset'); const limit = num(args, 'limit', 100);
  return { items: values.slice(offset, offset + limit), total: values.length, offset, limit, hasMore: offset + limit < values.length };
}
function actor(c: Context): string { return c.actorId ?? planning(c).resolveActorId(); }
function planning(c: Context): FinancialPlanningService { return new FinancialPlanningService(c.db, { now: c.now, actorId: c.actorId }); }
function funds(c: Context): FinancialFundService { return new FinancialFundService(c.db, { now: c.now }); }
function goals(c: Context): FinancialGoalsService { return new FinancialGoalsService(c.db, { now: c.now, actorId: c.actorId }); }
function items(c: Context): ItemService { return new ItemService(c.db, { now: c.now, actorId: c.actorId }); }
function spending(c: Context): AiSpendingOrganizationService { return new AiSpendingOrganizationService(c.db, c.config, c.provider, { now: c.now }); }

/** Validate the small JSON-schema subset used by these explicit adapters, before any service call. */
function validate(value: AssistantJsonValue | undefined, schema: Args, path: string): void {
  if (schema['enum'] instanceof Array && !schema['enum'].includes(value as never)) throw new AssistantValidationError(`${path} 不在允许范围内。`);
  const type = schema['type'];
  const nullable = Array.isArray(type) && type.includes('null');
  if (value === null && nullable) return;
  const base = Array.isArray(type) ? type.find((entry) => entry !== 'null') : type;
  if (base === 'string') {
    if (typeof value !== 'string' || value.length < num(schema, 'minLength') || value.length > num(schema, 'maxLength', 2000)) throw new AssistantValidationError(`${path} 文本无效或过长。`);
  } else if (base === 'integer' || base === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (base === 'integer' && !Number.isSafeInteger(value)) || value < num(schema, 'minimum', -Number.MAX_SAFE_INTEGER) || value > num(schema, 'maximum', Number.MAX_SAFE_INTEGER)) throw new AssistantValidationError(`${path} 数值无效。`);
  } else if (base === 'boolean') {
    if (typeof value !== 'boolean') throw new AssistantValidationError(`${path} 必须为布尔值。`);
  } else if (base === 'array') {
    if (!Array.isArray(value) || value.length < num(schema, 'minItems') || value.length > num(schema, 'maxItems', 100)) throw new AssistantValidationError(`${path} 列表数量无效。`);
    if (schema['items']) value.forEach((entry, index) => validate(entry, schema['items'] as Args, `${path}[${index}]`));
  } else if (base === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new AssistantValidationError(`${path} 必须为对象。`);
    if (schema['properties']) {
      // This is our static schema, not model data. Credential-key normalization
      // belongs to payloads; schema properties can legitimately describe hashes.
      const properties = schema['properties'] as Args;
      for (const required of (schema['required'] ?? []) as readonly string[]) if (!(required in value)) throw new AssistantValidationError(`${path}.${required} 为必填项。`);
      for (const [key, entry] of Object.entries(value)) {
        if (!properties[key]) { if (schema['additionalProperties'] === false) throw new AssistantValidationError(`${path} 包含未知字段 ${key}。`); }
        else validate(entry, properties[key] as Args, `${path}.${key}`);
      }
    }
  }
}

function definition(name: AssistantToolName, access: 'read' | 'write', description: string, properties: Fields, required: readonly string[]): AssistantToolDefinition {
  return { name, access, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}

/** Only these ledger tables participate. Auth, provider credentials, chat and run progress never do. */
const BUSINESS_TABLES = [
  'accounts', 'categories', 'tags', 'transactions', 'refund_links', 'salary_records', 'transfers',
  'budget_allocations', 'budget_templates', 'recurring_rules', 'recurring_occurrences', 'asset_items',
  'financial_config_revisions', 'financial_mapping_revisions', 'financial_periods', 'financial_period_revisions',
  'financial_period_sources', 'financial_refund_splits', 'financial_refund_split_sets', 'financial_bill_purpose_events',
  'financial_fund_config_revisions', 'financial_fund_grants', 'financial_fund_grant_revisions', 'financial_fund_grant_sources',
  'financial_fund_purposes', 'financial_fund_purpose_events', 'financial_fund_migration_issues',
  'manual_goal_openings', 'manual_goal_entries', 'manual_goal_state', 'ai_organization_audit', 'ai_organization_operations',
] as const;

/** Conservative CAS over private business facts. Stream hashing avoids a giant model-facing snapshot. */
export function assistantBusinessFingerprint(db: Db, name: string, args: Args, now: number): string {
  const hash = createHash('sha256').update(name).update(JSON.stringify(args));
  if (name === 'recurring.generate') hash.update(String(dateOnly(now)));
  for (const table of BUSINESS_TABLES) {
    hash.update(table);
    for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate()) hash.update(JSON.stringify(row));
  }
  hash.update(JSON.stringify(db.prepare("SELECT * FROM settings WHERE key IN ('financial.plan.v1','budget.cycle_start_day') ORDER BY key").all()));
  return hash.digest('hex');
}

/**
 * Reuse domain validation and its derived preview in a rollback-only SQLite transaction.
 * Only synchronous database-only domain writers are registered here: no files/providers/jobs.
 * The sentinel is caught outside better-sqlite3's transaction so every path rolls back.
 */
export function simulateAssistantWrite<T>(c: Context, run: () => T): T {
  const rollback = new Error('assistant-preview-rollback');
  let result!: T;
  try { c.db.transaction(() => { result = run(); if (result instanceof Promise) throw new Error('Assistant preview adapters must be synchronous.'); throw rollback; })(); }
  catch (error) { if (error !== rollback) throw error; }
  return result;
}

type Read = (c: Context, args: Args) => unknown | Promise<unknown>;
type Write = (c: Context, args: Args) => unknown;
const tools: InternalTool[] = [];
function read(name: AssistantToolName, description: string, properties: Fields, required: readonly string[], run: Read): void {
  const def = definition(name, 'read', description, properties, required);
  tools.push({ definition: def, parseArguments: (value) => { const args = json(value); validate(args, def.inputSchema, name); return args; },
    read: async (c, args) => ({ toolName: name, summary: description, data: projectedResult(await run(c, args)) }) });
}
function write(name: AssistantToolName, description: string, properties: Fields, required: readonly string[], run: Write,
  display?: (c: Context, args: Args, outcome: unknown) => Args): void {
  const def = definition(name, 'write', description, properties, required);
  tools.push({ definition: def, parseArguments: (value) => { const args = json(value); validate(args, def.inputSchema, name); return args; },
    prepare: (c, input) => {
      // Constructor recovery owns process state as well as SQLite. Initialize it
      // before opening a rollback-only validation transaction, never inside one.
      if (name === 'spending.apply' || name === 'spending.undo') spending(c);
      const args = 'operationId' in properties && !input['operationId'] ? { ...input, operationId: randomUUID() } : input;
      const fingerprint = assistantBusinessFingerprint(c.db, name, args, c.now());
      const outcome = simulateAssistantWrite(c, () => run(c, args));
      const preview = display ? display(c, args, outcome) : projectedResult({ request: args, outcome: outcome ?? null });
      const ids = typeof args['id'] === 'string' ? [args['id']] : Array.isArray(args['actionIds']) ? args['actionIds'] as string[] : undefined;
      const result = outcome && typeof outcome === 'object' && !Array.isArray(outcome) ? outcome as Record<string, unknown> : {};
      let count = ids?.length ?? 1;
      if (name === 'recurring.generate') count = result['created'] as number;
      if (name === 'trash.restore-all') count = result['restored'] as number;
      if (name === 'trash.purge-all') count = result['purged'] as number;
      if (name === 'spending.undo') count = (result['appliedActions'] as unknown[]).length;
      if (name === 'planning.mapping') count = new Set([...planning(c).readMapping().rules.map((rule) => rule.categoryId), ...(args['rules'] as Args[]).map((rule) => rule['categoryId'])]).size;
      if (name === 'planning.confirm' || name === 'planning.reconcile') count = (result['affectedPeriodIds'] as unknown[]).length;
      if (name === 'planning.refund-splits') count = (args['splits'] as unknown[]).length;
      if (name === 'funds.review') count = (args['sources'] as unknown[]).length;
      return { toolName: name, operation: description, summary: `确认后${description}`, affected: { count, ...(ids ? { ids } : {}) },
        values: { ...args,
          ...(typeof args['accountId'] === 'string' ? { accountName: c.services.masterData.getAccountOrThrow(args['accountId']).name } : {}),
          ...(typeof args['categoryId'] === 'string' ? { categoryName: c.services.masterData.getCategoryOrThrow(args['categoryId']).name } : {}),
        }, warnings: ['仅在确认后写入；预览中的新建编号是临时值。'], preview, arguments: args, fingerprint };
    },
    confirm: (c, raw) => {
      const expected = raw['__fingerprint'];
      const args = fields(raw, ['__fingerprint']);
      validate(args, def.inputSchema, name);
      if (typeof expected !== 'string' || expected !== assistantBusinessFingerprint(c.db, name, args, c.now())) throw new AssistantActionStaleError();
      const result = run(c, args);
      return { toolName: name, summary: `已完成：${description}`, data: projectedResult(result === undefined ? { completed: true } : result) };
    } });
}

const txQuery = { ...page, from: integer, to: integer, type: { type: 'integer', enum: [0, 1] }, categoryId: text, accountId: text,
  tag: text, tagId: text, q: text, search: { type: 'string', maxLength: 4000 }, includeDeleted: boolean,
  expectedExpenseCents: integer, expectedExpenseCount: integer } as const;
read('transactions.query', '分页查询完整账单，保留账户、日期、分类、标签及高级搜索条件；total 大于本页时继续 offset，不能把本页当全部。', txQuery, [],
  (c, a) => c.services.transactions.list({ ...a, limit: num(a, 'limit', 50) }));
read('transaction.details', '查询账单详情及双向退款关联。', id, ['id'], (c, a) => ({ transaction: c.services.transactions.getByIdOrThrow(str(a, 'id')) }));
read('transactions.daily', '查询筛选范围内服务端日汇总，最多32天。', { ...txQuery, timeZone: text }, ['from', 'to', 'timeZone'], (c, a) => c.services.transactions.dailySummary(a));
read('master-data.read', '分页查询分类、账户、标签层级和引用数量，创建账单前先获取真实编号。', { kind: { enum: ['categories', 'accounts', 'tags', 'tag-names', 'category-usage', 'account-usage'] }, ...id, ...page, includeDeleted: boolean }, ['kind'], (c, a) => {
  switch (a['kind']) {
    case 'categories': return paged(c.services.masterData.listCategories(undefined, a['includeDeleted'] === true), a);
    case 'accounts': return paged(c.services.masterData.listAccounts(a['includeDeleted'] === true), a);
    case 'tags': return paged(c.services.masterData.listTagHierarchy(), a);
    case 'tag-names': return paged(c.services.masterData.listTags(), a);
    case 'category-usage': return { count: c.services.masterData.countTransactionsForCategory(requiredId(a)) };
    default: return { count: c.services.masterData.countTransactionsForAccount(requiredId(a)) };
  }
});
function requiredId(a: Args): string { if (typeof a['id'] !== 'string' || !a['id']) throw new AssistantValidationError('id 为必填项。'); return a['id']; }
write('master-data.move', '调整分类或账户顺序。', { kind: { enum: ['category', 'account'] }, ...id, direction: { type: 'integer', enum: [-1, 1] } }, ['kind', 'id', 'direction'],
  (c, a) => ({ items: a['kind'] === 'category' ? c.services.masterData.moveCategory(str(a, 'id'), a['direction'] as -1 | 1) : c.services.masterData.moveAccount(str(a, 'id'), a['direction'] as -1 | 1) }));
write('tag.create', '创建层级标签。', { name: text, parentId: { type: ['string', 'null'] } }, ['name'], (c, a) => ({ tag: c.services.masterData.createTag(a['name'], a['parentId']) }));
write('tag.update', '修改层级标签。', { ...id, name: text, parentId: { type: ['string', 'null'] } }, ['id'], (c, a) => ({ tag: c.services.masterData.updateTag(str(a, 'id'), fields(a, ['id'])) }));
write('tag.remove', '删除层级标签。', id, ['id'], (c, a) => c.services.masterData.deleteTagById(str(a, 'id')));
read('transfers.query', '分页查询转账或读取指定转账。', { ...id, ...page, accountId: text }, [], (c, a) => a['id'] ? { transfer: c.services.transfers.getByIdOrThrow(str(a, 'id')) } : c.services.transfers.list(a));
write('transfer.update', '修改转账。', { ...id, fromAccountId: text, toAccountId: text, amountCents: money, date: integer, note: { type: 'string', maxLength: 200 } }, ['id'], (c, a) => ({ transfer: c.services.transfers.update(str(a, 'id'), fields(a, ['id'])) }));
write('transfer.delete', '删除转账。', id, ['id'], (c, a) => c.services.transfers.softDelete(str(a, 'id')));
read('trash.list', '分页查询回收站；total 是完整数量。', page, [], (c, a) => ({ items: c.services.transactions.listDeleted(num(a, 'limit', 100), num(a, 'offset')), total: c.services.transactions.countDeleted(), limit: num(a, 'limit', 100), offset: num(a, 'offset'), hasMore: num(a, 'offset') + num(a, 'limit', 100) < c.services.transactions.countDeleted() }));
write('trash.restore-all', '恢复回收站的全部账单。', {}, [], (c) => ({ restored: c.services.transactions.restoreAll() }));
write('trash.purge', '永久删除选定的回收站账单（不能撤销）。', id, ['id'], (c, a) => c.services.transactions.purge(str(a, 'id')));
write('trash.purge-all', '永久清空回收站（不能撤销）。', {}, [], (c) => ({ purged: c.services.transactions.purgeAll() }));

const ruleFields = { name: text, type: { type: 'integer', enum: [0, 1] }, amountCents: money, categoryId: text, accountId: text,
  frequency: { enum: ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'] }, anchorDate: integer, enabled: boolean } as const;
read('recurring.rules', '分页查询周期规则、发生记录或待确认账单。', { view: { enum: ['rules', 'occurrences', 'pending'] }, ...page }, [], (c, a) => {
  if (a['view'] === 'occurrences') return paged(c.services.recurring.listOccurrences(), a);
  if (a['view'] === 'pending') return paged(c.services.recurring.listPending(), a);
  return paged(c.services.recurring.listRules(), a);
});
write('recurring.create', '创建周期账单规则。', ruleFields, ['name', 'type', 'amountCents', 'categoryId', 'accountId', 'frequency', 'anchorDate'], (c, a) => ({ rule: c.services.recurring.createRule(a) }));
write('recurring.update', '修改周期账单规则。', { ...id, ...ruleFields }, ['id'], (c, a) => ({ rule: c.services.recurring.updateRule(str(a, 'id'), fields(a, ['id'])) }));
write('recurring.toggle', '启用或停用周期规则。', { ...id, enabled: boolean }, ['id', 'enabled'], (c, a) => ({ rule: c.services.recurring.setRuleEnabled(str(a, 'id'), a['enabled'] as boolean) }));
write('recurring.delete', '删除周期账单规则。', id, ['id'], (c, a) => c.services.recurring.deleteRule(str(a, 'id')));
write('recurring.generate', '生成到期的待确认账单（不会直接记账）。', {}, [], (c) => c.services.recurring.generateDue());

read('funds.read', '查询四用途资金配置、余额、能力或待核对旧收入。', { view: { enum: ['summary', 'config', 'capabilities', 'issues'] }, ...page }, ['view'], (c, a) => {
  switch (a['view']) { case 'summary': return funds(c).getSummary(); case 'config': return funds(c).getConfig(); case 'capabilities': return funds(c).capabilities(); default: return funds(c).listIssues(a['limit'], a['offset']); }
});
write('funds.configure', '修改四用途分配比例（合计10000，仅影响以后收入）。', { ...operation, expectedRevision: integer, ratiosBps: ratios, timeZone: text }, ['expectedRevision', 'ratiosBps', 'timeZone'], (c, a) => funds(c).updateConfig(a, actor(c)));
write('funds.review', '核对已有或尚未分配的收入；sources 每项为 salaryId 与 expectedSourceToken。', { ...operation, grantId: text, expectedRevision: integer, ratiosBps: ratios, sources: { ...array, items: sourceRef } }, ['expectedRevision', 'ratiosBps', 'sources'], (c, a) => funds(c).reviewGrant(a, actor(c)));
read('salaries.read', '分页查询已记录的工资/分配收入及四用途快照。', { ...id, ...page }, [], (c, a) => a['id'] ? { salary: c.services.salaries.getByIdOrThrow(str(a, 'id')) } : {
  items: c.services.salaries.list(num(a, 'limit', 100), num(a, 'offset')), total: c.services.salaries.count(), limit: num(a, 'limit', 100), offset: num(a, 'offset'), hasMore: num(a, 'offset') + num(a, 'limit', 100) < c.services.salaries.count(),
});
write('salary.create', '新增收入并按当前四用途比例分配；不同于普通 income 账单，不要重复记录同一笔钱。', { ...operation, amountCents: money, date: integer, accountId: text, note: { type: 'string', maxLength: 200 }, expectedFundConfigRevision: integer }, ['amountCents', 'date', 'accountId', 'expectedFundConfigRevision'],
  (c, a) => ({ salary: c.services.salaries.create({ ...a, contractVersion: 1 }, { actorId: actor(c) }) }));
write('salary.update', '修改分配收入并保留服务端版本校验。', { ...id, ...operation, amountCents: money, date: integer, accountId: text, note: { type: 'string', maxLength: 200 }, expectedGrantRevision: integer }, ['id', 'expectedGrantRevision'],
  (c, a) => ({ salary: c.services.salaries.update(str(a, 'id'), { ...fields(a, ['id']), contractVersion: 1 }, { actorId: actor(c) }) }));
write('salary.delete', '删除分配收入及关联资金分配。', { ...id, ...operation, expectedGrantRevision: integer }, ['id', 'expectedGrantRevision'],
  (c, a) => c.services.salaries.softDelete(str(a, 'id'), { ...fields(a, ['id']), contractVersion: 1 }, { actorId: actor(c) }));

const planFields = { monthlyIncomeCents: money, essentialMonthlyCents: money, reserveBalanceCents: integer } as const;
read('plan.read', '读取独立财务计划和当前月计划视图。', {}, [], (c) => ({ plan: new FinancialPlanService(c.db, { now: c.now }).get(), monthly: new MonthlyPlanService(c.db, { now: c.now, actorId: c.actorId }).getMonthlyPlan() }));
read('plan.preview', '预览独立财务计划，金额只作计划输入。', planFields, Object.keys(planFields), (c, a) => ({ analysis: new FinancialPlanService(c.db, { now: c.now }).preview(a) }));
write('plan.save', '保存独立财务计划。', { ...planFields, expectedRevision: integer }, [...Object.keys(planFields), 'expectedRevision'], (c, a) => ({ plan: new FinancialPlanService(c.db, { now: c.now }).save(a) }));

read('goals.read', '查询手动目标进度、明细或幂等操作结果。', { view: { enum: ['summary', 'entries', 'operation'] }, ...id, limit: page.limit, cursor: text, goal: { enum: ['reserve', 'investment'] }, from: integer, to: integer, includeDeleted: boolean }, ['view'], (c, a) => {
  if (a['view'] === 'operation') return { operation: goals(c).operation(requiredId(a)) ?? null };
  return a['view'] === 'entries' ? goals(c).listEntries(fields(a, ['view', 'id'])) : goals(c).view(fields(a, ['view', 'id']));
});
const goalWrite = { ...operation, expectedRevision: integer, goal: { enum: ['reserve', 'investment'] } } as const;
write('goals.opening', '确认手动目标期初余额（不创建账单）。', { ...goalWrite, openingCents: integer, openingAt: integer }, ['expectedRevision', 'goal', 'openingCents', 'openingAt'], (c, a) => goals(c).putOpening(a).body);
const entry = { kind: { enum: ['deposit', 'withdrawal'] }, amountCents: money, date: integer, note: { type: 'string', maxLength: 200 } } as const;
write('goals.create', '记录手动目标进度（不创建账单）。', { ...goalWrite, ...entry }, ['expectedRevision', 'goal', 'kind', 'amountCents', 'date'], (c, a) => goals(c).createEntry(a).body);
write('goals.update', '修改手动目标记录。', { ...id, ...goalWrite, ...entry }, ['id', 'expectedRevision'], (c, a) => goals(c).patchEntry(str(a, 'id'), fields(a, ['id'])).body);
write('goals.delete', '删除手动目标记录。', { ...id, ...operation, expectedRevision: integer }, ['id', 'expectedRevision'], (c, a) => goals(c).deleteEntry(str(a, 'id'), fields(a, ['id'])).body);

const itemFields = { name: text, category: text, brand: { type: 'string', maxLength: 1000 }, model: { type: 'string', maxLength: 1000 }, note: { type: 'string', maxLength: 1000 },
  purchasePriceCents: { type: ['integer', 'null'], minimum: 0 }, purchaseDate: integer, status: { enum: ['active', 'idle', 'sold', 'retired'] }, purchaseTransactionId: { type: ['string', 'null'] },
  closedDate: { type: ['integer', 'null'] }, salePriceCents: { type: ['integer', 'null'], minimum: 0 }, saleTransactionId: { type: ['string', 'null'] } } as const;
read('items.read', '查询物品列表、总览或详情；物品记录不会自动创建账单。', { ...id, ...page, q: text, category: text, status: { enum: ['active', 'idle', 'sold', 'retired'] }, sort: text }, [], (c, a) => a['id'] ? { item: items(c).getByIdOrThrow(str(a, 'id')) } : { ...items(c).list(a), summary: items(c).summary() });
write('item.create', '创建物品记录。', itemFields, ['name', 'purchaseDate'], (c, a) => ({ item: items(c).create(a) }));
write('item.update', '修改物品记录。', { ...id, ...itemFields }, ['id'], (c, a) => ({ item: items(c).update(str(a, 'id'), fields(a, ['id'])) }));
write('item.sell', '将物品标为售出，可关联已有收入账单。', { ...id, closedDate: integer, salePriceCents: integer, saleTransactionId: { type: ['string', 'null'] } }, ['id', 'closedDate'], (c, a) => ({ item: items(c).sell(str(a, 'id'), fields(a, ['id'])) }));
write('item.retire', '将物品标为退役。', { ...id, closedDate: integer }, ['id', 'closedDate'], (c, a) => ({ item: items(c).retire(str(a, 'id'), fields(a, ['id'])) }));
write('item.delete', '删除物品记录。', id, ['id'], (c, a) => items(c).remove(str(a, 'id')));

// Allocation templates are retired (migration 022 folds template names into tags), so the
// assistant offers no template tools at all. The deprecated HTTP route stays readable for
// shipped clients; a model must not create or edit a surface the product is removing.
read('settings.read', '读取预算周期日和已有预算周期。', {}, [], (c) => ({ cycleStartDay: c.services.salaries.getCycleStartDay() ?? null, periods: c.services.budget.periods() }));
write('settings.cycle', '修改预算周期起始日。', { cycleStartDay: { type: ['integer', 'null'], minimum: 1, maximum: 28 } }, ['cycleStartDay'], (c, a) => ({ cycleStartDay: c.services.salaries.setCycleStartDay(a['cycleStartDay'] as number | null) ?? null }));

read('stats.query', '查询服务端统计时间窗、分类占比、历史月趋势、结余趋势或账单范围。', { view: { enum: ['window', 'categories', 'monthly', 'pool', 'range'] }, kind: { enum: ['month', 'last30'] }, month: text, timeZone: text,
  from: integer, to: integer, accountId: text, categoryId: text, months: { type: 'integer', minimum: 1, maximum: 120 }, endMonth: text }, ['view'], (c, a) => {
  if (a['view'] === 'monthly') return c.services.stats.monthlyTrendSeries(num(a, 'months', 6), typeof a['endMonth'] === 'string' ? a['endMonth'] : null);
  if (a['view'] === 'pool') return c.services.stats.poolTrend();
  if (a['view'] === 'range') return c.services.stats.availableRange();
  const zone = typeof a['timeZone'] === 'string' ? a['timeZone'] : Intl.DateTimeFormat().resolvedOptions().timeZone;
  const window = resolveStatsWindow(a['kind'] === 'month' ? 'month' : 'last30', typeof a['month'] === 'string' ? a['month'] : null, c.now(), zone);
  return a['view'] === 'window' ? window : c.services.stats.categoryShare(num(a, 'from', window.from), num(a, 'to', window.to), {
    ...(typeof a['accountId'] === 'string' ? { accountId: a['accountId'] } : {}),
    ...(typeof a['categoryId'] === 'string' ? { categoryId: a['categoryId'] } : {}),
  });
});

/** The historical planning contracts remain explicit, including their retired-write errors. */
read('planning.read', '读取历史执行计划配置、分类规则、来源、周期、执行事实、用途及退款拆分。', { view: { enum: ['capabilities', 'config', 'mapping', 'sources', 'source', 'periods', 'period', 'revisions', 'execution', 'facts', 'purpose', 'refunds', 'refund', 'operation', 'monthly'] }, ...id, ...page, revision: integer, groupMonth: text, periodId: text, status: text, purpose: text, categoryId: text }, ['view'], (c, a) => {
  const service = planning(c); const query = fields(a, ['view', 'id']);
  switch (a['view']) {
    case 'capabilities': return service.capabilities(); case 'config': return service.getConfig();
    case 'mapping': {
      const result = service.getMapping();
      const rules = paged(result.mapping.rules, a);
      return { ...result, mapping: { ...result.mapping, rules: rules.items, categories: result.mapping.categories.slice(num(a, 'offset'), num(a, 'offset') + num(a, 'limit', 100)) },
        total: rules.total, limit: rules.limit, offset: rules.offset, hasMore: rules.hasMore,
        totalCategories: result.mapping.categories.length, categoriesHaveMore: num(a, 'offset') + num(a, 'limit', 100) < result.mapping.categories.length };
    }
    case 'sources': return service.listSalarySources(query); case 'source': return service.getSalarySource(requiredId(a));
    case 'periods': return service.listPeriods(query); case 'period': return service.getPeriod(requiredId(a), typeof a['revision'] === 'number' ? a['revision'] : undefined);
    case 'revisions': return service.listPeriodRevisions(requiredId(a), query); case 'execution': return service.getExecution(typeof a['id'] === 'string' ? a['id'] : undefined);
    case 'facts': return service.listExecutionFacts(requiredId(a), query); case 'purpose': return service.getBillPurpose(requiredId(a));
    case 'refunds': return service.listRefunds(query); case 'refund': return service.getRefund(requiredId(a));
    case 'operation': return { operation: service.operation(requiredId(a), actor(c)) ?? null };
    default: return new MonthlyPlanService(c.db, { now: c.now, actorId: c.actorId }).getMonthlyPlan(query);
  }
});
write('planning.configure', '修改执行计划配置。', { ...operation, expectedRevision: integer, enabled: boolean, ratiosBps: ratios, essentialMonthlyCents: { type: ['integer', 'null'], minimum: 1 }, targetMonths: integer, cycle: object, timeZone: text }, ['expectedRevision', 'enabled', 'ratiosBps', 'essentialMonthlyCents', 'targetMonths', 'cycle', 'timeZone'], (c, a) => planning(c).putConfig(a));
write('planning.mapping', '替换分类默认用途规则；必须先读取完整现有规则并保留未修改项。', { ...operation, expectedRevision: integer, expectedTopologyToken: text, rules: { ...array, items: { type: 'object', additionalProperties: false, required: ['categoryId', 'purpose'], properties: { categoryId: text, purpose: { enum: ['essentials', 'joy', null] } } } } }, ['expectedRevision', 'expectedTopologyToken', 'rules'], (c, a) => {
  if (planning(c).readMapping().rules.length > 100) throw new AssistantValidationError('已有规则超过助手单次审核上限，请在完整分类规则页面修改，避免遗漏。');
  return planning(c).putMapping(a);
});
read('planning.preview', '预览历史工资执行周期。', { proposal }, ['proposal'], (c, a) => planning(c).previewPeriod(a));
write('planning.confirm', '确认历史工资执行周期。', { ...operation, previewToken: text, proposal }, ['previewToken', 'proposal'], (c, a) => planning(c).confirmPeriod(a));
write('planning.reconcile', '重新核对历史执行周期。', { ...id, ...operation, previewToken: text, proposal }, ['id', 'previewToken', 'proposal'], (c, a) => planning(c).reconcilePeriod(str(a, 'id'), fields(a, ['id'])));
write('planning.purpose', '修改账单用途覆盖。', { ...id, ...operation, expectedRevision: integer, expectedFundPurposeRevision: integer, expectedTransactionToken: text, financialPurpose: { enum: ['essentials', 'joy', null] } }, ['id', 'expectedRevision', 'expectedTransactionToken', 'financialPurpose'], (c, a) => planning(c).putBillPurpose(str(a, 'id'), fields(a, ['id'])));
write('planning.refund-splits', '核对退款分摊，不改变原账单总支出和退款收入口径。', { ...id, ...operation, expectedRevision: integer, expectedRefundToken: text,
  originals: { ...array, items: { type: 'object', additionalProperties: false, required: ['transactionId', 'expectedTransactionToken'], properties: { transactionId: text, expectedTransactionToken: text } } },
  splits: { ...array, items: { type: 'object', additionalProperties: false, required: ['originalTransactionId', 'amountCents'], properties: { originalTransactionId: text, amountCents: money } } } }, ['id', 'expectedRevision', 'expectedRefundToken', 'originals', 'splits'], (c, a) => planning(c).putRefundSplits(str(a, 'id'), fields(a, ['id'])));

function spendingPage(service: AiSpendingOrganizationService, runId: string, offset = 0, limit = 100): Args {
  const card = service.getCard(runId);
  // The review card is a per-transaction recommendation list, so this is the only
  // paginated collection. Template proposals no longer exist (allocation templates were
  // retired in favour of tags), so they are not part of the selection set or the paging.
  const entries = [...card.actions];
  const selected = new Set(entries.slice(offset, offset + limit).map((entry) => entry.actionId));
  return json({ ...card,
    coverage: { eligibleCount: card.eligibleCount, completedCount: card.completedCount, idsOmitted: true },
    evidenceByCategory: {}, evidenceCategoryCount: Object.keys(card.evidenceByCategory).length,
    evidenceTool: 'spending.evidence',
    actions: card.actions.filter((entry) => selected.has(entry.actionId)),
    templateProposals: [],
    noteSuggestions: card.noteSuggestions.filter((entry) => selected.has(entry.actionId)),
    totalActions: entries.length, offset, limit, hasMore: offset + limit < entries.length,
  });
}

/**
 * Starts a long-running analysis and returns immediately.
 *
 * This is the fix for the reported "AI asks for the date range, then the second reply
 * fails" bug. The analysis calls the provider once per 10-transaction batch (up to 50
 * batches, ~10 minutes of provider time), but one assistant generation is capped at
 * `MAX_GENERATION_DEADLINE_MS` (180 s) and its tool scope is aborted at that deadline.
 * Awaiting the whole analysis inside the tool therefore turned the second turn — the one
 * that actually starts analysing — into a guaranteed timeout.
 *
 * Starting it in the background and returning a run summary keeps every assistant turn
 * short, and leaves progress observation to `spending.status` / `spending.card`.
 *
 * A second ask while a run is already going is routine (the user repeats themselves, or the
 * model retries), so a busy service returns the existing run instead of a hard failure: an
 * error here would resurface as the same "second reply failed" symptom through a different
 * door.
 */
async function startingAnalysis(c: Context, a: Args): Promise<Args> {
  const service = spending(c);
  const startDate = str(a, 'startDate');
  const endDate = str(a, 'endDate');
  try {
    const run = await service.startAnalysis({ startDate, endDate, background: true, clientRequestId: randomUUID() });
    // A tiny range can finish synchronously; then the card is readable right away.
    return json(run.status === 'ready'
      ? { run, step: 'read-card', nextStep: 'spending.card', note: '分析已完成，可直接用 spending.card 分页读取建议。' }
      : { run, step: 'poll', nextStep: 'spending.status', note: '分析已在后台开始，预计较慢。请用 spending.status 查询进度；状态为 ready 后用 spending.card 分页读取建议。' });
  } catch (error) {
    const existing = existingRun(c, startDate, endDate);
    if (existing === undefined) throw error;
    return json({ run: existing, step: 'poll', nextStep: 'spending.status', note: '该日期范围已有整理任务；请用 spending.status 查询它，ready 后用 spending.card 读取建议，不要重复开始。' });
  }
}

/** The newest unfinished-or-ready run for exactly this range, if one is still reusable. */
function existingRun(c: Context, startDate: string, endDate: string): AssistantJsonObject | undefined {
  const row = c.db
    .prepare(
      `SELECT id FROM ai_analysis_runs
        WHERE start_date = ? AND end_date = ? AND status IN ('running', 'ready')
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(startDate, endDate) as { id: string } | undefined;
  if (row === undefined) return undefined;
  try {
    return json(spending(c).getRun(row.id));
  } catch {
    return undefined;
  }
}
read('spending.preview', '按起止日期在后台开始完整分析历史账单；只生成分类/标签/备注建议，不改账单。最多500笔，日期为 YYYY-MM-DD。立即返回任务编号，需用 spending.status 查询进度，ready 后用 spending.card 读取建议。', { startDate: text, endDate: text }, ['startDate', 'endDate'], (c, a) => startingAnalysis(c, a));
read('spending.card', '分页读取历史账单整理卡；note 仅供参考，不可选择应用。', { runId: text, ...page }, ['runId'], (c, a) => spendingPage(spending(c), str(a, 'runId'), num(a, 'offset'), num(a, 'limit', 100)));
read('spending.status', '读取历史账单整理任务进度；ready 前不要展示建议。', { runId: text }, ['runId'], (c, a) => ({ run: spending(c).getRun(str(a, 'runId')) }));
read('spending.evidence', '分页读取历史整理的完整分类金额证据。', { runId: text, ...page }, ['runId'], (c, a) => {
  const card = spending(c).getCard(str(a, 'runId'));
  return paged(Object.entries(card.evidenceByCategory).sort(([left], [right]) => left.localeCompare(right)).map(([categoryId, amountCents]) => ({ categoryId, amountCents })), a);
});
read('spending.resume', '仅在用户明确要求继续失败任务时恢复剩余分析，可能再次调用AI；不修改账单。', { runId: text }, ['runId'], async (c, a) => {
  const service = spending(c);
  // `resumeAnalysis` only *schedules* the remaining batches and returns the run row, so it
  // is as fast as `spending.preview`. Awaiting the work itself (`resumeAndWait`) would
  // reintroduce the 180 s generation deadline failure this tool was fixed for.
  const run = await service.resumeAnalysis(str(a, 'runId'), { clientRequestId: randomUUID() });
  return json({ run, step: 'poll', nextStep: 'spending.status', note: '已重新在后台继续未完成批次；请用 spending.status 查询进度，ready 后用 spending.card 读取建议。' });
});
write('spending.apply', '应用用户明确选择的历史账单整理建议。禁止默认全选或选择 note 建议。', { runId: text, actionIds: { ...array, minItems: 1, items: text } }, ['runId', 'actionIds'], (c, a) => {
  const service = spending(c); const card = service.getCard(str(a, 'runId')); const ids = a['actionIds'] as string[];
  const selectable = new Set(card.actions.filter((entry) => entry.kind !== 'note').map((entry) => entry.actionId));
  if (new Set(ids).size !== ids.length || ids.some((entry) => !selectable.has(entry))) throw new AssistantValidationError('选择包含不存在、重复或仅供参考的建议。');
  return service.apply(card.runId, ids);
}, (c, a) => {
  const card = spending(c).getCard(str(a, 'runId')); const ids = new Set(a['actionIds'] as string[]);
  return json({ runId: card.runId, startDate: card.startDate, endDate: card.endDate, actions: card.actions.filter((entry) => ids.has(entry.actionId)), expiresAt: card.expiresAt });
});
write('spending.undo', '条件撤销一次历史账单整理；后续修改冲突时拒绝覆盖。', { operationId: text }, ['operationId'], (c, a) => spending(c).undo(str(a, 'operationId')));

export function createBusinessTools(): readonly InternalTool[] { return tools; }
export function isBusinessTool(name: string): boolean { return tools.some((tool) => tool.definition.name === name); }
