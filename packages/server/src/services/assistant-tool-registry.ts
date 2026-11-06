/** Allowlisted assistant tools. Adapters call domain services directly, never sibling HTTP routes. */
import { createHash, randomUUID } from 'node:crypto';
import { createBusinessTools, simulateAssistantWrite } from './assistant-business-tools.js';
import { createWorkspaceTools } from './assistant-workspace-tools.js';
import { organizationPage } from './assistant-organization-page.js';
import { financialTransactionToken } from './financial-purpose-store.js';
import {
  dateOnly,
  dayStart,
  parseYuanToCents,
  TYPE_EXPENSE,
  TYPE_INCOME,
  type PlatformBillSource,
} from '@jizhang/shared';
import type { Db } from '../db/index.js';
import { projectAssistantReadResult } from './assistant-result-projection.js';
import { AccountBalanceService } from './account-balance-service.js';
import { AiConfigService } from './ai-config-service.js';
import { AiOrganizationService } from './ai-organization-service.js';
import { AiProviderService } from './ai-provider-service.js';
import { BudgetOverviewService } from './budget-overview-service.js';
import { MonthlyEvaluationService } from './monthly-evaluation-service.js';
import { PortabilityService } from './portability-service.js';
import { RecurringService } from './recurring-service.js';
import { StatsService } from './stats-service.js';
import { SalaryService } from './salary-service.js';
import { TemplateService } from './template-service.js';
import { TransferService } from './transfer-service.js';
import {
  AssistantActionStaleError,
  AssistantAttachmentRequiredError,
  assistantJsonObject,
  ASSISTANT_TOOL_NAMES,
  isAssistantToolName,
  normalizeAssistantJson,
  type AssistantAttachmentMetadata,
  type AssistantJsonObject,
  type AssistantToolName,
  AssistantValidationError,
} from './assistant-types.js';
import { MasterDataService } from './master-data-service.js';
import {
  TransactionService,
  type PreparedTransactionInput,
} from './transaction-service.js';

const MAX_IMPORT_PREVIEW_ROWS = 200;
const MAX_RESULT_ITEMS = 100;

export interface AssistantToolServices {
  readonly transactions: TransactionService;
  readonly balances: AccountBalanceService;
  readonly budget: BudgetOverviewService;
  readonly stats: StatsService;
  readonly recurring: RecurringService;
  readonly monthly: MonthlyEvaluationService;
  readonly organization: AiOrganizationService;
  readonly portability: PortabilityService;
  readonly masterData: MasterDataService;
  readonly salaries: SalaryService;
  readonly transfers: TransferService;
  readonly templates: TemplateService;
}

export interface AssistantToolContext {
  readonly conversationId?: string | undefined;
  readonly generationId?: string | undefined;
  readonly capabilityCatalog?: readonly AssistantToolDefinition[] | undefined;
  readonly actorId?: string | undefined;
  readonly db: Db;
  readonly now: () => number;
  readonly services: AssistantToolServices;
  readonly config: AiConfigService;
  readonly provider: AiProviderService;
  readonly attachmentBytes?: Uint8Array | undefined;
  readonly attachment?: AssistantAttachmentMetadata | undefined;
}

export interface AssistantPreparedTool {
  readonly toolName: AssistantToolName;
  readonly operation: string;
  readonly summary: string;
  readonly affected: { readonly count: number; readonly ids?: readonly string[] };
  readonly values: AssistantJsonObject;
  readonly warnings: readonly string[];
  readonly preview: AssistantJsonObject;
  readonly arguments: AssistantJsonObject;
  readonly fingerprint: string;
  readonly attachment?: AssistantAttachmentMetadata | undefined;
}

export interface AssistantToolResult {
  readonly toolName: AssistantToolName;
  readonly summary: string;
  readonly data: AssistantJsonObject;
}

export interface AssistantToolDefinition {
  readonly name: AssistantToolName;
  readonly access: 'read' | 'write';
  readonly description: string;
  readonly inputSchema: AssistantJsonObject;
}

export interface InternalTool {
  readonly definition: AssistantToolDefinition;
  readonly parseArguments: (value: unknown) => AssistantJsonObject;
  readonly read?: (context: AssistantToolContext, args: AssistantJsonObject) => Promise<AssistantToolResult> | AssistantToolResult;
  readonly prepare?: (context: AssistantToolContext, args: AssistantJsonObject) => Promise<AssistantPreparedTool> | AssistantPreparedTool;
  readonly confirm?: (context: AssistantToolContext, action: AssistantJsonObject, attachmentBytes?: Uint8Array) => Promise<AssistantToolResult> | AssistantToolResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function argsRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new AssistantValidationError('工具参数必须是对象。');
  return value;
}

function onlyKnown(record: Record<string, unknown>, fields: readonly string[]): void {
  const allowed = new Set(fields);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new AssistantValidationError('工具参数包含未知字段。');
  }
}

function stringArg(record: Record<string, unknown>, key: string, required?: true, max?: number): string;
function stringArg(record: Record<string, unknown>, key: string, required: false, max?: number): string | undefined;
function stringArg(record: Record<string, unknown>, key: string, required = true, max = 200): string | undefined {
  const value = record[key];
  if ((value === undefined || value === null) && !required) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AssistantValidationError(`${key} 必须是非空文本。`);
  }
  return value.trim().slice(0, max);
}

function integerArg(record: Record<string, unknown>, key: string, min?: number, max?: number): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value)) throw new AssistantValidationError(`${key} 必须是整数。`);
  const number = value as number;
  if (min !== undefined && number < min) throw new AssistantValidationError(`${key} 超出范围。`);
  if (max !== undefined && number > max) throw new AssistantValidationError(`${key} 超出范围。`);
  return number;
}

function booleanArg(record: Record<string, unknown>, key: string, defaultValue = false): boolean {
  const value = record[key];
  if (value === undefined) return defaultValue;
  if (typeof value !== 'boolean') throw new AssistantValidationError(`${key} 必须是布尔值。`);
  return value;
}

function stringArrayArg(record: Record<string, unknown>, key: string, required = false): string[] | undefined {
  const value = record[key];
  if ((value === undefined || value === null) && !required) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new AssistantValidationError(`${key} 必须是文本数组。`);
  }
  return [...new Set((value as string[]).map((item) => item.trim()).filter(Boolean))].slice(0, MAX_RESULT_ITEMS);
}

function dateArg(record: Record<string, unknown>): number {
  const value = record['date'];
  if (typeof value === 'number' && Number.isFinite(value)) return dateOnly(value);
  if (typeof value !== 'string') throw new AssistantValidationError('date 必须是日期。');
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (match === null) throw new AssistantValidationError('date 必须使用 YYYY-MM-DD。');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const result = dayStart(year, month - 1, day);
  const check = new Date(result);
  if (check.getFullYear() !== year || check.getMonth() !== month - 1 || check.getDate() !== day) {
    throw new AssistantValidationError('date 不是有效日期。');
  }
  return result;
}

function amountArg(record: Record<string, unknown>): number {
  const cents = record['amountCents'];
  if (Number.isSafeInteger(cents) && (cents as number) > 0) return cents as number;
  const yuan = record['amountYuan'] ?? record['amount'];
  if (typeof yuan !== 'string' && typeof yuan !== 'number') {
    throw new AssistantValidationError('需要 amountCents 或 amountYuan。');
  }
  const parsed = parseYuanToCents(String(yuan));
  if (parsed === null || parsed <= 0) throw new AssistantValidationError('金额必须大于零。');
  return parsed;
}

function hashJson(value: unknown): string {
  const normalized = normalizeAssistantJson(value);
  const stable = JSON.stringify(normalized, (_key, item: unknown) => {
    if (!isRecord(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
  });
  return createHash('sha256').update(stable).digest('hex');
}

function json(value: unknown, field: string): AssistantJsonObject {
  return assistantJsonObject(value, field);
}

function toolResult(
  toolName: AssistantToolName,
  summary: string,
  data: unknown,
): AssistantToolResult {
  return { toolName, summary, data: json(data, '工具结果') };
}

function prepared(
  toolName: AssistantToolName,
  operation: string,
  summary: string,
  affected: { readonly count: number; readonly ids?: readonly string[] },
  values: unknown,
  preview: unknown,
  args: AssistantJsonObject,
  fingerprint: string,
  attachment?: AssistantAttachmentMetadata,
  warnings: readonly string[] = [],
): AssistantPreparedTool {
  return {
    toolName,
    operation,
    summary,
    affected,
    values: json(values, '确认卡值'),
    warnings,
    preview: json(preview, '确认卡预览'),
    arguments: args,
    fingerprint,
    ...(attachment === undefined ? {} : { attachment }),
  };
}

function preparedTransaction(record: Record<string, unknown>, service: TransactionService): {
  readonly args: AssistantJsonObject;
  readonly input: PreparedTransactionInput;
} {
  onlyKnown(record, [
    'type',
    'amountCents',
    'amountYuan',
    'amount',
    'categoryId',
    'accountId',
    'date',
    'note',
    'tags',
    'isRefund',
    'refundLinkedTxIds',
    'fundPurpose',
  ]);
  const typeValue = record['type'];
  const type = typeValue === TYPE_EXPENSE || typeValue === 'expense' ? TYPE_EXPENSE : typeValue === TYPE_INCOME || typeValue === 'income' ? TYPE_INCOME : undefined;
  if (type === undefined) throw new AssistantValidationError('type 必须是 expense 或 income。');
  const categoryId = stringArg(record, 'categoryId');
  const accountId = stringArg(record, 'accountId');
  const note = typeof record['note'] === 'string' ? record['note'].trim().slice(0, 200) : '';
  const tags = stringArrayArg(record, 'tags') ?? [];
  const isRefund = booleanArg(record, 'isRefund');
  const linked = stringArrayArg(record, 'refundLinkedTxIds') ?? [];
  const input = service.prepareCreate({
    type,
    amountCents: amountArg(record),
    categoryId,
    accountId,
    date: dateArg(record),
    note,
    tags,
    isRefund,
    refundLinkedTxIds: linked,
    ...(record['fundPurpose'] === undefined ? {} : { fundPurpose: record['fundPurpose'] }),
  });
  const args = json({
    type: input.type,
    amountCents: input.amountCents,
    categoryId: input.categoryId,
    accountId: input.accountId,
    date: input.date,
    note: input.note,
    tags: input.tags,
    isRefund: input.isRefund,
    refundLinkedTxIds: input.refundLinkedTxIds,
    ...(record['fundPurpose'] === undefined ? {} : { fundPurpose: input.fundPurpose }),
  }, '交易参数');
  return { args, input };
}

/** One existing-category projection for analysis, review and stale-preview hashing. */
function importCategories(context: AssistantToolContext) {
  const categories = context.services.masterData.listCategories();
  return categories.filter((category) => category.type !== 0 || !categories.some((child) => child.parentId === category.id)).map(({ id, name, type }) => ({ id, name, type }));
}

function importArgs(value: unknown): AssistantJsonObject {
  const record = argsRecord(value);
  onlyKnown(record, ['source', 'fileName', 'selectedIds', 'categoryOverrides', 'noteOverrides']);
  const source = record['source'] ?? 'auto';
  if (source !== 'auto' && source !== 'wechat' && source !== 'alipay') {
    throw new AssistantValidationError('source 必须是 auto、wechat 或 alipay。');
  }
  const fileName = stringArg(record, 'fileName', false, 200);
  // `null` means "all importable rows" in the platform-import contract. It is
  // persisted in the pending action and may be parsed again during confirmation.
  const selectedIds = record['selectedIds'] === null ? null : stringArrayArg(record, 'selectedIds');
  const maps: Record<string, Record<string, string>> = {};
  for (const field of ['categoryOverrides', 'noteOverrides']) {
    const raw = record[field] ?? {};
    if (!isRecord(raw) || Object.keys(raw).length > 100 || Object.entries(raw).some(([id, v]) => id.length > 100 || typeof v !== 'string' || v.length > (field === 'noteOverrides' ? 200 : 100))) throw new AssistantValidationError('导入覆盖值无效或超出限制。');
    maps[field] = raw as Record<string, string>;
  }
  if (Array.isArray(record['selectedIds']) && record['selectedIds'].length > 100) throw new AssistantValidationError('最多选择100行。');
  return json({ source, ...(fileName === undefined ? {} : { fileName }), selectedIds: selectedIds ?? null, ...maps }, '导入参数');
}

function boundedRows(result: { readonly rows: readonly Record<string, unknown>[] }): Record<string, unknown>[] {
  return result.rows.slice(0, MAX_IMPORT_PREVIEW_ROWS).map((row) => ({
    id: row['id'],
    dateLabel: row['dateLabel'],
    comparisonAccountId: row['comparisonAccountId'],
    externalId: row['externalId'],
    type: row['type'],
    amountCents: row['amountCents'],
    note: typeof row['note'] === 'string' ? row['note'] : '',
    counterparty: typeof row['counterparty'] === 'string' ? row['counterparty'].slice(0, 120) : '',
    sourceCategory: typeof row['sourceCategory'] === 'string' ? row['sourceCategory'].slice(0, 80) : '',
    categoryName: typeof row['categoryName'] === 'string' ? row['categoryName'].slice(0, 80) : '',
    accountName: typeof row['accountName'] === 'string' ? row['accountName'].slice(0, 80) : '',
    isRefund: row['isRefund'] === true,
    rawStatus: row['rawStatus'],
    refundWarning: row['refundWarning'],
    ignored: row['ignored'] === true,
    ignoreReason: typeof row['ignoreReason'] === 'string' ? row['ignoreReason'].slice(0, 160) : null,
    alreadyExists: row['alreadyExists'] === true,
    possibleDuplicate: row['possibleDuplicate'] === true,
    duplicateOfNote: typeof row['duplicateOfNote'] === 'string' ? row['duplicateOfNote'].slice(0, 160) : null,
  }));
}

function createDefinitions(): AssistantToolDefinition[] {
  return [
    { name: 'transactions.recent', access: 'read', description: '查询最近的账单，可按类型或备注筛选。', inputSchema: { type: 'object', properties: { limit: { type: 'integer', maximum: 50 }, q: { type: 'string' }, type: { enum: [0, 1] } } } },
    { name: 'accounts.balances', access: 'read', description: '分页查询服务端账户余额；totalBalanceCents始终是全部账户总额。', inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0 } } } },
    { name: 'budget.overview', access: 'read', description: '查询预算周期、模块和结余池。', inputSchema: { type: 'object', properties: { periodStart: { type: 'integer' } } } },
    { name: 'stats.monthly', access: 'read', description: '查询服务端计算的月度收入和净支出趋势。', inputSchema: { type: 'object', properties: { months: { type: 'integer', minimum: 1, maximum: 12 } } } },
    { name: 'recurring.pending', access: 'read', description: '查询待确认的周期账单。', inputSchema: { type: 'object', properties: {} } },
    { name: 'monthly.evaluate', access: 'read', description: '按需生成有证据编号的本月评价。', inputSchema: { type: 'object', properties: {} } },
    { name: 'organization.preview', access: 'read', description: '分页预览可安全执行的分类和标签整理；hasMore时不能把本页当全部。', inputSchema: { type: 'object', properties: { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } } } },
    { name: 'backups.list', access: 'read', description: '列出可用备份文件名。', inputSchema: { type: 'object', properties: {} } },
    { name: 'backup.export-links', access: 'read', description: '返回数据导出链接。', inputSchema: { type: 'object', properties: {} } },
    { name: 'transaction.create', access: 'write', description: '准备支出、普通收入或关联退款。退款使用 income、isRefund=true、原支出编号 refundLinkedTxIds。', inputSchema: { type: 'object', required: ['type', 'amountCents', 'categoryId', 'accountId', 'date'], properties: { type: { enum: ['expense', 'income'] }, amountCents: { type: 'integer' }, categoryId: { type: 'string' }, accountId: { type: 'string' }, date: { type: ['string', 'integer'] }, note: { type: 'string' }, tags: { type: 'array' }, isRefund: { type: 'boolean' }, refundLinkedTxIds: { type: 'array', items: { type: 'string' } }, fundPurpose: { enum: ['growth', 'reserve', 'essentials', 'joy', null] } } } },
    { name: 'transaction.update', access: 'write', description: '准备修改一笔现有账单。', inputSchema: { type: 'object', required: ['id', 'changes'], properties: { id: { type: 'string' }, changes: { type: 'object' } } } },
    { name: 'transaction.delete', access: 'write', description: '准备将一笔账单移入回收站。', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    { name: 'transaction.restore', access: 'write', description: '准备从回收站恢复一笔账单。', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    { name: 'transfer.create', access: 'write', description: '准备在两个账户之间创建转账。', inputSchema: { type: 'object', required: ['fromAccountId', 'toAccountId', 'amountCents', 'date'], properties: { fromAccountId: { type: 'string' }, toAccountId: { type: 'string' }, amountCents: { type: 'integer' }, date: { type: ['string', 'integer'] }, note: { type: 'string' } } } },
    // The extension registers canonical fund salary.create, never retired module allocations.
    { name: 'category.create', access: 'write', description: '准备创建分类。', inputSchema: { type: 'object', required: ['name', 'type'], properties: { name: { type: 'string' }, type: { enum: [0, 1] }, icon: { type: 'string' }, color: { type: 'string' }, parentId: { type: ['string', 'null'] } } } },
    { name: 'category.update', access: 'write', description: '准备修改分类。', inputSchema: { type: 'object', required: ['id', 'changes'], properties: { id: { type: 'string' }, changes: { type: 'object' } } } },
    { name: 'category.delete', access: 'write', description: '准备软删除分类。', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    { name: 'account.create', access: 'write', description: '准备创建账户。', inputSchema: { type: 'object', required: ['name', 'type'], properties: { name: { type: 'string' }, type: { type: 'integer' }, initialBalanceCents: { type: 'integer' } } } },
    { name: 'account.update', access: 'write', description: '准备修改账户。', inputSchema: { type: 'object', required: ['id', 'changes'], properties: { id: { type: 'string' }, changes: { type: 'object' } } } },
    { name: 'account.delete', access: 'write', description: '准备软删除账户。', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    { name: 'backup.create', access: 'write', description: '准备创建数据库备份。', inputSchema: { type: 'object', properties: {} } },
    { name: 'platform-import.prepare', access: 'write', description: '准备微信或支付宝账单文件的干跑预览。', inputSchema: { type: 'object', properties: { source: { enum: ['auto', 'wechat', 'alipay'] }, fileName: { type: 'string' }, selectedIds: { type: ['array', 'null'] }, categoryOverrides: { type: 'object' }, noteOverrides: { type: 'object' } } } },
    { name: 'organization.apply', access: 'write', description: '准备应用已预览的整理动作。', inputSchema: { type: 'object', properties: { actionIds: { type: 'array' } } } },
    { name: 'organization.undo', access: 'write', description: '准备条件撤销一次已应用的整理操作。', inputSchema: { type: 'object', required: ['operationId'], properties: { operationId: { type: 'string' } } } },
    { name: 'recurring.confirm', access: 'write', description: '准备确认一条周期账单。', inputSchema: { type: 'object', required: ['occurrenceId'], properties: { occurrenceId: { type: 'string' } } } },
    { name: 'recurring.ignore', access: 'write', description: '准备忽略一条周期账单。', inputSchema: { type: 'object', required: ['occurrenceId'], properties: { occurrenceId: { type: 'string' } } } },
    { name: 'tag.rename', access: 'write', description: '准备把一个标签重命名。', inputSchema: { type: 'object', required: ['from', 'to'], properties: { from: { type: 'string' }, to: { type: 'string' } } } },
    { name: 'tag.delete', access: 'write', description: '准备从账单中删除一个标签。', inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } },
  ];
}

export class AssistantToolRegistry {
  private readonly tools = new Map<AssistantToolName, InternalTool>();

  constructor() {
    this.registerAll();
  }

  /**
   * Stable allowlist order. Never omits a registered tool — a missing definition is a
   * hard error rather than a silently shortened catalog.
   */
  catalog(): readonly AssistantToolDefinition[] {
    return ASSISTANT_TOOL_NAMES.map((name) => {
      const tool = this.tools.get(name);
      if (tool === undefined) {
        throw new Error(`Assistant tool is defined but not registered: ${name}`);
      }
      return tool.definition;
    });
  }

  get(name: string): InternalTool | undefined {
    if (!isAssistantToolName(name)) return undefined;
    return this.tools.get(name);
  }

  parseArguments(name: string, value: unknown): { readonly tool: InternalTool; readonly arguments: AssistantJsonObject } {
    const tool = this.get(name);
    if (tool === undefined) throw new AssistantValidationError('AI 选择了不受支持的工具，未执行任何操作。');
    return { tool, arguments: tool.parseArguments(value) };
  }

  async read(context: AssistantToolContext, name: string, value: unknown): Promise<AssistantToolResult> {
    const { tool, arguments: args } = this.parseArguments(name, value);
    if (tool.definition.access !== 'read' || tool.read === undefined) {
      throw new AssistantValidationError('该助手工具不是只读工具。');
    }
    return projectAssistantReadResult(await tool.read({ ...context, capabilityCatalog: this.catalog() }, args), args);
  }

  async prepare(context: AssistantToolContext, name: string, value: unknown): Promise<AssistantPreparedTool> {
    const { tool, arguments: args } = this.parseArguments(name, value);
    if (tool.definition.access !== 'write' || tool.prepare === undefined) {
      throw new AssistantValidationError('该助手工具不是写入工具。');
    }
    return tool.prepare(context, args);
  }

  async confirm(context: AssistantToolContext, name: string, action: AssistantJsonObject, attachmentBytes?: Uint8Array): Promise<AssistantToolResult> {
    const tool = this.get(name);
    if (tool === undefined || tool.definition.access !== 'write' || tool.confirm === undefined) {
      throw new AssistantValidationError(`不支持的助手写入工具：${name}。`);
    }
    return tool.confirm(context, action, attachmentBytes);
  }

  /** Runs the synchronous domain writer for a caller-owned SQLite transaction. */
  confirmInTransaction(context: AssistantToolContext, name: string, action: AssistantJsonObject, attachmentBytes?: Uint8Array): AssistantToolResult {
    const tool = this.get(name);
    if (tool === undefined || tool.definition.access !== 'write' || tool.confirm === undefined) {
      throw new AssistantValidationError('不支持的助手写入工具。');
    }
    const result = tool.confirm(context, action, attachmentBytes);
    if (result instanceof Promise) throw new Error('Assistant write adapters must be synchronous inside the confirmation transaction.');
    return result;
  }

  private register(definition: AssistantToolDefinition, parseArguments: (value: unknown) => AssistantJsonObject, handlers: Pick<InternalTool, 'read' | 'prepare' | 'confirm'>): void {
    this.tools.set(definition.name, { definition, parseArguments, ...handlers });
  }

  private registerAll(): void {
    const definitions = new Map(createDefinitions().map((definition) => [definition.name, definition]));
    for (const tool of [...createBusinessTools(), ...createWorkspaceTools()]) {
      definitions.set(tool.definition.name, tool.definition);
      this.tools.set(tool.definition.name, tool);
    }
    for (const name of ASSISTANT_TOOL_NAMES) {
      if (!definitions.has(name)) {
        throw new Error(`Assistant tool definition is missing: ${name}`);
      }
    }
    for (const definition of definitions.values()) {
      if (!isAssistantToolName(definition.name)) {
        throw new Error(`Assistant tool definition is not in the allowlist: ${String(definition.name)}`);
      }
    }
    const def = (name: AssistantToolName): AssistantToolDefinition => {
      const definition = definitions.get(name);
      if (definition === undefined) {
        throw new Error(`Assistant tool definition is missing: ${name}`);
      }
      return definition;
    };
    const empty = (value: unknown): AssistantJsonObject => {
      const record = argsRecord(value);
      onlyKnown(record, []);
      return {};
    };

    this.register(def('transactions.recent'), (value) => {
      const record = argsRecord(value);
      onlyKnown(record, ['limit', 'q', 'type']);
      const limit = integerArg(record, 'limit', 1, 50) ?? 10;
      const q = stringArg(record, 'q', false, 100);
      const type = integerArg(record, 'type', 0, 1);
      return json({ limit, ...(q === undefined ? {} : { q }), ...(type === undefined ? {} : { type }) }, '工具参数');
    }, {
      read: (context, args) => {
        const result = context.services.transactions.list({
          limit: args['limit'] as number,
          ...(typeof args['q'] === 'string' ? { q: args['q'] } : {}),
          ...(args['type'] === 0 || args['type'] === 1 ? { type: args['type'] } : {}),
        });
        return toolResult('transactions.recent', `找到 ${result.items.length} 笔最近账单。`, {
          total: result.total,
          items: result.items.slice(0, 50),
        });
      },
    });

    this.register(def('accounts.balances'), (value) => {
      const record = argsRecord(value); onlyKnown(record, ['limit', 'offset']);
      return { limit: integerArg(record, 'limit', 1, 100) ?? 100, offset: integerArg(record, 'offset', 0) ?? 0 };
    }, {
      read: (context, args) => {
        const result = context.services.balances.balances();
        const limit = args['limit'] as number; const offset = args['offset'] as number;
        return toolResult('accounts.balances', '这是服务端计算的账户余额；总余额包含所有账户。', { ...result, items: result.items.slice(offset, offset + limit), total: result.items.length, offset, limit, hasMore: offset + limit < result.items.length });
      },
    });

    this.register(def('budget.overview'), (value) => {
      const record = argsRecord(value);
      onlyKnown(record, ['periodStart']);
      const periodStart = integerArg(record, 'periodStart');
      return json(periodStart === undefined ? {} : { periodStart }, '工具参数');
    }, {
      read: (context, args) => toolResult('budget.overview', '这是服务端计算的预算概览。', context.services.budget.overview(typeof args['periodStart'] === 'number' ? args['periodStart'] : undefined)),
    });

    this.register(def('stats.monthly'), (value) => {
      const record = argsRecord(value);
      onlyKnown(record, ['months']);
      return json({ months: integerArg(record, 'months', 1, 12) ?? 6 }, '工具参数');
    }, {
      read: (context, args) => toolResult('stats.monthly', '这是服务端计算的月度统计。', { items: context.services.stats.monthlyTrend(args['months'] as number) }),
    });

    this.register(def('recurring.pending'), empty, {
      read: (context) => toolResult('recurring.pending', '这是当前待确认的周期账单。', { items: context.services.recurring.listPending().slice(0, MAX_RESULT_ITEMS) }),
    });

    this.register(def('monthly.evaluate'), empty, {
      read: async (context) => {
        const result = await context.services.monthly.evaluate();
        return toolResult('monthly.evaluate', '月度评价已生成，数字来自服务端事实。', result);
      },
    });

    this.register(def('organization.preview'), (value) => {
      const record = argsRecord(value); onlyKnown(record, ['offset', 'limit']);
      return { offset: integerArg(record, 'offset', 0) ?? 0, limit: integerArg(record, 'limit', 1, 100) ?? 30 };
    }, {
      read: async (context, args) => organizationPage(await context.services.organization.preview({ explain: args['offset'] === 0 }), args['offset'] as number, args['limit'] as number),
    });

    this.register(def('backups.list'), empty, {
      read: (context) => toolResult('backups.list', '这是可用的备份文件名。', { items: context.services.portability.listBackups() }),
    });

    this.register(def('backup.export-links'), empty, {
      read: () => toolResult('backup.export-links', '这是数据导出链接。', { links: ['transactions', 'salaries', 'recurring', 'transfers'].map((what) => ({ what, url: `/api/v1/export/${what}.csv` })) }),
    });

    this.register(def('transaction.create'), (value) => {
      const record = argsRecord(value);
      return json(record, '交易参数');
    }, {
      prepare: (context, args) => {
        const { args: normalized, input } = preparedTransaction(args, context.services.transactions);
        return prepared(
          'transaction.create',
          '新增账单',
          `准备新增一笔${input.type === TYPE_INCOME ? '收入' : '支出'} ${input.amountCents} 分。`,
          { count: 1 },
          { type: input.type, amountCents: input.amountCents, categoryId: input.categoryId,
            categoryName: context.services.masterData.getCategoryOrThrow(input.categoryId).name,
            accountId: input.accountId, accountName: context.services.masterData.getAccountOrThrow(input.accountId).name,
            date: input.date, note: input.note, tags: input.tags, isRefund: input.isRefund, fundPurpose: input.fundPurpose },
          { input: normalized, refundOriginals: input.refundLinkedTxIds.map((id) => context.services.transactions.getByIdOrThrow(id)) },
          normalized,
          hashJson({ toolName: 'transaction.create', input: normalized,
            category: context.services.masterData.getCategoryOrThrow(input.categoryId),
            account: context.services.masterData.getAccountOrThrow(input.accountId),
            originals: input.refundLinkedTxIds.map((id) => context.services.transactions.getByIdOrThrow(id)),
          }),
          undefined,
          [],
        );
      },
      confirm: (context, action) => {
        const { args } = preparedTransaction(argsRecord(action), context.services.transactions);
        const transaction = context.services.transactions.create(args);
        return toolResult('transaction.create', '账单已写入。', { transaction });
      },
    });

    this.register(def('transaction.update'), (value) => {
      const record = argsRecord(value);
      onlyKnown(record, ['id', 'changes']);
      const id = stringArg(record, 'id');
      const rawChanges = argsRecord(record['changes']);
      onlyKnown(rawChanges, ['type', 'amountCents', 'amountYuan', 'amount', 'categoryId', 'accountId', 'date', 'note', 'tags', 'isRefund', 'refundLinkedTxIds', 'fundPurpose', 'expectedFundPurposeRevision', 'expectedTransactionToken', 'operationId']);
      if (Object.keys(rawChanges).length === 0) throw new AssistantValidationError('changes 不能为空。');
      const changes: Record<string, unknown> = {};
      if (rawChanges['type'] !== undefined) {
        const type = rawChanges['type'];
        if (type !== 0 && type !== 1 && type !== 'expense' && type !== 'income') throw new AssistantValidationError('type 必须为 expense 或 income。');
        changes['type'] = type === 'expense' ? TYPE_EXPENSE : type === 'income' ? TYPE_INCOME : type;
      }
      if (rawChanges['amountCents'] !== undefined || rawChanges['amountYuan'] !== undefined || rawChanges['amount'] !== undefined) {
        changes['amountCents'] = amountArg(rawChanges);
      }
      if (rawChanges['categoryId'] !== undefined) changes['categoryId'] = stringArg(rawChanges, 'categoryId');
      if (rawChanges['accountId'] !== undefined) changes['accountId'] = stringArg(rawChanges, 'accountId');
      if (rawChanges['date'] !== undefined) changes['date'] = dateArg(rawChanges);
      if (rawChanges['note'] !== undefined) {
        if (typeof rawChanges['note'] !== 'string') throw new AssistantValidationError('note 必须是文本。');
        changes['note'] = rawChanges['note'].slice(0, 200);
      }
      if (rawChanges['tags'] !== undefined) changes['tags'] = stringArrayArg(rawChanges, 'tags', true);
      if (rawChanges['isRefund'] !== undefined) changes['isRefund'] = booleanArg(rawChanges, 'isRefund');
      if (rawChanges['refundLinkedTxIds'] !== undefined) changes['refundLinkedTxIds'] = stringArrayArg(rawChanges, 'refundLinkedTxIds', true);
      for (const key of ['fundPurpose', 'expectedFundPurposeRevision', 'expectedTransactionToken', 'operationId']) if (rawChanges[key] !== undefined) changes[key] = rawChanges[key];
      return json({ id, changes }, 'transaction.update');
    }, {
      prepare: (context, args) => {
        const id = stringArg(argsRecord(args), 'id');
        const changes = argsRecord(args['changes']);
        const before = context.services.transactions.getByIdOrThrow(id);
        const normalizedChanges = changes['fundPurpose'] === undefined ? changes : {
          ...changes,
          operationId: changes['operationId'] ?? randomUUID(),
          expectedFundPurposeRevision: changes['expectedFundPurposeRevision'] ?? before.fundPurposeRevision,
          expectedTransactionToken: changes['expectedTransactionToken'] ?? financialTransactionToken({ ...before, deleted: false }),
        };
        // Validate the complete domain write, including purpose CAS/replay and refund
        // constraints. Persist the generated operation identity and snapshot tokens.
        const after = simulateAssistantWrite(context, () => context.services.transactions.update(id, normalizedChanges));
        return prepared('transaction.update', '修改账单', `准备修改账单 ${id}。`, { count: 1, ids: [id] }, {
          ...after,
          categoryName: context.services.masterData.getCategoryOrThrow(after.categoryId).name,
          accountName: context.services.masterData.getAccountOrThrow(after.accountId).name,
        }, { before, after }, json({ id, changes: normalizedChanges }, '账单修改参数'), hashJson({ before, deleted: 0 }));
      },
      confirm: (context, action) => {
        const record = argsRecord(action);
        const id = stringArg(record, 'id');
        const changes = argsRecord(record['changes']);
        return toolResult('transaction.update', '账单已更新。', { transaction: context.services.transactions.update(id, changes) });
      },
    });

    this.register(def('transaction.delete'), (value) => {
      const record = argsRecord(value); onlyKnown(record, ['id']);
      return json({ id: stringArg(record, 'id') }, 'transaction.delete');
    }, {
      prepare: (context, args) => {
        const id = args['id'] as string;
        const transaction = context.services.transactions.getByIdOrThrow(id);
        return prepared('transaction.delete', '移入回收站', `准备将账单 ${id} 移入回收站。`, { count: 1, ids: [id] }, { id, amountCents: transaction.amountCents, date: transaction.date, note: transaction.note }, { transaction }, args, hashJson({ transaction, deleted: 0 }));
      },
      confirm: (context, action) => {
        const id = stringArg(argsRecord(action), 'id');
        context.services.transactions.softDelete(id);
        return toolResult('transaction.delete', '账单已移入回收站。', { id, deleted: true });
      },
    });

    this.register(def('transaction.restore'), (value) => {
      const record = argsRecord(value); onlyKnown(record, ['id']);
      return json({ id: stringArg(record, 'id') }, 'transaction.restore');
    }, {
      prepare: (context, args) => {
        const id = args['id'] as string;
        const transaction = context.services.transactions.getById(id, true);
        const row = context.db.prepare('SELECT deleted FROM transactions WHERE id = ?').get(id) as { deleted: number } | undefined;
        if (transaction === undefined || row?.deleted !== 1) throw new AssistantActionStaleError('只能恢复回收站中的账单。');
        return prepared('transaction.restore', '恢复账单', `准备将账单 ${id} 恢复到账本。`, { count: 1, ids: [id] }, transaction, { transaction, deleted: true }, args, hashJson({ transaction, deleted: row.deleted }));
      },
      confirm: (context, action) => {
        const id = stringArg(argsRecord(action), 'id');
        return toolResult('transaction.restore', '账单已恢复。', { transaction: context.services.transactions.restore(id) });
      },
    });

    this.register(def('transfer.create'), (value) => {
      const record = argsRecord(value); onlyKnown(record, ['fromAccountId', 'toAccountId', 'amountCents', 'date', 'note']);
      const note = typeof record['note'] === 'string' ? record['note'].slice(0, 200) : '';
      return json({ fromAccountId: stringArg(record, 'fromAccountId'), toAccountId: stringArg(record, 'toAccountId'), amountCents: integerArg(record, 'amountCents', 1), date: dateArg(record), note }, 'transfer.create');
    }, {
      prepare: (context, args) => {
        const from = context.services.masterData.getAccountOrThrow(args['fromAccountId'] as string);
        const to = context.services.masterData.getAccountOrThrow(args['toAccountId'] as string);
        if (from.id === to.id) throw new AssistantValidationError('转出账户和转入账户必须不同。');
        const value = { ...args, fromAccount: from.name, toAccount: to.name };
        return prepared('transfer.create', '创建转账', `准备从 ${from.name} 转入 ${to.name}。`, { count: 1 }, { fromAccountId: from.id, fromAccountName: from.name, toAccountId: to.id, toAccountName: to.name, amountCents: args['amountCents'], date: args['date'], note: args['note'] }, { value }, args, hashJson({ args, from, to }));
      },
      confirm: (context, action) => {
        const record = argsRecord(action);
        return toolResult('transfer.create', '转账已创建。', { transfer: context.services.transfers.create(record) });
      },
    });

    this.register(def('category.create'), (value) => {
      const record = argsRecord(value); onlyKnown(record, ['name', 'type', 'icon', 'color', 'sortOrder', 'parentId']);
      const name = stringArg(record, 'name', true, 40);
      const type = integerArg(record, 'type', 0, 1);
      if (type !== TYPE_EXPENSE && type !== TYPE_INCOME) throw new AssistantValidationError('type 必须为支出或收入分类类型。');
      const parentId = record['parentId'] === null ? null : stringArg(record, 'parentId', false);
      const icon = stringArg(record, 'icon', false, 32);
      const color = integerArg(record, 'color', 0, 0xffffffff);
      const sortOrder = integerArg(record, 'sortOrder');
      return json({ name, type, ...(parentId === undefined ? {} : { parentId }), ...(icon === undefined ? {} : { icon }), ...(color === undefined ? {} : { color }), ...(sortOrder === undefined ? {} : { sortOrder }) }, 'category.create');
    }, {
      prepare: (context, args) => {
        const parentId = typeof args['parentId'] === 'string' ? args['parentId'] : null;
        const parent = parentId === null ? null : context.services.masterData.getCategoryOrThrow(parentId);
        if (parent !== null && (args['type'] !== parent.type || parent.parentId !== null)) throw new AssistantValidationError('父分类必须是同类型的一级支出分类。');
        const categories = context.services.masterData.listCategories();
        return prepared('category.create', '创建分类', `准备创建分类“${args['name']}”。`, { count: 1 }, args, { category: args, parent }, args, hashJson({ categories, args, parent }));
      },
      confirm: (context, action) => toolResult('category.create', '分类已创建。', { category: context.services.masterData.createCategory(argsRecord(action)) }),
    });

    this.register(def('category.update'), (value) => {
      const record = argsRecord(value); onlyKnown(record, ['id', 'changes']);
      const id = stringArg(record, 'id'); const changes = argsRecord(record['changes']);
      onlyKnown(changes, ['name', 'icon', 'color', 'sortOrder', 'parentId']);
      const normalized: Record<string, unknown> = {};
      if (changes['name'] !== undefined) normalized['name'] = stringArg(changes, 'name', true, 40);
      if (changes['icon'] !== undefined) normalized['icon'] = stringArg(changes, 'icon', true, 32);
      if (changes['color'] !== undefined) normalized['color'] = integerArg(changes, 'color', 0, 0xffffffff);
      if (changes['sortOrder'] !== undefined) normalized['sortOrder'] = integerArg(changes, 'sortOrder');
      if (changes['parentId'] !== undefined) normalized['parentId'] = changes['parentId'] === null ? null : stringArg(changes, 'parentId');
      if (Object.keys(normalized).length === 0) throw new AssistantValidationError('changes 不能为空。');
      return json({ id, changes: normalized }, 'category.update');
    }, {
      prepare: (context, args) => {
        const id = args['id'] as string; const current = context.services.masterData.getCategoryOrThrow(id);
        const changes = argsRecord(args['changes']);
        const parentId = changes['parentId'] === undefined ? current.parentId : changes['parentId'];
        const parent = typeof parentId === 'string' ? context.services.masterData.getCategoryOrThrow(parentId) : null;
        if (parent !== null && (parent.type !== current.type || parent.parentId !== null || parent.id === id)) throw new AssistantValidationError('父分类必须是同类型且不能形成层级循环。');
        return prepared('category.update', '修改分类', `准备修改分类“${current.name}”。`, { count: 1, ids: [id] }, { ...current, ...changes }, { before: current, after: { ...current, ...changes } }, args, hashJson({ current }));
      },
      confirm: (context, action) => {
        const record = argsRecord(action);
        return toolResult('category.update', '分类已更新。', { category: context.services.masterData.updateCategory(stringArg(record, 'id'), argsRecord(record['changes'])) });
      },
    });

    this.register(def('category.delete'), (value) => {
      const record = argsRecord(value); onlyKnown(record, ['id']);
      return json({ id: stringArg(record, 'id') }, 'category.delete');
    }, {
      prepare: (context, args) => {
        const id = args['id'] as string; const category = context.services.masterData.getCategoryOrThrow(id);
        if (category.isBuiltin) throw new AssistantValidationError('内置分类不能删除。');
        const transactionCount = context.services.masterData.countTransactionsForCategory(id);
        const ruleCount = (context.db.prepare('SELECT COUNT(*) AS count FROM recurring_rules WHERE deleted = 0 AND category_id = ?').get(id) as { count: number }).count;
        const occurrenceCount = (context.db.prepare("SELECT COUNT(*) AS count FROM recurring_occurrences WHERE deleted = 0 AND status = 'pending' AND category_id = ?").get(id) as { count: number }).count;
        return prepared('category.delete', '软删除分类', `准备删除分类“${category.name}”。`, { count: transactionCount + ruleCount + occurrenceCount, ids: [id] }, { category, transactionCount, ruleCount, occurrenceCount }, { category, transactionCount, ruleCount, occurrenceCount }, args, hashJson({ category, transactionCount, ruleCount, occurrenceCount }), undefined, transactionCount > 0 ? ['已有历史账单使用此分类；历史记录会保留其分类引用。'] : []);
      },
      confirm: (context, action) => { const id = stringArg(argsRecord(action), 'id'); context.services.masterData.deleteCategory(id); return toolResult('category.delete', '分类已软删除。', { id, deleted: true }); },
    });

    this.register(def('account.create'), (value) => {
      const record = argsRecord(value); onlyKnown(record, ['name', 'type', 'initialBalanceCents', 'sortOrder']);
      const name = stringArg(record, 'name', true, 40); const type = integerArg(record, 'type', 0, 5);
      if (type === undefined) throw new AssistantValidationError('账户类型无效。');
      return json({ name, type, initialBalanceCents: integerArg(record, 'initialBalanceCents') ?? 0, ...(integerArg(record, 'sortOrder') === undefined ? {} : { sortOrder: integerArg(record, 'sortOrder') }) }, 'account.create');
    }, {
      prepare: (context, args) => {
        const accounts = context.services.masterData.listAccounts();
        if (!Number.isInteger(args['type']) || ![0, 1, 2, 3, 4, 5].includes(args['type'] as number)) throw new AssistantValidationError('账户类型无效。');
        return prepared('account.create', '创建账户', `准备创建账户“${args['name']}”。`, { count: 1 }, args, { account: args }, args, hashJson({ accounts, args }));
      },
      confirm: (context, action) => toolResult('account.create', '账户已创建。', { account: context.services.masterData.createAccount(argsRecord(action)) }),
    });

    this.register(def('account.update'), (value) => {
      const record = argsRecord(value); onlyKnown(record, ['id', 'changes']);
      const id = stringArg(record, 'id'); const changes = argsRecord(record['changes']);
      onlyKnown(changes, ['name', 'type', 'initialBalanceCents', 'sortOrder']);
      const normalized: Record<string, unknown> = {};
      if (changes['name'] !== undefined) normalized['name'] = stringArg(changes, 'name', true, 40);
      for (const key of ['type', 'initialBalanceCents', 'sortOrder'] as const) if (changes[key] !== undefined) normalized[key] = integerArg(changes, key);
      if (Object.keys(normalized).length === 0) throw new AssistantValidationError('changes 不能为空。');
      return json({ id, changes: normalized }, 'account.update');
    }, {
      prepare: (context, args) => {
        const id = args['id'] as string; const current = context.services.masterData.getAccountOrThrow(id);
        return prepared('account.update', '修改账户', `准备修改账户“${current.name}”。`, { count: 1, ids: [id] }, { ...current, ...argsRecord(args['changes']) }, { before: current, after: { ...current, ...argsRecord(args['changes']) } }, args, hashJson({ current }));
      },
      confirm: (context, action) => { const record = argsRecord(action); return toolResult('account.update', '账户已更新。', { account: context.services.masterData.updateAccount(stringArg(record, 'id'), argsRecord(record['changes'])) }); },
    });

    this.register(def('account.delete'), (value) => { const record = argsRecord(value); onlyKnown(record, ['id']); return json({ id: stringArg(record, 'id') }, 'account.delete'); }, {
      prepare: (context, args) => {
        const id = args['id'] as string; const account = context.services.masterData.getAccountOrThrow(id);
        if (account.isBuiltin) throw new AssistantValidationError('默认账户不能删除。');
        const usage = { transactions: context.services.masterData.countTransactionsForAccount(id), salaries: (context.db.prepare('SELECT COUNT(*) AS count FROM salary_records WHERE deleted = 0 AND account_id = ?').get(id) as { count: number }).count, transfers: (context.db.prepare('SELECT COUNT(*) AS count FROM transfers WHERE deleted = 0 AND (from_account_id = ? OR to_account_id = ?)').get(id, id) as { count: number }).count };
        return prepared('account.delete', '软删除账户', `准备删除账户“${account.name}”。`, { count: usage.transactions + usage.salaries + usage.transfers, ids: [id] }, { account, usage }, { account, usage }, args, hashJson({ account, usage }), undefined, usage.transactions + usage.salaries > 0 ? ['历史账单或工资仍引用此账户；删除后账户余额将不再纳入账户列表。'] : []);
      },
      confirm: (context, action) => { const id = stringArg(argsRecord(action), 'id'); context.services.masterData.deleteAccount(id); return toolResult('account.delete', '账户已软删除。', { id, deleted: true }); },
    });

    this.register(def('backup.create'), empty, {
      prepare: (context, args) => {
        const version = context.db.pragma('schema_version') as number;
        const counts = context.db.prepare("SELECT name, (SELECT COUNT(*) FROM sqlite_master m2 WHERE m2.type = 'table' AND m2.name = m.name) AS present FROM sqlite_master m WHERE type = 'table' AND name IN ('transactions','salary_records','transfers','categories','accounts') ORDER BY name").all();
        return prepared('backup.create', '创建数据库备份', '准备创建当前账本的数据库备份。', { count: 1 }, { includes: ['transactions', 'salaries', 'transfers', 'categories', 'accounts'] }, { schemaVersion: version }, args, hashJson({ version, counts }));
      },
      confirm: (context) => toolResult('backup.create', '数据库备份已创建。', context.services.portability.createBackupNow()),
    });

    this.register(def('platform-import.prepare'), importArgs, {
      prepare: (context, args) => {
        if (context.attachmentBytes === undefined || context.attachment === undefined) throw new AssistantAttachmentRequiredError();
        const source = args['source'] as 'auto' | PlatformBillSource;
        const fileName = typeof args['fileName'] === 'string' ? args['fileName'] : context.attachment.fileName;
        const selectedIds = Array.isArray(args['selectedIds']) ? args['selectedIds'].filter((id): id is string => typeof id === 'string') : null;
        const categoryOverrides = isRecord(args['categoryOverrides'])
          ? Object.fromEntries(
              Object.entries(args['categoryOverrides']).filter(
                (entry): entry is [string, string] => typeof entry[1] === 'string',
              ),
            )
          : {};
        const noteOverrides = (args['noteOverrides'] ?? {}) as Record<string, string>;
        const categories = importCategories(context);
        const preview = context.services.portability.importPlatformBills(Buffer.from(context.attachmentBytes), { source, dryRun: true, fileName, selectedIds, strictCategories: true, categoryIds: categoryOverrides, noteOverrides });
        const previewData = { ...preview, categories, rows: boundedRows(preview as unknown as { rows: readonly Record<string, unknown>[] }) };
        return prepared(
          'platform-import.prepare',
          `${preview.source === 'wechat' ? '微信' : '支付宝'}账单导入`,
          `文件预览完成：共 ${preview.total} 行，展示最多200行；请审核分类、备注并显式选择后确认。`,
          { count: preview.selected, ids: preview.rows.filter((row) => !row.alreadyExists && row.amountCents > 0).slice(0, MAX_RESULT_ITEMS).map((row) => row.id) },
          { source: preview.source, total: preview.total, selected: preview.selected, expenseCents: preview.expenseCents, incomeCents: preview.incomeCents, fileName },
          { ...previewData, attachment: context.attachment },
          json({ source, fileName, selectedIds, categoryOverrides, noteOverrides }, '导入参数'),
          hashJson({ digest: context.attachment.sha256, source, fileName, selectedIds, categoryOverrides, noteOverrides, categories, rows: preview.rows }),
          context.attachment,
          preview.warnings,
        );
      },
      confirm: (context, action, attachmentBytes) => {
        if (attachmentBytes === undefined || context.attachment === undefined) throw new AssistantAttachmentRequiredError();
        const record = argsRecord(action);
        const source = record['source'] as 'auto' | PlatformBillSource;
        const fileName = typeof record['fileName'] === 'string' ? record['fileName'] : context.attachment.fileName;
        const selectedIds = Array.isArray(record['selectedIds']) ? record['selectedIds'].filter((id): id is string => typeof id === 'string') : null;
        const categoryOverrides = isRecord(record['categoryOverrides'])
          ? Object.fromEntries(
              Object.entries(record['categoryOverrides']).filter(
                (entry): entry is [string, string] => typeof entry[1] === 'string',
              ),
            )
          : {};
        const noteOverrides = (record['noteOverrides'] ?? {}) as Record<string, string>;
        if (!selectedIds || selectedIds.length === 0 || selectedIds.length > 100) throw new AssistantValidationError('必须显式选择1–100行。');
        const categories = importCategories(context);
        const current = context.services.portability.importPlatformBills(Buffer.from(attachmentBytes), { source, dryRun: true, fileName, selectedIds, strictCategories: true, categoryIds: categoryOverrides, noteOverrides });
        const currentFingerprint = hashJson({ digest: context.attachment.sha256, source, fileName, selectedIds, categoryOverrides, noteOverrides, categories, rows: current.rows });
        const expected = typeof action['__fingerprint'] === 'string' ? action['__fingerprint'] : undefined;
        if (expected !== undefined && expected !== currentFingerprint) throw new AssistantActionStaleError('账单预览已变化，请重新上传并预览。');
        const result = context.services.portability.importPlatformBills(Buffer.from(attachmentBytes), { source, dryRun: false, fileName, selectedIds, strictCategories: true, categoryIds: categoryOverrides, noteOverrides });
        return toolResult('platform-import.prepare', '账单已导入。', { inserted: result.inserted, skipped: result.skipped, ignored: result.ignored, selected: result.selected, expenseCents: result.expenseCents, incomeCents: result.incomeCents, source: result.source });
      },
    });

    this.register(def('organization.apply'), (value) => {
      const record = argsRecord(value);
      onlyKnown(record, ['actionIds', 'previewHash']);
      const actionIds = stringArrayArg(record, 'actionIds', true) ?? [];
      if (actionIds.length === 0 || new Set(actionIds).size !== actionIds.length) throw new AssistantValidationError('必须明确选择不重复的整理动作。');
      return json({ actionIds, ...(record['previewHash'] === undefined ? {} : { previewHash: stringArg(record, 'previewHash') }) }, '整理参数');
    }, {
      prepare: async (context, args) => {
        // Explain the initial review, but confirmation rebuilds only deterministic
        // domain facts and must not launch a fresh provider request.
        const preview = await context.services.organization.preview({ explain: args['previewHash'] === undefined });
        if (args['previewHash'] !== undefined && args['previewHash'] !== preview.previewHash) throw new AssistantActionStaleError();
        const actionIds = args['actionIds'] as string[];
        if (actionIds.length === 0) throw new AssistantValidationError('没有可确认的整理动作。');
        const selected = preview.actions.filter((action) => actionIds.includes(action.actionId));
        if (selected.length !== actionIds.length) throw new AssistantActionStaleError('整理动作已变化，请重新预览。');
        return prepared('organization.apply', '应用账本整理', `准备应用 ${selected.length} 项整理动作。`, { count: selected.length, ids: actionIds }, { previewHash: preview.previewHash, actionIds }, { ...preview, actions: selected }, json({ previewHash: preview.previewHash, actionIds }, '整理参数'), hashJson({ previewHash: preview.previewHash, actionIds }), undefined, selected.flatMap((action) => action.blockers));
      },
      confirm: (context, action) => {
        const previewHash = stringArg(argsRecord(action), 'previewHash');
        const actionIds = stringArrayArg(argsRecord(action), 'actionIds', true) ?? [];
        const result = context.services.organization.apply({ previewHash, actionIds });
        return toolResult('organization.apply', '整理已应用并写入审计记录。', result);
      },
    });

    this.register(def('organization.undo'), (value) => {
      const record = argsRecord(value);
      onlyKnown(record, ['operationId']);
      return json({ operationId: stringArg(record, 'operationId') }, '撤销参数');
    }, {
      prepare: (context, args) => {
        const operationId = args['operationId'] as string;
        const rows = context.db.prepare('SELECT operation_id, action_id, status FROM ai_organization_audit WHERE operation_id = ?').all(operationId) as { operation_id: string; action_id: string; status: string }[];
        if (rows.length === 0 || rows.some((row) => row.status !== 'applied')) throw new AssistantActionStaleError('整理操作不存在或已撤销。');
        return prepared('organization.undo', '撤销账本整理', `准备撤销整理操作 ${operationId}。`, { count: rows.length }, { operationId }, { operationId, actionIds: rows.map((row) => row.action_id) }, json({ operationId }, '撤销参数'), hashJson({ operationId, rows }));
      },
      confirm: (context, action) => toolResult('organization.undo', '整理已条件撤销。', context.services.organization.undo((action as Record<string, unknown>)['operationId'])),
    });

    this.register(def('recurring.confirm'), (value) => {
      const record = argsRecord(value);
      onlyKnown(record, ['occurrenceId']);
      return json({ occurrenceId: stringArg(record, 'occurrenceId') }, '周期账单参数');
    }, {
      prepare: (context, args) => {
        const occurrenceId = args['occurrenceId'] as string;
        const occurrence = context.services.recurring.listPending().find((item) => item.id === occurrenceId);
        if (occurrence === undefined) throw new AssistantActionStaleError('待确认周期账单不存在或已处理。');
        return prepared('recurring.confirm', '确认周期账单', `准备确认周期账单「${occurrence.note || occurrence.id}」。`, { count: 1, ids: [occurrenceId] }, { occurrenceId, amountCents: occurrence.amountCents, date: occurrence.plannedDate, note: occurrence.note }, { occurrence }, json({ occurrenceId }, '周期账单参数'), hashJson({ occurrenceId, updatedAt: occurrence.updatedAt, status: occurrence.status }));
      },
      confirm: (context, action) => {
        const occurrenceId = stringArg(argsRecord(action), 'occurrenceId');
        return toolResult('recurring.confirm', '周期账单已确认。', context.services.recurring.confirmOccurrence(occurrenceId));
      },
    });

    this.register(def('recurring.ignore'), (value) => {
      const record = argsRecord(value);
      onlyKnown(record, ['occurrenceId']);
      return json({ occurrenceId: stringArg(record, 'occurrenceId') }, '周期账单参数');
    }, {
      prepare: (context, args) => {
        const occurrenceId = args['occurrenceId'] as string;
        const occurrence = context.services.recurring.listPending().find((item) => item.id === occurrenceId);
        if (occurrence === undefined) throw new AssistantActionStaleError('待确认周期账单不存在或已处理。');
        return prepared('recurring.ignore', '忽略周期账单', `准备忽略周期账单「${occurrence.note || occurrence.id}」。`, { count: 1, ids: [occurrenceId] }, { occurrenceId, amountCents: occurrence.amountCents, date: occurrence.plannedDate }, { occurrence }, json({ occurrenceId }, '周期账单参数'), hashJson({ occurrenceId, updatedAt: occurrence.updatedAt, status: occurrence.status }));
      },
      confirm: (context, action) => {
        const occurrenceId = stringArg(argsRecord(action), 'occurrenceId');
        return toolResult('recurring.ignore', '周期账单已忽略。', { occurrence: context.services.recurring.ignoreOccurrence(occurrenceId) });
      },
    });

    this.register(def('tag.rename'), (value) => {
      const record = argsRecord(value);
      onlyKnown(record, ['from', 'to']);
      return json({ from: stringArg(record, 'from', true, 32), to: stringArg(record, 'to', true, 32) }, '标签参数');
    }, {
      prepare: (context, args) => {
        const from = args['from'] as string;
        const to = args['to'] as string;
        const tags = context.services.masterData.listTags();
        if (!tags.some((tag) => tag.name === from)) throw new AssistantActionStaleError('源标签不存在。');
        return prepared('tag.rename', '重命名标签', `准备把标签「${from}」重命名为「${to}」。`, { count: tags.find((tag) => tag.name === from)?.count ?? 0 }, { from, to }, { tags }, json({ from, to }, '标签参数'), hashJson({ tags, from, to }));
      },
      confirm: (context, action) => {
        const record = argsRecord(action);
        const from = stringArg(record, 'from');
        const to = stringArg(record, 'to');
        const current = context.services.masterData.listTags();
        if (hashJson({ tags: current, from, to }) !== String(record['__fingerprint'] ?? '')) throw new AssistantActionStaleError('标签已变化，请重新预览。');
        return toolResult('tag.rename', '标签已重命名。', context.services.masterData.renameTag(from, to));
      },
    });

    this.register(def('tag.delete'), (value) => {
      const record = argsRecord(value);
      onlyKnown(record, ['name']);
      return json({ name: stringArg(record, 'name', true, 32) }, '标签参数');
    }, {
      prepare: (context, args) => {
        const name = args['name'] as string;
        const tags = context.services.masterData.listTags();
        const found = tags.find((tag) => tag.name === name);
        if (found === undefined) throw new AssistantActionStaleError('标签不存在。');
        return prepared('tag.delete', '删除标签', `准备从账单中删除标签「${name}」。`, { count: found.count }, { name }, { tags }, json({ name }, '标签参数'), hashJson({ tags, name }));
      },
      confirm: (context, action) => {
        const record = argsRecord(action);
        const name = stringArg(record, 'name');
        const current = context.services.masterData.listTags();
        if (hashJson({ tags: current, name }) !== String(record['__fingerprint'] ?? '')) throw new AssistantActionStaleError('标签已变化，请重新预览。');
        return toolResult('tag.delete', '标签已删除。', context.services.masterData.deleteTag(name));
      },
    });

    if (this.tools.size !== ASSISTANT_TOOL_NAMES.length) {
      throw new Error(
        `Assistant tool registry size mismatch: registered ${this.tools.size}, allowlist ${ASSISTANT_TOOL_NAMES.length}`,
      );
    }
  }
}
