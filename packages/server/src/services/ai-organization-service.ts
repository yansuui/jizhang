/**
 * Deterministic organization preview, provider explanation, atomic apply, and conditional undo.
 *
 * The provider never decides ids or rewrites data. This service discovers candidates from
 * SQLite, fingerprints the exact rewrite set, and owns every mutation behind a transaction.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import { AiConfigService } from './ai-config-service.js';
import { AiProviderService } from './ai-provider-service.js';
import {
  AiError,
  AiOrganizationConflictError,
  AiOrganizationInputError,
  AiOrganizationResponseInvalidError,
  type AiOrganizationAction,
  type AiOrganizationActionKind,
  type AiOrganizationOperationResult,
  type AiOrganizationPreview,
  type AiOrganizationRecommendation,
} from './ai-types.js';
import { normaliseTags, parseTagsJson, serialiseTags } from './tags.js';
import { TagCatalogService } from './tag-catalog-service.js';

const MAX_SELECTED_ACTIONS = 100;
const MAX_SAMPLE_IDS = 5;
const MAX_REASON_LENGTH = 300;
const MAX_SEMANTIC_TRANSACTIONS = 200;
const MAX_NOTE_PREVIEW = 120;

interface CategoryRow {
  readonly id: string;
  readonly name: string;
  readonly type: number;
  readonly parent_id: string | null;
  readonly is_builtin: number;
  readonly deleted: number;
}

interface TransactionTagRow {
  readonly id: string;
  readonly tags_json: string;
  readonly category_id?: string;
  readonly deleted?: number;
}

interface SemanticTransactionRow {
  readonly id: string;
  readonly type: number;
  readonly category_id: string;
  readonly note: string;
  readonly tags_json: string;
}

interface JsonRow {
  readonly id: string;
  readonly value: string;
}

interface RefRow {
  readonly id: string;
  readonly category_id: string;
}

interface CategoryState {
  readonly id: string;
  readonly deleted: number;
  readonly parentId: string | null;
}

interface TransactionState {
  readonly id: string;
  readonly categoryId?: string;
  readonly tagsJson?: string;
}

interface JsonState {
  readonly id: string;
  readonly value: string;
}

interface RefState {
  readonly id: string;
  readonly categoryId: string;
}

interface AuditProjection {
  readonly categories?: readonly CategoryState[];
  readonly transactions?: readonly TransactionState[];
  readonly budgetAllocations?: readonly JsonState[];
  readonly templates?: readonly JsonState[];
  readonly recurringRules?: readonly RefState[];
  readonly pendingOccurrences?: readonly RefState[];
}

interface ActionPlan extends AiOrganizationAction {
  readonly before: AuditProjection;
  readonly after: AuditProjection;
}

interface AuditRow {
  readonly id: string;
  readonly operation_id: string;
  readonly event_type: 'apply' | 'undo';
  readonly action_id: string;
  readonly kind: AiOrganizationActionKind;
  readonly source_id: string;
  readonly target_id: string;
  readonly affected_row_ids_json: string;
  readonly before_json: string;
  readonly after_json: string;
  readonly status: 'applied' | 'undone';
  readonly created_at: number;
}

interface OrganizationFacts {
  readonly actions: readonly Pick<
    AiOrganizationAction,
    | 'actionId'
    | 'kind'
    | 'sourceId'
    | 'sourceName'
    | 'targetId'
    | 'targetName'
    | 'status'
    | 'blockers'
    | 'affected'
  >[];
}

interface SemanticFacts {
  readonly transactions: readonly {
    readonly transactionId: string;
    readonly type: number;
    readonly categoryId: string;
    readonly categoryName: string;
    readonly note: string;
    readonly tags: readonly string[];
  }[];
  readonly categories: readonly {
    readonly id: string;
    readonly name: string;
    readonly type: number;
    readonly parentCategoryId: string | null;
  }[];
  readonly sampledTransactions: number;
  readonly totalTransactions: number;
  readonly truncated: boolean;
}

const ORGANIZATION_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          actionId: { type: 'string' },
          reason: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['actionId', 'reason', 'confidence'],
      },
    },
    reclassifications: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          transactionId: { type: 'string' },
          targetCategoryId: { type: 'string' },
          reason: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['transactionId', 'targetCategoryId', 'reason', 'confidence'],
      },
    },
    newCategories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          type: { type: 'number', enum: [0, 1] },
          parentCategoryId: { type: ['string', 'null'] },
          evidenceTransactionIds: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['name', 'type', 'parentCategoryId', 'evidenceTransactionIds', 'reason', 'confidence'],
      },
    },
  },
  required: ['suggestions', 'reclassifications', 'newCategories'],
};

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizedName(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
}

function actionId(kind: AiOrganizationActionKind, sourceId: string, targetId: string): string {
  return hashJson({ kind, sourceId, targetId }).slice(0, 24);
}

function boundedReason(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  return value.trim().slice(0, MAX_REASON_LENGTH);
}

function redactNote(note: string): string {
  return note
    .replace(/\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g, '[日期]')
    .replace(/\d{1,2}月\d{1,2}[日号]/g, '[日期]')
    .replace(/(?:尾号|卡号|账户)[\s:：-]*\d{2,}/g, '[账户]')
    .trim()
    .replace(/(?:\d[\d,.]*\s*(?:元|块|块钱|人民币|¥|￥|元钱))/gi, '[金额]')
    .replace(/\b\d{4,}\b/g, '[数字]')
    .slice(0, MAX_NOTE_PREVIEW);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AiOrganizationResponseInvalidError();
  }
  return value as Record<string, unknown>;
}

function parseArrayJson(raw: string): unknown[] | null {
  if (raw.trim() === '') return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function rewriteAllocations(
  raw: string,
  sourceId: string,
  targetId: string,
): { readonly value: string; readonly changed: boolean; readonly malformed: boolean } {
  const decoded = parseArrayJson(raw);
  if (decoded === null) return { value: raw, changed: false, malformed: true };
  const merged = new Map<string, number>();
  let changed = false;
  for (const item of decoded) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { value: raw, changed: false, malformed: true };
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record['categoryId'] !== 'string' ||
      typeof record['amountCents'] !== 'number' ||
      !Number.isSafeInteger(record['amountCents']) ||
      record['amountCents'] < 0
    ) {
      return { value: raw, changed: false, malformed: true };
    }
    const categoryId = record['categoryId'] === sourceId ? targetId : record['categoryId'];
    if (categoryId !== record['categoryId']) changed = true;
    if (merged.has(categoryId)) changed = true;
    merged.set(categoryId, (merged.get(categoryId) ?? 0) + record['amountCents']);
  }
  const value = JSON.stringify(
    [...merged.entries()].map(([categoryId, amountCents]) => ({ categoryId, amountCents })),
  );
  return { value, changed, malformed: false };
}

function rewriteModules(
  raw: string,
  sourceId: string,
  targetId: string,
): { readonly value: string; readonly changed: boolean; readonly malformed: boolean } {
  const decoded = parseArrayJson(raw);
  if (decoded === null) return { value: raw, changed: false, malformed: true };
  const merged = new Map<string, number>();
  let changed = false;
  for (const item of decoded) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { value: raw, changed: false, malformed: true };
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record['categoryId'] !== 'string' ||
      typeof record['ratio'] !== 'number' ||
      !Number.isFinite(record['ratio']) ||
      record['ratio'] <= 0
    ) {
      return { value: raw, changed: false, malformed: true };
    }
    const categoryId = record['categoryId'] === sourceId ? targetId : record['categoryId'];
    if (categoryId !== record['categoryId']) changed = true;
    if (merged.has(categoryId)) changed = true;
    merged.set(categoryId, (merged.get(categoryId) ?? 0) + record['ratio']);
  }
  const value = JSON.stringify(
    [...merged.entries()].map(([categoryId, ratio]) => ({ categoryId, ratio })),
  );
  return { value, changed, malformed: false };
}

function projectionIds(projection: AuditProjection): Record<string, string[]> {
  return {
    ...(projection.categories === undefined
      ? {}
      : { categories: projection.categories.map((row) => row.id) }),
    ...(projection.transactions === undefined
      ? {}
      : { transactions: projection.transactions.map((row) => row.id) }),
    ...(projection.budgetAllocations === undefined
      ? {}
      : { budgetAllocations: projection.budgetAllocations.map((row) => row.id) }),
    ...(projection.templates === undefined
      ? {}
      : { templates: projection.templates.map((row) => row.id) }),
    ...(projection.recurringRules === undefined
      ? {}
      : { recurringRules: projection.recurringRules.map((row) => row.id) }),
    ...(projection.pendingOccurrences === undefined
      ? {}
      : { pendingOccurrences: projection.pendingOccurrences.map((row) => row.id) }),
  };
}

function affectedCounts(projection: AuditProjection): {
  readonly transactions: number;
  readonly budgetAllocations: number;
  readonly templates: number;
  readonly recurringRules: number;
  readonly pendingOccurrences: number;
} {
  return {
    transactions: projection.transactions?.length ?? 0,
    budgetAllocations: projection.budgetAllocations?.length ?? 0,
    templates: projection.templates?.length ?? 0,
    recurringRules: projection.recurringRules?.length ?? 0,
    pendingOccurrences: projection.pendingOccurrences?.length ?? 0,
  };
}

function sampleIds(projection: AuditProjection): string[] {
  const ids = [
    ...(projection.transactions?.map((row) => row.id) ?? []),
    ...(projection.budgetAllocations?.map((row) => row.id) ?? []),
    ...(projection.templates?.map((row) => row.id) ?? []),
    ...(projection.recurringRules?.map((row) => row.id) ?? []),
    ...(projection.pendingOccurrences?.map((row) => row.id) ?? []),
  ];
  return [...new Set(ids)].slice(0, MAX_SAMPLE_IDS);
}

function summary(plan: ActionPlan): AiOrganizationAction {
  return {
    actionId: plan.actionId,
    kind: plan.kind,
    sourceId: plan.sourceId,
    sourceName: plan.sourceName,
    targetId: plan.targetId,
    targetName: plan.targetName,
    status: plan.status,
    blockers: plan.blockers,
    affected: plan.affected,
    sampleRowIds: plan.sampleRowIds,
    reason: plan.reason,
    confidence: plan.confidence,
  };
}

function parseAuditProjection(raw: string): AuditProjection {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('not an object');
    }
    return value as AuditProjection;
  } catch {
    throw new AiOrganizationConflictError('整理审计记录已损坏，无法安全撤销。');
  }
}

export interface AiOrganizationServiceOptions {
  readonly now?: () => number;
}

export class AiOrganizationService {
  private readonly now: () => number;

  constructor(
    private readonly db: Db,
    private readonly config: AiConfigService,
    private readonly provider: AiProviderService,
    options: AiOrganizationServiceOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  private loadTransactions(): TransactionTagRow[] {
    return this.db
      .prepare('SELECT id, tags_json, category_id, deleted FROM transactions ORDER BY id')
      .all() as TransactionTagRow[];
  }

  private loadSemanticTransactions(): {
    readonly rows: SemanticTransactionRow[];
    readonly total: number;
  } {
    const total = (
      this.db.prepare('SELECT COUNT(*) AS count FROM transactions WHERE deleted = 0').get() as {
        count: number;
      }
    ).count;
    const rows = this.db
      .prepare(
        `SELECT id, type, category_id, note, tags_json
           FROM transactions
          WHERE deleted = 0
          ORDER BY date DESC, updated_at DESC, id
          LIMIT ?`,
      )
      .all(MAX_SEMANTIC_TRANSACTIONS) as SemanticTransactionRow[];
    return { rows, total };
  }

  private loadCategories(): CategoryRow[] {
    return this.db
      .prepare(
        'SELECT id, name, type, parent_id, is_builtin, deleted FROM categories WHERE deleted = 0 ORDER BY id',
      )
      .all() as CategoryRow[];
  }

  private loadUsage(): Map<string, number> {
    const rows = this.db
      .prepare(
        'SELECT category_id, COUNT(*) AS count FROM transactions WHERE deleted = 0 GROUP BY category_id',
      )
      .all() as { category_id: string; count: number }[];
    return new Map(rows.map((row) => [row.category_id, row.count]));
  }

  private loadJsonRows(table: 'budget_allocations' | 'budget_templates'): JsonRow[] {
    const column = table === 'budget_allocations' ? 'allocations_json' : 'modules_json';
    return this.db
      .prepare(`SELECT id, ${column} AS value FROM ${table} ORDER BY id`)
      .all() as JsonRow[];
  }

  private loadRecurringRules(): RefRow[] {
    return this.db
      .prepare('SELECT id, category_id FROM recurring_rules WHERE deleted = 0 ORDER BY id')
      .all() as RefRow[];
  }

  private loadPendingOccurrences(): RefRow[] {
    return this.db
      .prepare(
        "SELECT id, category_id FROM recurring_occurrences WHERE deleted = 0 AND status = 'pending' ORDER BY id",
      )
      .all() as RefRow[];
  }

  private buildTagPlans(rows: readonly TransactionTagRow[]): ActionPlan[] {
    const liveCounts = new Map<string, Map<string, number>>();
    for (const row of rows) {
      if (row.deleted === 1) continue;
      for (const tag of parseTagsJson(row.tags_json)) {
        const key = normalizedName(tag);
        const names = liveCounts.get(key) ?? new Map<string, number>();
        names.set(tag, (names.get(tag) ?? 0) + 1);
        liveCounts.set(key, names);
      }
    }

    const plans: ActionPlan[] = [];
    for (const names of liveCounts.values()) {
      if (names.size < 2) continue;
      const ordered = [...names.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
      );
      const target = ordered[0]?.[0];
      if (target === undefined) continue;
      for (const [source, count] of ordered.slice(1)) {
        const beforeRows: TransactionState[] = [];
        const afterRows: TransactionState[] = [];
        for (const row of rows) {
          const tags = parseTagsJson(row.tags_json);
          if (!tags.includes(source)) continue;
          const next = normaliseTags(tags.map((tag) => (tag === source ? target : tag)));
          beforeRows.push({ id: row.id, tagsJson: row.tags_json });
          afterRows.push({ id: row.id, tagsJson: serialiseTags(next) });
        }
        const before: AuditProjection = { transactions: beforeRows };
        const after: AuditProjection = { transactions: afterRows };
        const id = actionId('tag-merge', source, target);
        plans.push({
          actionId: id,
          kind: 'tag-merge',
          sourceId: source,
          sourceName: source,
          targetId: target,
          targetName: target,
          status: 'ready',
          blockers: [],
          affected: affectedCounts(before),
          sampleRowIds: sampleIds(before),
          reason: `规范化后「${source}」与「${target}」属于同一标签，预计合并 ${count} 笔可见账单。`,
          confidence: 1,
          before,
          after,
        });
      }
    }
    return plans;
  }

  private buildCategoryPlans(
    categories: readonly CategoryRow[],
    transactions: readonly TransactionTagRow[],
    allocations: readonly JsonRow[],
    templates: readonly JsonRow[],
    recurringRules: readonly RefRow[],
    pendingOccurrences: readonly RefRow[],
    usage: ReadonlyMap<string, number>,
  ): ActionPlan[] {
    const liveChildren = new Set(
      categories
        .filter((category) => category.parent_id !== null)
        .map((category) => category.parent_id as string),
    );
    const groups = new Map<string, CategoryRow[]>();
    for (const category of categories) {
      if (liveChildren.has(category.id)) continue;
      const key = `${category.type}|${category.parent_id ?? ''}|${normalizedName(category.name)}`;
      const group = groups.get(key) ?? [];
      group.push(category);
      groups.set(key, group);
    }

    const plans: ActionPlan[] = [];
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const ordered = [...group].sort(
        (a, b) =>
          b.is_builtin - a.is_builtin ||
          (usage.get(b.id) ?? 0) - (usage.get(a.id) ?? 0) ||
          a.name.localeCompare(b.name) ||
          a.id.localeCompare(b.id),
      );
      const target = ordered[0];
      if (target === undefined) continue;
      for (const source of ordered.slice(1)) {
        const blockers: string[] = [];
        if (source.is_builtin === 1) blockers.push('内建分类不能作为被合并分类。');

        const transactionBefore: TransactionState[] = transactions
          .filter((row) => row.category_id === source.id)
          .map((row) => ({ id: row.id, categoryId: row.category_id }));
        const transactionAfter = transactionBefore.map((row) => ({
          id: row.id,
          categoryId: target.id,
        }));

        const allocationBefore: JsonState[] = [];
        const allocationAfter: JsonState[] = [];
        for (const row of allocations) {
          const rewritten = rewriteAllocations(row.value, source.id, target.id);
          if (rewritten.malformed) {
            blockers.push('存在无法安全解析的预算分配快照。');
            continue;
          }
          if (rewritten.changed) {
            allocationBefore.push({ id: row.id, value: row.value });
            allocationAfter.push({ id: row.id, value: rewritten.value });
          }
        }

        const templateBefore: JsonState[] = [];
        const templateAfter: JsonState[] = [];
        for (const row of templates) {
          const rewritten = rewriteModules(row.value, source.id, target.id);
          if (rewritten.malformed) {
            blockers.push('存在无法安全解析的预算模板。');
            continue;
          }
          if (rewritten.changed) {
            templateBefore.push({ id: row.id, value: row.value });
            templateAfter.push({ id: row.id, value: rewritten.value });
          }
        }

        const ruleBefore = recurringRules
          .filter((row) => row.category_id === source.id)
          .map((row) => ({ id: row.id, categoryId: row.category_id }));
        const ruleAfter = ruleBefore.map((row) => ({ id: row.id, categoryId: target.id }));
        const pendingBefore = pendingOccurrences
          .filter((row) => row.category_id === source.id)
          .map((row) => ({ id: row.id, categoryId: row.category_id }));
        const pendingAfter = pendingBefore.map((row) => ({ id: row.id, categoryId: target.id }));

        const before: AuditProjection = {
          categories: [{ id: source.id, deleted: source.deleted, parentId: source.parent_id }],
          transactions: transactionBefore,
          budgetAllocations: allocationBefore,
          templates: templateBefore,
          recurringRules: ruleBefore,
          pendingOccurrences: pendingBefore,
        };
        const after: AuditProjection = {
          categories: [{ id: source.id, deleted: 1, parentId: null }],
          transactions: transactionAfter,
          budgetAllocations: allocationAfter,
          templates: templateAfter,
          recurringRules: ruleAfter,
          pendingOccurrences: pendingAfter,
        };
        const uniqueBlockers = [...new Set(blockers)];
        const id = actionId('category-merge', source.id, target.id);
        plans.push({
          actionId: id,
          kind: 'category-merge',
          sourceId: source.id,
          sourceName: source.name,
          targetId: target.id,
          targetName: target.name,
          status: uniqueBlockers.length === 0 ? 'ready' : 'blocked',
          blockers: uniqueBlockers,
          affected: affectedCounts(before),
          sampleRowIds: sampleIds(before),
          reason:
            uniqueBlockers.length === 0
              ? `「${source.name}」与「${target.name}」同类型同父级，可合并其引用。`
              : `「${source.name}」暂不能安全合并。`,
          confidence: uniqueBlockers.length === 0 ? 0.98 : 0,
          before,
          after,
        });
      }
    }
    return plans;
  }

  private analyze(): ActionPlan[] {
    const transactions = this.loadTransactions();
    const categories = this.loadCategories();
    return [
      ...this.buildTagPlans(transactions),
      ...this.buildCategoryPlans(
        categories,
        transactions,
        this.loadJsonRows('budget_allocations'),
        this.loadJsonRows('budget_templates'),
        this.loadRecurringRules(),
        this.loadPendingOccurrences(),
        this.loadUsage(),
      ),
    ].sort((a, b) => a.kind.localeCompare(b.kind) || a.actionId.localeCompare(b.actionId));
  }

  private previewHash(plans: readonly ActionPlan[]): string {
    return hashJson(
      plans.map((plan) => ({
        action: summary(plan),
        before: plan.before,
        after: plan.after,
      })),
    );
  }

  private facts(plans: readonly ActionPlan[]): OrganizationFacts {
    return { actions: plans.map((plan) => summary(plan)) };
  }

  private semanticFacts(): SemanticFacts {
    const loaded = this.loadSemanticTransactions();
    const categories = this.loadCategories();
    const children = new Set(
      categories
        .filter((category) => category.parent_id !== null)
        .map((category) => category.parent_id as string),
    );
    const categoryNames = new Map(categories.map((category) => [category.id, category.name]));
    return {
      transactions: loaded.rows.map((row) => ({
        transactionId: row.id,
        type: row.type,
        categoryId: row.category_id,
        categoryName: categoryNames.get(row.category_id) ?? row.category_id,
        note: redactNote(row.note),
        tags: parseTagsJson(row.tags_json),
      })),
      categories: categories
        .filter((category) => !children.has(category.id))
        .map((category) => ({
          id: category.id,
          name: category.name,
          type: category.type,
          parentCategoryId: category.parent_id,
        })),
      sampledTransactions: loaded.rows.length,
      totalTransactions: loaded.total,
      truncated: loaded.total > loaded.rows.length,
    };
  }

  private normalizeSemanticRecommendations(
    record: Record<string, unknown>,
    facts: SemanticFacts,
  ): AiOrganizationRecommendation[] {
    const transactions = new Map(facts.transactions.map((item) => [item.transactionId, item]));
    const categories = new Map(facts.categories.map((item) => [item.id, item]));
    const recommendations: AiOrganizationRecommendation[] = [];
    const seen = new Set<string>();
    const reclassifications = record['reclassifications'];
    if (Array.isArray(reclassifications)) {
      for (const item of reclassifications.slice(0, 100)) {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
        const value = item as Record<string, unknown>;
        const transactionId = value['transactionId'];
        const targetCategoryId = value['targetCategoryId'];
        if (typeof transactionId !== 'string' || typeof targetCategoryId !== 'string') continue;
        const transaction = transactions.get(transactionId);
        const target = categories.get(targetCategoryId);
        if (transaction === undefined || target === undefined) continue;
        if (target.type !== transaction.type || target.id === transaction.categoryId) continue;
        const recommendationId = hashJson({
          kind: 'transaction-reclassify',
          transactionId,
          targetCategoryId,
        }).slice(0, 24);
        if (seen.has(recommendationId)) continue;
        seen.add(recommendationId);
        const confidence =
          typeof value['confidence'] === 'number' && Number.isFinite(value['confidence'])
            ? Math.min(Math.max(value['confidence'], 0), 1)
            : 0;
        recommendations.push({
          recommendationId,
          kind: 'transaction-reclassify',
          transactionId,
          notePreview: transaction.note || null,
          sourceCategoryId: transaction.categoryId,
          sourceCategoryName: transaction.categoryName,
          targetCategoryId: target.id,
          targetCategoryName: target.name,
          proposedCategoryName: null,
          proposedCategoryType: null,
          proposedParentCategoryId: null,
          evidenceTransactionIds: [transactionId],
          reason: boundedReason(value['reason'], '这笔账可能属于更合适的现有分类。'),
          confidence,
        });
      }
    }

    const newCategories = record['newCategories'];
    if (Array.isArray(newCategories)) {
      for (const item of newCategories.slice(0, 20)) {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
        const value = item as Record<string, unknown>;
        const rawName = value['name'];
        const rawType = value['type'];
        if (typeof rawName !== 'string' || (rawType !== 0 && rawType !== 1)) continue;
        const name = rawName.trim().slice(0, 32);
        if (name === '') continue;
        const parentRaw = value['parentCategoryId'];
        const parent = parentRaw === null || parentRaw === undefined ? null : categories.get(parentRaw as string);
        if (parentRaw !== null && parentRaw !== undefined && parent === undefined) continue;
        if (
          parent !== null &&
          parent !== undefined &&
          (rawType !== 0 || parent.type !== 0 || parent.parentCategoryId !== null)
        ) {
          continue;
        }
        if (
          facts.categories.some(
            (category) =>
              category.type === rawType &&
              category.parentCategoryId === (parent?.id ?? null) &&
              normalizedName(category.name) === normalizedName(name),
          )
        ) {
          continue;
        }
        const evidence = Array.isArray(value['evidenceTransactionIds'])
          ? value['evidenceTransactionIds']
              .filter((id): id is string => typeof id === 'string' && transactions.has(id))
              .slice(0, 5)
          : [];
        if (evidence.length === 0) continue;
        const recommendationId = hashJson({
          kind: 'category-suggestion',
          name: normalizedName(name),
          type: rawType,
          parentCategoryId: parent?.id ?? null,
        }).slice(0, 24);
        if (seen.has(recommendationId)) continue;
        seen.add(recommendationId);
        const confidence =
          typeof value['confidence'] === 'number' && Number.isFinite(value['confidence'])
            ? Math.min(Math.max(value['confidence'], 0), 1)
            : 0;
        recommendations.push({
          recommendationId,
          kind: 'category-suggestion',
          transactionId: null,
          notePreview: null,
          sourceCategoryId: null,
          sourceCategoryName: null,
          targetCategoryId: null,
          targetCategoryName: null,
          proposedCategoryName: name,
          proposedCategoryType: rawType,
          proposedParentCategoryId: parent?.id ?? null,
          evidenceTransactionIds: evidence,
          reason: boundedReason(value['reason'], '这些账单可能适合一个新的分类。'),
          confidence,
        });
      }
    }
    return recommendations.sort((a, b) => b.confidence - a.confidence);
  }

  private async explain(
    plans: readonly ActionPlan[],
    semantic: SemanticFacts,
  ): Promise<{
    readonly plans: readonly ActionPlan[];
    readonly recommendations: readonly AiOrganizationRecommendation[];
    readonly semanticAvailable: boolean;
  }> {
    if (semantic.totalTransactions === 0) {
      return { plans: [...plans], recommendations: [], semanticAvailable: true };
    }
    let stored;
    try {
      stored = this.config.getStoredOrThrow();
    } catch (error) {
      if (error instanceof AiError) {
        return { plans: [...plans], recommendations: [], semanticAvailable: false };
      }
      throw error;
    }
    let raw: unknown;
    try {
      raw = await this.provider.complete(stored, this.config.getSecretOrThrow(stored), {
        input: '请分析这些账单是否需要调整现有分类，并提出必要的新分类建议。',
        categories: [],
        accounts: [],
        model: stored.model,
        today: new Date(this.now()).toISOString().slice(0, 10),
        responseSchema: ORGANIZATION_RESPONSE_SCHEMA,
        feature: 'organization',
        facts: { actions: this.facts(plans).actions, semantic },
      });
    } catch (error) {
      if (error instanceof AiError) {
        return { plans: [...plans], recommendations: [], semanticAvailable: false };
      }
      throw error;
    }

    try {
      const record = asRecord(raw);
      const suggestions = record['suggestions'];
      if (!Array.isArray(suggestions)) throw new AiOrganizationResponseInvalidError();
      const ready = plans.filter((plan) => plan.status === 'ready');
      const known = new Map(ready.map((plan) => [plan.actionId, plan]));
      const explained = new Map<string, { reason: string; confidence: number }>();
      for (const item of suggestions) {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
        const value = item as Record<string, unknown>;
        const id = value['actionId'];
        if (typeof id !== 'string' || !known.has(id)) continue;
        const confidence =
          typeof value['confidence'] === 'number' && Number.isFinite(value['confidence'])
            ? Math.min(Math.max(value['confidence'], 0), 1)
            : 0;
        explained.set(id, {
          reason: boundedReason(value['reason'], known.get(id)?.reason ?? '服务端建议动作。'),
          confidence,
        });
      }
      const explainedPlans = [...plans]
        .map((plan) => {
          const explanation = explained.get(plan.actionId);
          return explanation === undefined
            ? plan
            : { ...plan, reason: explanation.reason, confidence: explanation.confidence };
        })
        .sort((a, b) => {
          if (a.status !== b.status) return a.status === 'ready' ? -1 : 1;
          return b.confidence - a.confidence || a.actionId.localeCompare(b.actionId);
        });
      return {
        plans: explainedPlans,
        recommendations: this.normalizeSemanticRecommendations(record, semantic),
        semanticAvailable: true,
      };
    } catch (error) {
      if (error instanceof AiOrganizationResponseInvalidError) {
        return { plans: [...plans], recommendations: [], semanticAvailable: false };
      }
      throw error;
    }
  }

  async preview(options: { readonly explain?: boolean } = {}): Promise<AiOrganizationPreview> {
    const plans = this.analyze();
    const semantic = this.semanticFacts();
    const explained = options.explain === false ? { plans, semanticAvailable: false, recommendations: [] } : await this.explain(plans, semantic);
    return {
      previewHash: this.previewHash(plans),
      generatedAt: this.now(),
      actions: explained.plans.map(summary),
      scope: {
        sampledTransactions: semantic.sampledTransactions,
        totalTransactions: semantic.totalTransactions,
        truncated: semantic.truncated,
      },
      semanticAvailable: explained.semanticAvailable,
      recommendations: explained.recommendations,
    };
  }

  private assertProjection(
    projection: AuditProjection,
    direction: 'before' | 'after',
  ): void {
    const categoryRows = projection.categories ?? [];
    for (const expected of categoryRows) {
      const current = this.db
        .prepare('SELECT deleted, parent_id FROM categories WHERE id = ?')
        .get(expected.id) as { deleted: number; parent_id: string | null } | undefined;
      if (
        current === undefined ||
        current.deleted !== expected.deleted ||
        current.parent_id !== expected.parentId
      ) {
        throw new AiOrganizationConflictError(
          direction === 'before' ? '整理预览已过期，请重新扫描。' : '整理后的分类已被其他操作修改，无法撤销。',
        );
      }
    }
    for (const row of projection.transactions ?? []) {
      const current = this.db
        .prepare('SELECT category_id, tags_json FROM transactions WHERE id = ?')
        .get(row.id) as { category_id: string; tags_json: string } | undefined;
      if (current === undefined) throw new AiOrganizationConflictError('整理涉及的账单已不存在。');
      if (row.categoryId !== undefined && current.category_id !== row.categoryId) {
        throw new AiOrganizationConflictError('整理涉及的账单已被其他操作修改，无法继续。');
      }
      if (row.tagsJson !== undefined && current.tags_json !== row.tagsJson) {
        throw new AiOrganizationConflictError('整理涉及的标签已被其他操作修改，无法继续。');
      }
    }
    for (const row of projection.budgetAllocations ?? []) {
      const current = this.db
        .prepare('SELECT allocations_json AS value FROM budget_allocations WHERE id = ?')
        .get(row.id) as { value: string } | undefined;
      if (current?.value !== row.value) throw new AiOrganizationConflictError('预算快照已被修改，无法继续。');
    }
    for (const row of projection.templates ?? []) {
      const current = this.db
        .prepare('SELECT modules_json AS value FROM budget_templates WHERE id = ?')
        .get(row.id) as { value: string } | undefined;
      if (current?.value !== row.value) throw new AiOrganizationConflictError('预算模板已被修改，无法继续。');
    }
    for (const row of [...(projection.recurringRules ?? []), ...(projection.pendingOccurrences ?? [])]) {
      const table = (projection.recurringRules ?? []).some((item) => item.id === row.id)
        ? 'recurring_rules'
        : 'recurring_occurrences';
      const current = this.db
        .prepare(`SELECT category_id FROM ${table} WHERE id = ?`)
        .get(row.id) as { category_id: string } | undefined;
      if (current?.category_id !== row.categoryId) {
        throw new AiOrganizationConflictError('周期账单引用已被修改，无法继续。');
      }
    }
  }

  private applyProjection(projection: AuditProjection, at: number): void {
    for (const row of projection.transactions ?? []) {
      if (row.categoryId !== undefined) {
        this.db
          .prepare('UPDATE transactions SET category_id = ?, updated_at = ? WHERE id = ?')
          .run(row.categoryId, at, row.id);
      }
      if (row.tagsJson !== undefined) {
        const catalog = new TagCatalogService(this.db, () => at);
        for (const name of parseTagsJson(row.tagsJson)) catalog.ensureTag(this.db, name, at);
        this.db
          .prepare('UPDATE transactions SET tags_json = ?, updated_at = ? WHERE id = ?')
          .run(row.tagsJson, at, row.id);
      }
    }
    for (const row of projection.budgetAllocations ?? []) {
      this.db
        .prepare('UPDATE budget_allocations SET allocations_json = ?, updated_at = ? WHERE id = ?')
        .run(row.value, at, row.id);
    }
    for (const row of projection.templates ?? []) {
      this.db
        .prepare('UPDATE budget_templates SET modules_json = ?, updated_at = ? WHERE id = ?')
        .run(row.value, at, row.id);
    }
    for (const row of projection.recurringRules ?? []) {
      this.db
        .prepare('UPDATE recurring_rules SET category_id = ?, updated_at = ? WHERE id = ?')
        .run(row.categoryId, at, row.id);
    }
    for (const row of projection.pendingOccurrences ?? []) {
      this.db
        .prepare('UPDATE recurring_occurrences SET category_id = ?, updated_at = ? WHERE id = ?')
        .run(row.categoryId, at, row.id);
    }
    for (const row of projection.categories ?? []) {
      this.db
        .prepare('UPDATE categories SET deleted = ?, parent_id = ?, updated_at = ? WHERE id = ?')
        .run(row.deleted, row.parentId, at, row.id);
    }
  }

  private insertAudit(
    operationId: string,
    eventType: 'apply' | 'undo',
    plan: Pick<ActionPlan, 'actionId' | 'kind' | 'sourceId' | 'targetId'>,
    before: AuditProjection,
    after: AuditProjection,
    status: 'applied' | 'undone',
    at: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO ai_organization_audit
          (id, operation_id, event_type, action_id, kind, source_id, target_id,
           affected_row_ids_json, before_json, after_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        operationId,
        eventType,
        plan.actionId,
        plan.kind,
        plan.sourceId,
        plan.targetId,
        JSON.stringify(projectionIds(before)),
        JSON.stringify(before),
        JSON.stringify(after),
        status,
        at,
      );
  }

  apply(input: unknown): AiOrganizationOperationResult {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new AiOrganizationInputError('整理确认参数无效。');
    }
    const record = input as Record<string, unknown>;
    const previewHash = record['previewHash'];
    const actionIds = record['actionIds'];
    if (typeof previewHash !== 'string' || !Array.isArray(actionIds)) {
      throw new AiOrganizationInputError('需要 previewHash 和 actionIds。');
    }
    if (
      actionIds.length === 0 ||
      actionIds.length > MAX_SELECTED_ACTIONS ||
      actionIds.some((id) => typeof id !== 'string') ||
      new Set(actionIds).size !== actionIds.length
    ) {
      throw new AiOrganizationInputError('至少选择一个不重复的整理动作。');
    }
    const plans = this.analyze();
    if (this.previewHash(plans) !== previewHash) {
      throw new AiOrganizationConflictError('整理预览已过期，请重新扫描后再确认。');
    }
    const selected = plans.filter((plan) => actionIds.includes(plan.actionId));
    if (selected.length !== actionIds.length) {
      throw new AiOrganizationConflictError('整理动作已变化，请重新扫描。');
    }
    if (selected.some((plan) => plan.status !== 'ready')) {
      throw new AiOrganizationInputError('不能确认包含阻塞原因的整理动作。');
    }

    const operationId = randomUUID();
    const at = this.now();
    this.db.transaction(() => {
      for (const plan of selected) {
        this.assertProjection(plan.before, 'before');
        this.applyProjection(plan.after, at);
        this.insertAudit(operationId, 'apply', plan, plan.before, plan.after, 'applied', at);
      }
    })();
    return {
      operationId,
      status: 'applied',
      actions: selected.map((plan) => ({
        actionId: plan.actionId,
        kind: plan.kind,
        sourceId: plan.sourceId,
        targetId: plan.targetId,
        affectedRows: Object.values(projectionIds(plan.before)).reduce(
          (sum, ids) => sum + ids.length,
          0,
        ),
      })),
    };
  }

  private operationEvents(operationId: string): AuditRow[] {
    const rows = this.db
      .prepare('SELECT * FROM ai_organization_audit WHERE operation_id = ? ORDER BY created_at, id')
      .all(operationId) as AuditRow[];
    if (rows.length === 0) throw new AiOrganizationInputError('整理操作不存在。');
    return rows;
  }

  undo(operationId: unknown): AiOrganizationOperationResult {
    if (typeof operationId !== 'string' || operationId.trim() === '') {
      throw new AiOrganizationInputError('operationId 不能为空。');
    }
    const events = this.operationEvents(operationId);
    const latest = new Map<string, AuditRow>();
    for (const event of events) latest.set(event.action_id, event);
    const applyEvents = events.filter((event) => event.event_type === 'apply');
    if (applyEvents.length === 0 || [...latest.values()].some((event) => event.status === 'undone')) {
      throw new AiOrganizationConflictError('该整理操作已经撤销，不能重复撤销。');
    }
    const at = this.now();
    this.db.transaction(() => {
      for (const event of applyEvents) {
        const after = parseAuditProjection(event.after_json);
        const before = parseAuditProjection(event.before_json);
        this.assertProjection(after, 'after');
        const plan = {
          actionId: event.action_id,
          kind: event.kind,
          sourceId: event.source_id,
          targetId: event.target_id,
        } as const;
        this.applyProjection(before, at);
        this.insertAudit(operationId, 'undo', plan, after, before, 'undone', at);
      }
    })();
    return {
      operationId,
      status: 'undone',
      actions: applyEvents.map((event) => ({
        actionId: event.action_id,
        kind: event.kind,
        sourceId: event.source_id,
        targetId: event.target_id,
        affectedRows: Object.values(JSON.parse(event.affected_row_ids_json) as Record<string, string[]>).reduce(
          (sum, ids) => sum + ids.length,
          0,
        ),
      })),
    };
  }
}
