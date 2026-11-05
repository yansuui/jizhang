/**
 * Salary writes create one four-purpose grant in the same transaction as the salary
 * and keyed operation. Grant ratios are frozen; legacy allocation facts remain readable.
 * Legacy template/cycle methods below are retained for the separate P07 retirement.
 */
import { allocateSalaryCents, allocationPeriodStart, monthKey, allocateFundIncomeCents, validateFinancialRatiosBps, type FundRatiosBps, type FundAmounts } from '@jizhang/shared';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import {
  NotFoundError,
  ValidationError,
  assertAccountUsable,
  requireNonEmptyString,
} from './transaction-service.js';
import { TemplateService } from './template-service.js';
import { requireFinancialOperationId, runFinancialOperation } from './financial-operation-store.js';
import { requireLedgerDate, requirePositiveSafeIntegerCents } from './ledger-input-validation.js';
import { FinancialFundService } from './financial-fund-service.js';
import { fundGrantNeedsReview } from './financial-fund-store.js';
import { FinancialInvalidError, FinancialRevisionConflictError, FinancialSourceChangedError, FinancialUnavailableError } from './financial-errors.js';
import { salarySourceToken } from './financial-planning-types.js';

/** `settings` key holding the optional budget cycle start day. */
export const CYCLE_START_DAY_KEY = 'budget.cycle_start_day';

/**
 * 重放作用域里这次写操作的资源名。
 *
 * 与路由字符串一致,但它是**服务层的常量**:指纹的一部分,改动它会作废旧 key。
 */
export const SALARY_CREATE_RESOURCE = '/api/v1/salaries';

class SalaryLegacyRetiredError extends Error {
  readonly statusCode = 410;
  readonly code = 'FEATURE_RETIRED';
  constructor() { super('Legacy salary allocation writes are retired.'); }
}

/** Allowed range for the configurable cycle start day (T6 PRD R5). */
export const MIN_CYCLE_START_DAY = 1;
export const MAX_CYCLE_START_DAY = 28;

interface SalaryRow {
  readonly id: string;
  readonly amount_cents: number;
  readonly date: number;
  readonly note: string;
  readonly account_id: string;
  readonly deleted: number;
  readonly updated_at: number;
}

interface AllocationRow {
  readonly id: string;
  readonly salary_record_id: string;
  readonly date: number;
  readonly allocations_json: string;
  readonly deleted: number;
  readonly updated_at: number;
}

export interface AllocationItemDto {
  readonly categoryId: string;
  readonly amountCents: number;
}

export interface SalaryDto {
  readonly id: string;
  readonly amountCents: number;
  readonly date: number;
  readonly note: string;
  /** The account that received the money. Required: a salary with nowhere to land cannot
   * take part in a balance. */
  readonly accountId: string;
  readonly updatedAt: number;
}

export interface SalaryDetailDto extends SalaryDto {
  readonly allocationId: string | null;
  readonly allocations: AllocationItemDto[];
  readonly fundGrant?: { readonly grantId: string; readonly revision: number; readonly status: string; readonly sourceAmountCents: number; readonly ratiosBps: FundRatiosBps; readonly targets: FundAmounts };
}

interface ParsedAllocationItem {
  readonly categoryId: string;
  readonly amountCents: number;
}

/** Tolerant reader for `allocations_json`; malformed input yields `[]`. */
export function parseAllocationsJson(raw: unknown): ParsedAllocationItem[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const decoded: unknown = JSON.parse(raw);
    if (!Array.isArray(decoded)) return [];
    const out: ParsedAllocationItem[] = [];
    for (const item of decoded) {
      if (typeof item !== 'object' || item === null) continue;
      const record = item as Record<string, unknown>;
      const categoryId = record['categoryId'];
      const amountCents = record['amountCents'];
      if (typeof categoryId !== 'string' || categoryId.trim() === '') continue;
      if (typeof amountCents !== 'number' || !Number.isInteger(amountCents)) continue;
      out.push({ categoryId, amountCents });
    }
    return out;
  } catch {
    return [];
  }
}

export interface SalaryServiceOptions {
  readonly now?: () => number;
  readonly serverTimeZone?: string | undefined;
  /**
   * 重放作用域里的操作者。
   *
   * 这个应用是单用户的,操作者就是库里唯一的 `users` 行;测试可以注入固定值,
   * 免得为了一个幂等键去建用户。与 `transaction-service` 的取值方式保持一致。
   */
  readonly actorId?: string | undefined;
}

export interface CreateSalaryInput {
  readonly contractVersion?: unknown;
  readonly expectedFundConfigRevision?: unknown;
  readonly amountCents?: unknown;
  readonly date?: unknown;
  readonly note?: unknown;
  readonly accountId?: unknown;
  readonly templateId?: unknown;
  readonly allocations?: unknown;
  /**
   * 可选的幂等键( UUID )。
   *
   * 旧客户端不带这个字段不能安全恢复未知结果,因此不再接受新建。
   * 新客户端在**第一次尝试**前生成它,重发同一个 key 只会拿回原来那笔工资,
   * 不会多记一次收入。
   */
  readonly operationId?: unknown;
}

/** 一次写入的调用上下文(当前只有重放作用域需要的操作者)。 */
export interface SalaryCreateContext {
  readonly actorId?: string | undefined;
}

export class SalaryService {
  private readonly db: Db;
  private readonly now: () => number;
  private readonly templates: TemplateService;
  private readonly actorIdOption: string | undefined;
  private readonly serverTimeZone: string | undefined;

  constructor(db: Db, options: SalaryServiceOptions = {}) {
    this.db = db;
    this.now = options.now ?? (() => Date.now());
    this.templates = new TemplateService(db, options);
    this.actorIdOption = options.actorId;
    this.serverTimeZone = options.serverTimeZone;
  }

  /**
   * 重放作用域里的操作者 id。
   *
   * 单用户应用:`users` 表只有一行。注入值时优先用注入值(测试确定性)。
   */
  private resolveActorId(): string {
    if (this.actorIdOption !== undefined && this.actorIdOption !== '') return this.actorIdOption;
    const row = this.db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get() as
      | { id: string }
      | undefined;
    if (row === undefined) {
      // 没有用户 = 没有可归属的操作者。绝不能退化成"全局共享 key":
      // 那会让不同实例的重放互相串台。
      throw new ValidationError('Cannot record a salary before the account exists.');
    }
    return row.id;
  }

  /** Validates a prospective salary and resolves its allocation without inserting rows. */
  prepareCreate(input: CreateSalaryInput): {
    readonly amountCents: number;
    readonly date: number;
    readonly note: string;
    readonly accountId: string;
    readonly templateId?: string;
    readonly allocations: AllocationItemDto[];
  } {
    const amountCents = requirePositiveSafeIntegerCents(input.amountCents);
    const date = requireLedgerDate(input.date, () => this.now());
    const note = typeof input.note === 'string' ? input.note : '';
    const accountId = requireNonEmptyString(input.accountId, 'accountId');
    assertAccountUsable(this.db, accountId);
    const templateId = typeof input.templateId === 'string' && input.templateId.trim() !== ''
      ? input.templateId.trim()
      : undefined;
    const allocations = this.resolveAllocations(input.allocations, amountCents, templateId);
    return {
      amountCents,
      date,
      note,
      accountId,
      ...(templateId === undefined ? {} : { templateId }),
      allocations,
    };
  }

  toDto(row: SalaryRow): SalaryDto {
    return {
      id: row.id,
      amountCents: row.amount_cents,
      date: row.date,
      note: row.note,
      accountId: row.account_id,
      updatedAt: row.updated_at,
    };
  }

  /** Read-only access to the allocation table, used by tests and diagnostics. */
  getAllocationRow(salaryId: string): AllocationRow | undefined {
    return this.db
      .prepare('SELECT * FROM budget_allocations WHERE salary_record_id = ?')
      .get(salaryId) as AllocationRow | undefined;
  }

  getById(id: string): SalaryDetailDto | undefined {
    const row = this.db
      .prepare('SELECT * FROM salary_records WHERE id = ? AND deleted = 0')
      .get(id) as SalaryRow | undefined;
    if (row === undefined) return undefined;

    const allocation = this.getAllocationRow(id);
    const fundGrant = this.getFundGrant(id);
    return {
      ...this.toDto(row),
      ...(fundGrant === undefined ? {} : { fundGrant }),
      allocationId: allocation !== undefined && allocation.deleted === 0 ? allocation.id : null,
      allocations:
        allocation !== undefined && allocation.deleted === 0
          ? parseAllocationsJson(allocation.allocations_json)
          : [],
    };
  }

  getByIdOrThrow(id: string): SalaryDetailDto {
    const found = this.getById(id);
    if (found === undefined) throw new NotFoundError('Salary record not found.');
    return found;
  }

  list(limit = 200, offset = 0): SalaryDto[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM salary_records WHERE deleted = 0 ORDER BY date DESC, updated_at DESC, id LIMIT ? OFFSET ?',
      )
      .all(limit, offset) as SalaryRow[];
    return rows.map((row) => this.toDto(row));
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM salary_records WHERE deleted = 0').get() as { n: number }).n;
  }

  /**
   * Live salary records inside `[from, to)`, for income aggregation.
   *
   * Windowed rather than reusing `list()`: that one applies `LIMIT 200`, so summing
   * its output over a long chart range would silently truncate history and under-report
   * income.
   */
  listInWindow(from: number, to: number): { amountCents: number; date: number }[] {
    const rows = this.db
      .prepare(
        `SELECT amount_cents, date
           FROM salary_records
          WHERE deleted = 0 AND date >= ? AND date < ?
          ORDER BY date`,
      )
      .all(from, to) as { amount_cents: number; date: number }[];

    return rows.map((row) => ({ amountCents: row.amount_cents, date: row.date }));
  }

  /**
   * Records a salary and a frozen four-purpose grant, or replays a prior result.
   *
   * @param input.operationId required for new writes; an identical retry returns the
   *   ORIGINAL salary instead of recording a second one.
   * @param context.actorId who the replay record belongs to (route supplies the session user).
   */
  create(input: CreateSalaryInput, context: SalaryCreateContext = {}): SalaryDetailDto {
    const operationId =
      input.operationId === undefined || input.operationId === null
        ? undefined
        : requireFinancialOperationId(input.operationId);

    // An unkeyed legacy request may be a lost-response retry. Never post it again.
    if (operationId === undefined) {
      if (input.contractVersion !== 1) throw new SalaryLegacyRetiredError();
      throw new FinancialInvalidError('A keyed version 1 salary request is required.');
    }

    // The key MUST be handled before `prepareCreate`: on a retry the template may have
    // been edited or deleted since the first attempt, and failing here would turn
    // "this already succeeded" into a 400 — the one path idempotency exists for.
    const result = runFinancialOperation<SalaryDetailDto>(
      this.db,
      {
        operationId,
        actorId: context.actorId ?? this.resolveActorId(),
        method: 'POST',
        resource: SALARY_CREATE_RESOURCE,
        // Keep the old fingerprint byte-compatible for historical replay. Version 1
        // fingerprints the complete request and rejects unknown fields on fresh writes.
        canonicalPayload: input.contractVersion === 1 ? input : {
          amountCents: input.amountCents,
          date: input.date,
          note: input.note,
          accountId: input.accountId,
          templateId: input.templateId,
          allocations: input.allocations,
        },
        now: this.now(),
      },
      () => {
        if (input.contractVersion !== 1) {
          throw new SalaryLegacyRetiredError();
        }
        return { statusCode: 201, response: this.createFundSalary(input, context.actorId ?? this.resolveActorId(), operationId) };
      },
    );
    return result.response;
  }

  private getFundGrant(salaryId: string): SalaryDetailDto['fundGrant'] {
    const row = this.db.prepare(`SELECT g.id,g.active_revision,g.status,r.source_amount_cents,r.ratios_json,r.targets_json
      FROM financial_fund_grant_sources s JOIN financial_fund_grants g ON g.id=s.grant_id
      JOIN financial_fund_grant_revisions r ON r.grant_id=g.id AND r.revision=g.active_revision
      WHERE s.salary_id=?`).get(salaryId) as { id: string; active_revision: number; status: string; source_amount_cents: number; ratios_json: string; targets_json: string } | undefined;
    if (row === undefined) return undefined;
    try {
      const ratiosBps = validateFinancialRatiosBps(JSON.parse(row.ratios_json));
      const targets = JSON.parse(row.targets_json) as FundAmounts;
      const expected = allocateFundIncomeCents(row.source_amount_cents, ratiosBps);
      if (Object.keys(expected).some((key) => targets[key as keyof FundAmounts] !== expected[key as keyof FundAmounts])) throw new Error('Invalid targets');
      return { grantId: row.id, revision: row.active_revision, status: fundGrantNeedsReview(this.db, row.id) ? 'review-required' : row.status, sourceAmountCents: row.source_amount_cents, ratiosBps, targets };
    } catch { throw new FinancialUnavailableError(); }
  }

  /** Called inside the operation's IMMEDIATE transaction. */
  private createFundSalary(input: CreateSalaryInput, actorId: string, operationId: string): SalaryDetailDto {
    if (Object.keys(input).some((key) => !['contractVersion', 'expectedFundConfigRevision', 'operationId', 'amountCents', 'date', 'note', 'accountId'].includes(key))) throw new FinancialInvalidError('Unknown salary field.');
    if (!Number.isSafeInteger(input.expectedFundConfigRevision) || (input.expectedFundConfigRevision as number) < 0) throw new FinancialInvalidError('expectedFundConfigRevision is required.');
    const config = new FinancialFundService(this.db, { serverTimeZone: this.serverTimeZone }).getConfig().config;
    if (config.revision !== input.expectedFundConfigRevision) throw new FinancialRevisionConflictError('The fund configuration changed. Reload it before saving.');
    const amount = requirePositiveSafeIntegerCents(input.amountCents);
    const date = requireLedgerDate(input.date, this.now);
    const accountId = requireNonEmptyString(input.accountId, 'accountId');
    assertAccountUsable(this.db, accountId);
    if (input.note !== undefined && typeof input.note !== 'string') throw new ValidationError('note must be a string.');
    const id = randomUUID(); const grantId = `salary:${id}`; const now = this.now();
    this.db.prepare('INSERT INTO salary_records (id,amount_cents,date,note,account_id,deleted,updated_at) VALUES (?,?,?,?,?,0,?)').run(id, amount, date, input.note ?? '', accountId, now);
    this.db.prepare("INSERT INTO financial_fund_grants VALUES (?,'salary',?,1,'active')").run(grantId, id);
    const token = salarySourceToken({ id, amount_cents: amount, date, account_id: accountId });
    const sources = [{ salaryId: id, amountCents: amount, date, accountId, sourceToken: token, confirmedAt: now }];
    this.db.prepare('INSERT INTO financial_fund_grant_revisions VALUES (?,1,?,?,?,?,?,?,?,?)').run(grantId, amount, JSON.stringify(config.ratiosBps), JSON.stringify(allocateFundIncomeCents(amount, config.ratiosBps)), JSON.stringify(sources), actorId, operationId, now, 'salary-create');
    this.db.prepare("INSERT INTO financial_fund_grant_sources VALUES (?,?,?,?,?,?,'active')").run(id, grantId, token, amount, date, accountId);
    return this.getByIdOrThrow(id);
  }

  /**
   * Produces the allocation to snapshot.
   *
   * Fine-tuned values win, but must still add up to the salary — otherwise the
   * module budgets would not account for the whole pay cheque.
   */
  private resolveAllocations(
    raw: unknown,
    amountCents: number,
    templateId: string | undefined,
  ): ParsedAllocationItem[] {
    let items: ParsedAllocationItem[];

    if (raw !== undefined) {
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new ValidationError('allocations must be a non-empty list of module amounts.');
      }
      items = [];
      for (const entry of raw) {
        if (typeof entry !== 'object' || entry === null) {
          throw new ValidationError('Each allocation needs categoryId and amountCents.');
        }
        const record = entry as Record<string, unknown>;
        const categoryId = record['categoryId'];
        const amount = record['amountCents'];
        if (typeof categoryId !== 'string' || categoryId.trim() === '') {
          throw new ValidationError('Each allocation needs a categoryId.');
        }
        if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) {
          throw new ValidationError(
            `Allocation for ${categoryId} must be a non-negative integer number of cents.`,
          );
        }
        items.push({ categoryId: categoryId.trim(), amountCents: amount });
      }
    } else {
      const template =
        templateId === undefined ? this.templates.getDefault() : this.templates.getById(templateId);
      if (template === undefined) {
        throw new ValidationError(
          templateId === undefined
            ? 'No template is available to allocate this salary.'
            : `Unknown template: ${templateId}`,
        );
      }
      items = allocateSalaryCents(amountCents, template.modules);
    }

    const sum = items.reduce((total, item) => total + item.amountCents, 0);
    if (sum !== amountCents) {
      const difference = amountCents - sum;
      throw new ValidationError(
        difference > 0
          ? `Undistributed ${difference} cents — the allocation must add up to the salary.`
          : `The allocation exceeds the salary by ${-difference} cents.`,
      );
    }

    // Every referenced category must exist, so the budget page never has modules
    // it cannot name.
    for (const item of items) {
      const found = this.db
        .prepare('SELECT 1 AS x FROM categories WHERE id = ? AND deleted = 0')
        .get(item.categoryId) as { x: number } | undefined;
      if (found === undefined) {
        throw new ValidationError(`Unknown or deleted category: ${item.categoryId}`);
      }
    }

    return items;
  }

  /**
   * Salary and allocation are one accounting fact. Never accept a different
   * salary amount while leaving its old budget behind, and never silently
   * recompute a hand-tuned snapshot. The caller must supply a balanced allocation
   * alongside an amount change. A date change moves the snapshot in the same
   * transaction, otherwise income and budget would land in different cycles.
   */
  update(
    id: string,
    changes: {
      readonly amountCents?: unknown;
      readonly date?: unknown;
      readonly note?: unknown;
      readonly accountId?: unknown;
      readonly allocations?: unknown;
      readonly contractVersion?: unknown;
      readonly operationId?: unknown;
      readonly expectedGrantRevision?: unknown;
    },
    context: SalaryCreateContext = {},
  ): SalaryDetailDto {
    if (changes.contractVersion === 1) {
      const operationId = requireFinancialOperationId(changes.operationId);
      return runFinancialOperation(this.db, { operationId, actorId: context.actorId ?? this.resolveActorId(), method: 'PATCH', resource: `${SALARY_CREATE_RESOURCE}/${id}`, canonicalPayload: changes, now: this.now() }, () => ({ statusCode: 200, response: this.updateOnce(id, changes, true, context.actorId ?? this.resolveActorId(), operationId) })).response;
    }
    return this.updateOnce(id, changes, false);
  }

  private updateOnce(id: string, changes: { readonly amountCents?: unknown; readonly date?: unknown; readonly note?: unknown; readonly accountId?: unknown; readonly allocations?: unknown; readonly contractVersion?: unknown; readonly operationId?: unknown; readonly expectedGrantRevision?: unknown }, keyed: boolean, actorId?: string, operationId?: string): SalaryDetailDto {
    const current = this.getByIdOrThrow(id);
    if (current.fundGrant !== undefined && keyed) {
      if (!Number.isSafeInteger(changes.expectedGrantRevision) || (changes.expectedGrantRevision as number) < 1) throw new FinancialInvalidError('expectedGrantRevision is required.');
      if (current.fundGrant.revision !== changes.expectedGrantRevision) throw new FinancialRevisionConflictError('The salary grant changed. Reload it before saving.');
      if (Object.keys(changes).some((key) => !['contractVersion', 'operationId', 'expectedGrantRevision', 'amountCents', 'date', 'note', 'accountId'].includes(key))) throw new FinancialInvalidError('Unknown salary field.');
    }
    if (
      changes.amountCents === undefined &&
      changes.date === undefined &&
      changes.note === undefined &&
      changes.accountId === undefined &&
      changes.allocations === undefined
    )
      return current;

    const amountCents =
      changes.amountCents === undefined
        ? current.amountCents
        : requirePositiveSafeIntegerCents(changes.amountCents);
    const date = changes.date === undefined ? current.date : requireLedgerDate(changes.date, () => this.now());
    if (changes.note !== undefined && typeof changes.note !== 'string') {
      throw new ValidationError('note must be a string.');
    }
    const note = changes.note === undefined ? current.note : changes.note;
    // Moving a salary to another account is a normal correction ("I filed it against the
    // wrong card"), so it is allowed and needs no other field. The balance simply follows:
    // both accounts are recomputed from the rows, so there is nothing to keep in sync.
    const accountId =
      changes.accountId === undefined
        ? current.accountId
        : requireNonEmptyString(changes.accountId, 'accountId');
    if (accountId !== current.accountId) assertAccountUsable(this.db, accountId);
    if (amountCents === current.amountCents && date === current.date && note === current.note && accountId === current.accountId && changes.allocations === undefined) return current;
    const fundOwner = this.db.prepare(`SELECT g.id,g.origin_kind,g.active_revision,g.status FROM financial_fund_grant_sources s JOIN financial_fund_grants g ON g.id=s.grant_id WHERE s.salary_id=?`).get(id) as { id: string; origin_kind: string; active_revision: number; status: string } | undefined;
    if (fundOwner?.origin_kind === 'salary' && !keyed) throw new FinancialInvalidError('A keyed version 1 salary edit is required.');
    if (fundOwner?.origin_kind === 'salary' && changes.allocations !== undefined) throw new FinancialInvalidError('Funded salaries do not accept module allocations.');
    if (amountCents !== current.amountCents && changes.allocations === undefined && fundOwner === undefined) {
      throw new ValidationError(
        'Changing the salary amount requires explicit allocations that add up to the new salary.',
      );
    }
    const items =
      changes.allocations === undefined
        ? undefined
        : this.resolveAllocations(changes.allocations, amountCents, undefined);
    const nowMs = this.now();

    this.db.transaction(() => {
      const sourceChanged = amountCents !== current.amountCents || date !== current.date || accountId !== current.accountId;
      if ((sourceChanged || note !== current.note) && fundOwner?.origin_kind === 'salary') {
        if (fundGrantNeedsReview(this.db, fundOwner.id) || current.fundGrant === undefined) throw new FinancialSourceChangedError('The salary grant changed; reload it before editing.');
        if (!Number.isSafeInteger(fundOwner.active_revision) || fundOwner.active_revision >= Number.MAX_SAFE_INTEGER) throw new FinancialUnavailableError();
        const revision = fundOwner.active_revision + 1;
        const token = salarySourceToken({ id, amount_cents: amountCents, date, account_id: accountId });
        const sources = [{ salaryId: id, amountCents, date, accountId, sourceToken: token, confirmedAt: nowMs }];
        this.db.prepare('INSERT INTO financial_fund_grant_revisions VALUES (?,?,?,?,?,?,?,?,?,?)').run(fundOwner.id, revision, amountCents, JSON.stringify(current.fundGrant.ratiosBps), JSON.stringify(allocateFundIncomeCents(amountCents, current.fundGrant.ratiosBps)), JSON.stringify(sources), actorId ?? null, operationId ?? null, nowMs, 'salary-edit');
        this.db.prepare('UPDATE financial_fund_grant_sources SET source_token=?,amount_cents=?,date=?,account_id=? WHERE salary_id=? AND grant_id=?').run(token, amountCents, date, accountId, id, fundOwner.id);
        this.db.prepare('UPDATE financial_fund_grants SET active_revision=? WHERE id=?').run(revision, fundOwner.id);
      } else if (sourceChanged && fundOwner?.origin_kind === 'legacy-group') {
        this.db.prepare("UPDATE financial_fund_grants SET status='review-required' WHERE id=?").run(fundOwner.id);
        this.db.prepare("UPDATE financial_fund_grant_sources SET status='review-required' WHERE salary_id=? AND grant_id=?").run(id, fundOwner.id);
      }
      this.db
        .prepare(
          'UPDATE salary_records SET amount_cents = ?, date = ?, note = ?, account_id = ?, updated_at = ? WHERE id = ?',
        )
        .run(amountCents, date, note, accountId, nowMs, id);
      if (items !== undefined) {
        this.writeAllocation(id, date, items, nowMs);
      } else if (date !== current.date) {
        this.db
          .prepare(
            'UPDATE budget_allocations SET date = ?, updated_at = ? WHERE salary_record_id = ?',
          )
          .run(date, nowMs, id);
      }
    })();
    return this.getByIdOrThrow(id);
  }

  /** All snapshot rewrites also synchronize their date with the salary. */
  private writeAllocation(
    id: string,
    date: number,
    items: ParsedAllocationItem[],
    nowMs: number,
  ): void {
    const existing = this.getAllocationRow(id);
    if (existing === undefined) {
      this.db
        .prepare(
          `INSERT INTO budget_allocations (id, salary_record_id, date, allocations_json, deleted, updated_at)
        VALUES (?, ?, ?, ?, 0, ?)`,
        )
        .run(randomUUID(), id, date, JSON.stringify(items), nowMs);
    } else {
      this.db
        .prepare(
          'UPDATE budget_allocations SET date = ?, allocations_json = ?, deleted = 0, updated_at = ? WHERE id = ?',
        )
        .run(date, JSON.stringify(items), nowMs, existing.id);
    }
  }

  /** Replaces the allocation snapshot without silently changing the salary. */
  replaceAllocations(id: string, raw: unknown): SalaryDetailDto {
    if (raw === undefined) throw new ValidationError('allocations are required.');
    const write = this.db.transaction(() => {
      const salary = this.getByIdOrThrow(id);
      const owner = this.db.prepare(`SELECT g.origin_kind FROM financial_fund_grants g
        JOIN financial_fund_grant_sources s ON s.grant_id=g.id WHERE s.salary_id=?`).get(id) as { origin_kind: string } | undefined;
      if (owner?.origin_kind === 'salary') throw new FinancialInvalidError('Funded salaries do not accept module allocations.');
      const items = this.resolveAllocations(raw, salary.amountCents, undefined);
      this.writeAllocation(id, salary.date, items, this.now());
    });
    write.immediate();
    return this.getByIdOrThrow(id);
  }

  /**
   * Applies a template to every live salary in the newest budget cycle.
   *
   * Template edits remain definitions until this explicit action rewrites the
   * current cycle's salary snapshots. Historical cycles are never touched.
   */
  applyTemplateToCurrentCycle(templateId: string): {
    readonly templateId: string;
    readonly templateName: string;
    readonly salaryCount: number;
    readonly totalAmountCents: number;
  } {
    const template = this.templates.getByIdOrThrow(templateId);
    const rows = this.db
      .prepare(
        `SELECT sr.id, sr.amount_cents, ba.date
           FROM salary_records AS sr
           JOIN budget_allocations AS ba ON ba.salary_record_id = sr.id
          WHERE sr.deleted = 0 AND ba.deleted = 0
          ORDER BY ba.date DESC, ba.updated_at DESC`,
      )
      .all() as { id: string; amount_cents: number; date: number }[];

    const newest = rows[0];
    if (newest === undefined) {
      throw new ValidationError('There is no current budget cycle to update.');
    }

    const cycleDay = this.getCycleStartDay();
    const cycleKey =
      cycleDay === undefined ? monthKey(newest.date) : allocationPeriodStart(cycleDay, newest.date);
    const currentRows = rows.filter((row) =>
      cycleDay === undefined
        ? monthKey(row.date) === cycleKey
        : allocationPeriodStart(cycleDay, row.date) === cycleKey,
    );

    const updates = currentRows.map((row) => ({
      id: row.id,
      date: row.date,
      allocations: allocateSalaryCents(row.amount_cents, template.modules),
    }));
    const nowMs = this.now();
    this.db.transaction(() => {
      for (const update of updates) {
        this.writeAllocation(update.id, update.date, update.allocations, nowMs);
      }
    })();

    return {
      templateId: template.id,
      templateName: template.name,
      salaryCount: updates.length,
      totalAmountCents: currentRows.reduce((total, row) => total + row.amount_cents, 0),
    };
  }
  /**
   * Soft-deletes the salary AND its allocation.
   *
   * Both must go: the budget engine reads allocations, so leaving one behind would
   * keep a deleted salary in the current cycle.
   */
  softDelete(id: string, input: { readonly contractVersion?: unknown; readonly expectedGrantRevision?: unknown; readonly operationId?: unknown } = {}, context: SalaryCreateContext = {}): void {
    if (input.contractVersion === 1) {
      const operationId = requireFinancialOperationId(input.operationId);
      runFinancialOperation(this.db, { operationId, actorId: context.actorId ?? this.resolveActorId(), method: 'DELETE', resource: `${SALARY_CREATE_RESOURCE}/${id}`, canonicalPayload: input, now: this.now() }, () => {
        const current = this.getByIdOrThrow(id);
        if (!Number.isSafeInteger(input.expectedGrantRevision) || (input.expectedGrantRevision as number) < 1 || Object.keys(input).some((key) => !['contractVersion', 'expectedGrantRevision', 'operationId'].includes(key))) throw new FinancialInvalidError('A valid grant revision is required.');
        if (current.fundGrant?.revision !== input.expectedGrantRevision) throw new FinancialRevisionConflictError('The salary grant changed. Reload it before deleting.');
        this.deleteOnce(id);
        return { statusCode: 204, response: null };
      });
      return;
    }
    const owner = this.db.prepare("SELECT g.origin_kind FROM financial_fund_grants g JOIN financial_fund_grant_sources s ON s.grant_id=g.id WHERE s.salary_id=?").get(id) as { origin_kind: string } | undefined;
    if (owner?.origin_kind === 'salary') throw new FinancialInvalidError('A keyed version 1 salary deletion is required.');
    this.deleteOnce(id);
  }

  private deleteOnce(id: string): void {
    this.getByIdOrThrow(id);
    const nowMs = this.now();

    const run = this.db.transaction((): void => {
      this.db.prepare(`UPDATE financial_fund_grants SET status=CASE WHEN origin_kind='legacy-group' THEN 'review-required' ELSE 'deleted' END
        WHERE id=(SELECT grant_id FROM financial_fund_grant_sources WHERE salary_id=?)`).run(id);
      this.db.prepare(`UPDATE financial_fund_grant_sources SET status=CASE WHEN grant_id IN
        (SELECT id FROM financial_fund_grants WHERE origin_kind='legacy-group') THEN 'review-required' ELSE 'deleted' END WHERE salary_id=?`).run(id);
      this.db
        .prepare('UPDATE salary_records SET deleted = 1, updated_at = ? WHERE id = ?')
        .run(nowMs, id);
      this.db
        .prepare(
          'UPDATE budget_allocations SET deleted = 1, updated_at = ? WHERE salary_record_id = ?',
        )
        .run(nowMs, id);
    });
    run();
  }

  // ── settings: budget.cycle_start_day ───────────────────────────────────────

  /** The configured cycle start day, or `undefined` for natural-month mode. */
  getCycleStartDay(): number | undefined {
    const row = this.db
      .prepare('SELECT value_json FROM settings WHERE key = ?')
      .get(CYCLE_START_DAY_KEY) as { value_json: string } | undefined;
    if (row === undefined) return undefined;

    try {
      const decoded: unknown = JSON.parse(row.value_json);
      if (typeof decoded !== 'object' || decoded === null) return undefined;
      const day = (decoded as Record<string, unknown>)['day'];
      if (typeof day !== 'number' || !Number.isInteger(day)) return undefined;
      if (day < MIN_CYCLE_START_DAY || day > MAX_CYCLE_START_DAY) return undefined;
      return day;
    } catch {
      return undefined;
    }
  }

  /** Sets the cycle start day. `null` clears it back to natural-month mode. */
  setCycleStartDay(day: number | null): number | undefined {
    if (day === null) {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(CYCLE_START_DAY_KEY);
      return undefined;
    }

    if (!Number.isInteger(day) || day < MIN_CYCLE_START_DAY || day > MAX_CYCLE_START_DAY) {
      throw new ValidationError(
        `Cycle start day must be an integer between ${MIN_CYCLE_START_DAY} and ${MAX_CYCLE_START_DAY}.`,
      );
    }

    this.db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(CYCLE_START_DAY_KEY, JSON.stringify({ day }), this.now());

    return day;
  }
}
