/**
 * Recurring bills (T13).
 *
 * ## The one design decision that shapes everything
 *
 * A due date becomes a **pending occurrence**, never a transaction. Nothing in this file
 * can put money in the ledger without the user confirming it. Automatic posting would be
 * more convenient and much worse: the ledger would drift away from reality while the user
 * was not looking, and every budget figure derived from it would quietly become wrong.
 *
 * The pending record is therefore real storage, not a derived view. Two states cannot be
 * reconstructed after the fact — "the user ignored this one" and "this one already became
 * a bill". Guessing the second from the transactions table would misfire whenever the
 * user entered an identical bill by hand.
 *
 * ## The money and dates come from `@jizhang/shared`
 *
 * Date advancement lives in `shared/src/recurring.ts` because it is a rule, not a query,
 * and because the anchor-based month arithmetic it implements (1/31 → 2/28 → **3/31**) is
 * exactly the kind of thing that needs its own tests. Confirmation delegates to
 * `TransactionService.create`, so a bill born from a rule is validated and normalised by
 * the same code path as one typed by hand.
 */
import { randomUUID } from 'node:crypto';
import {
  isRecurringFrequency,
  nextDueAfter,
  dateOnly,
  type RecurringFrequency,
} from '@jizhang/shared';
import type { Db } from '../db/index.js';
import {
  ConflictError,
  NotFoundError,
  TransactionService,
  ValidationError,
  type TransactionDto,
} from './transaction-service.js';

/**
 * How many missed periods a single generation run will materialise per rule.
 *
 * Bounded on purpose: a `daily` rule left alone for a year would otherwise create
 * hundreds of rows the user has to dismiss one by one. Twelve matches the reference
 * implementation. When more were due, `hasOlderDue` is set so the UI can say so —
 * silently dropping them is what would make this a bug.
 */
export const MAX_LOOKBACK_PERIODS = 12;

/** One day of slack on the anchor date, matching the transaction date rule. */
const FUTURE_SLACK_MS = 86_400_000;

export interface RecurringRuleDto {
  readonly id: string;
  readonly name: string;
  readonly type: number;
  readonly amountCents: number;
  readonly categoryId: string;
  readonly accountId: string;
  readonly frequency: RecurringFrequency;
  readonly anchorDate: number;
  readonly nextDueDate: number;
  /** True when earlier due dates exist that this run did not generate. */
  readonly hasOlderDue: boolean;
  readonly enabled: boolean;
  readonly updatedAt: number;
}

export interface RecurringOccurrenceDto {
  readonly id: string;
  readonly ruleId: string;
  readonly plannedDate: number;
  readonly status: 'pending' | 'confirmed' | 'ignored';
  readonly transactionId: string | null;
  readonly type: number;
  readonly amountCents: number;
  readonly categoryId: string;
  readonly accountId: string;
  readonly note: string;
  readonly updatedAt: number;
}

interface RuleRow {
  readonly id: string;
  readonly name: string;
  readonly type: number;
  readonly amount_cents: number;
  readonly category_id: string;
  readonly account_id: string;
  readonly frequency: string;
  readonly anchor_date: number;
  readonly next_due_date: number;
  readonly has_older_due: number;
  readonly enabled: number;
  readonly updated_at: number;
}

interface OccurrenceRow {
  readonly id: string;
  readonly rule_id: string;
  readonly planned_date: number;
  readonly status: string;
  readonly transaction_id: string | null;
  readonly type: number;
  readonly amount_cents: number;
  readonly category_id: string;
  readonly account_id: string;
  readonly note: string;
  readonly updated_at: number;
}

export interface RecurringServiceOptions {
  readonly actorId?: string | undefined;
  readonly now?: (() => number) | undefined;
}

export interface CreateRuleInput {
  readonly name?: unknown;
  readonly type?: unknown;
  readonly amountCents?: unknown;
  readonly categoryId?: unknown;
  readonly accountId?: unknown;
  readonly frequency?: unknown;
  readonly anchorDate?: unknown;
  readonly enabled?: unknown;
}

export interface GenerateResult {
  /** Occurrences created by this run. Zero on a repeat call — generation is idempotent. */
  readonly created: number;
  /** Rules whose backlog exceeded the cap, so the UI must say "there is more". */
  readonly truncated: number;
}

function toRuleDto(row: RuleRow): RecurringRuleDto {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    amountCents: row.amount_cents,
    categoryId: row.category_id,
    accountId: row.account_id,
    frequency: row.frequency as RecurringFrequency,
    anchorDate: row.anchor_date,
    nextDueDate: row.next_due_date,
    hasOlderDue: row.has_older_due === 1,
    enabled: row.enabled === 1,
    updatedAt: row.updated_at,
  };
}

function toOccurrenceDto(row: OccurrenceRow): RecurringOccurrenceDto {
  return {
    id: row.id,
    ruleId: row.rule_id,
    plannedDate: row.planned_date,
    status: row.status as RecurringOccurrenceDto['status'],
    transactionId: row.transaction_id,
    type: row.type,
    amountCents: row.amount_cents,
    categoryId: row.category_id,
    accountId: row.account_id,
    note: row.note,
    updatedAt: row.updated_at,
  };
}

export class RecurringService {
  private readonly db: Db;
  private readonly now: () => number;
  private readonly transactions: TransactionService;

  constructor(db: Db, options: RecurringServiceOptions = {}) {
    this.db = db;
    this.now = options.now ?? (() => Date.now());
    this.transactions = new TransactionService(db, options);
  }

  // ── rules ──────────────────────────────────────────────────────────────────

  listRules(): RecurringRuleDto[] {
    const rows = this.db
      .prepare(
        // `rowid` is SQLite's implicit insertion order: the list is stable and oldest
        // first, which is what a management screen wants. There is no created_at column
        // to sort on, and `updated_at` would make the list jump on every edit.
        'SELECT * FROM recurring_rules WHERE deleted = 0 ORDER BY rowid',
      )
      .all() as RuleRow[];
    return rows.map(toRuleDto);
  }

  getRule(id: string): RecurringRuleDto {
    const row = this.db
      .prepare('SELECT * FROM recurring_rules WHERE id = ? AND deleted = 0')
      .get(id) as RuleRow | undefined;
    if (row === undefined) throw new NotFoundError('Recurring rule not found.');
    return toRuleDto(row);
  }

  createRule(input: CreateRuleInput): RecurringRuleDto {
    const name = this.requireName(input.name);
    const type = this.requireType(input.type);
    const amountCents = this.requireAmount(input.amountCents);
    const categoryId = this.requireString(input.categoryId, 'categoryId');
    const accountId = this.requireString(input.accountId, 'accountId');
    const frequency = this.requireFrequency(input.frequency);
    const anchorDate = this.requireAnchor(input.anchorDate);

    // Validation reused from the transaction service, so a rule cannot be pointed at a
    // soft-deleted category any more than a bill can.
    this.transactions.assertReferencesUsable(type, categoryId, accountId);

    const id = randomUUID();
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO recurring_rules
           (id, name, type, amount_cents, category_id, account_id, frequency,
            anchor_date, next_due_date, has_older_due, enabled, deleted, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?)`,
      )
      .run(
        id,
        name,
        type,
        amountCents,
        categoryId,
        accountId,
        frequency,
        anchorDate,
        // The first due date IS the anchor; generation walks forward from here.
        anchorDate,
        input.enabled === false ? 0 : 1,
        at,
      );

    return this.getRule(id);
  }

  updateRule(id: string, changes: CreateRuleInput): RecurringRuleDto {
    this.getRule(id);

    const updates: string[] = [];
    const params: (string | number)[] = [];
    const push = (column: string, value: string | number): void => {
      updates.push(`${column} = ?`);
      params.push(value);
    };

    if (changes.name !== undefined) push('name', this.requireName(changes.name));
    if (changes.type !== undefined) push('type', this.requireType(changes.type));
    if (changes.amountCents !== undefined) {
      push('amount_cents', this.requireAmount(changes.amountCents));
    }
    if (changes.categoryId !== undefined) {
      push('category_id', this.requireString(changes.categoryId, 'categoryId'));
    }
    if (changes.accountId !== undefined) {
      push('account_id', this.requireString(changes.accountId, 'accountId'));
    }
    if (changes.frequency !== undefined) {
      push('frequency', this.requireFrequency(changes.frequency));
    }
    if (changes.anchorDate !== undefined) {
      push('anchor_date', this.requireAnchor(changes.anchorDate));
    }

    if (updates.length > 0) {
      push('updated_at', this.now());
      this.db
        .prepare(`UPDATE recurring_rules SET ${updates.join(', ')} WHERE id = ?`)
        .run(...params, id);
    }

    // Moving the anchor changes every future due date, so the cursor has to be rebuilt
    // from the new anchor rather than left pointing at a date that is no longer on the
    // schedule.
    if (changes.anchorDate !== undefined) {
      this.resetCursor(id);
    }

    return this.getRule(id);
  }

  /**
   * Enables or disables a rule.
   *
   * Re-enabling resets the cursor to the next due date AFTER today rather than
   * materialising the backlog. A rule disabled for six months should resume from now,
   * not ask the user to dismiss six months of stale occurrences.
   */
  setRuleEnabled(id: string, enabled: boolean): RecurringRuleDto {
    this.getRule(id);
    this.db
      .prepare('UPDATE recurring_rules SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, this.now(), id);
    if (enabled) this.resetCursor(id);
    return this.getRule(id);
  }

  /**
   * Soft-deletes a rule and its UNPROCESSED occurrences.
   *
   * The pending ones go too: leaving them would strand alerts for a rule the user just
   * removed, with no way to understand where they came from. Confirmed and ignored rows
   * stay, because they are history.
   */
  deleteRule(id: string): void {
    this.getRule(id);
    const at = this.now();
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE recurring_rules SET deleted = 1, updated_at = ? WHERE id = ?')
        .run(at, id);
      this.db
        .prepare(
          "UPDATE recurring_occurrences SET deleted = 1, updated_at = ? WHERE rule_id = ? AND status = 'pending'",
        )
        .run(at, id);
    })();
  }

  /** Points the cursor at the next due date strictly after today. */
  private resetCursor(id: string): void {
    const rule = this.getRule(id);
    const next = nextDueAfter(rule.frequency, rule.anchorDate, this.now());
    this.db
      .prepare(
        'UPDATE recurring_rules SET next_due_date = ?, has_older_due = 0, updated_at = ? WHERE id = ?',
      )
      .run(next, this.now(), id);
  }

  // ── generation ─────────────────────────────────────────────────────────────

  /**
   * Materialises pending occurrences for every enabled rule that is due.
   *
   * Idempotent: the unique `(rule_id, planned_date)` index plus an explicit existence
   * check means calling this twice creates nothing the second time. That matters because
   * the frontend calls it on every app open.
   */
  generateDue(): GenerateResult {
    const today = dateOnly(this.now());
    const rules = this.db
      .prepare(
        'SELECT * FROM recurring_rules WHERE deleted = 0 AND enabled = 1 AND next_due_date <= ?',
      )
      .all(today) as RuleRow[];

    let created = 0;
    let truncated = 0;
    const at = this.now();

    for (const row of rules) {
      const rule = toRuleDto(row);
      // Enumerate due dates up to and including today. The cap is applied to the WINDOW
      // as we walk: keeping only the most recent periods is the requirement, and
      // collecting everything first and slicing from the front is the exact bug this
      // replaced — it discarded the newest dates and kept the oldest.
      //
      // The window is half-open `[from, to)`, so `to` is the start of tomorrow.
      const selected: number[] = [];
      let overflow = false;
      const tomorrow = today + 86_400_000;
      let cursor = rule.nextDueDate;
      while (cursor < tomorrow) {
        selected.push(cursor);
        if (selected.length > MAX_LOOKBACK_PERIODS) {
          // One past the cap is enough to know there is older history.
          overflow = true;
          selected.shift();
        }
        cursor = nextDueAfter(rule.frequency, rule.anchorDate, cursor);
      }

      // Where the cursor lands next: strictly after today, regardless of how much was
      // skipped, so a rule can never be stuck replaying its backlog.
      const nextCursor = nextDueAfter(rule.frequency, rule.anchorDate, today);
      if (overflow) truncated += 1;

      this.db.transaction(() => {
        for (const plannedDate of selected) {
          const existing = this.db
            .prepare(
              'SELECT 1 AS x FROM recurring_occurrences WHERE rule_id = ? AND planned_date = ? AND deleted = 0',
            )
            .get(rule.id, plannedDate) as { x: number } | undefined;
          if (existing !== undefined) continue;

          this.db
            .prepare(
              `INSERT INTO recurring_occurrences
                 (id, rule_id, planned_date, status, transaction_id, type, amount_cents,
                  category_id, account_id, note, deleted, updated_at)
               VALUES (?, ?, ?, 'pending', NULL, ?, ?, ?, ?, ?, 0, ?)`,
            )
            .run(
              randomUUID(),
              rule.id,
              plannedDate,
              rule.type,
              rule.amountCents,
              rule.categoryId,
              rule.accountId,
              rule.name,
              at,
            );
          created += 1;
        }

        this.db
          .prepare(
            'UPDATE recurring_rules SET next_due_date = ?, has_older_due = ?, updated_at = ? WHERE id = ?',
          )
          .run(nextCursor, overflow ? 1 : 0, at, rule.id);
      })();
    }

    return { created, truncated };
  }

  // ── occurrences ────────────────────────────────────────────────────────────

  /** Everything not yet decided, oldest first — the user's work queue. */
  listPending(): RecurringOccurrenceDto[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM recurring_occurrences WHERE deleted = 0 AND status = 'pending' ORDER BY planned_date, id",
      )
      .all() as OccurrenceRow[];
    return rows.map(toOccurrenceDto);
  }

  /** Every occurrence, newest first, including the ones already decided. */
  listOccurrences(): RecurringOccurrenceDto[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM recurring_occurrences WHERE deleted = 0 ORDER BY planned_date DESC, id',
      )
      .all() as OccurrenceRow[];
    return rows.map(toOccurrenceDto);
  }

  /**
   * Turns a pending occurrence into a real bill.
   *
   * The whole thing runs in ONE transaction, and a repeat call returns the bill it
   * already created instead of making another. This is the most dangerous path in the
   * feature: a double confirmation would double-count money, and the user would have no
   * obvious way to notice. Both the early return and the transaction exist for that.
   */
  confirmOccurrence(id: string): { transaction: TransactionDto; created: boolean } {
    return this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT * FROM recurring_occurrences WHERE id = ? AND deleted = 0')
        .get(id) as OccurrenceRow | undefined;
      if (row === undefined) throw new NotFoundError('Occurrence not found.');

      if (row.status === 'confirmed') {
        // Already done. Return the bill it produced rather than creating a second one.
        const existing =
          row.transaction_id === null
            ? undefined
            : this.transactions.getById(row.transaction_id, true);
        if (existing === undefined) {
          throw new ConflictError(
            'This occurrence is marked confirmed but its bill is missing.',
          );
        }
        return { transaction: existing, created: false };
      }

      if (row.status === 'ignored') {
        // Not a silent success: the caller's view of the world is out of date.
        throw new ConflictError('This occurrence was ignored and cannot be confirmed.');
      }

      const transaction = this.transactions.create({
        type: row.type,
        amountCents: row.amount_cents,
        categoryId: row.category_id,
        accountId: row.account_id,
        date: row.planned_date,
        note: row.note,
      });

      this.db
        .prepare(
          "UPDATE recurring_occurrences SET status = 'confirmed', transaction_id = ?, updated_at = ? WHERE id = ?",
        )
        .run(transaction.id, this.now(), id);

      return { transaction, created: true };
    })();
  }

  /**
   * Marks a pending occurrence as deliberately skipped.
   *
   * No bill is created. Idempotent in the safe direction: ignoring something already
   * ignored is a no-op, while ignoring something already confirmed is a conflict —
   * there IS a bill, and pretending otherwise would mislead the caller.
   */
  ignoreOccurrence(id: string): RecurringOccurrenceDto {
    return this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT * FROM recurring_occurrences WHERE id = ? AND deleted = 0')
        .get(id) as OccurrenceRow | undefined;
      if (row === undefined) throw new NotFoundError('Occurrence not found.');

      if (row.status === 'confirmed') {
        throw new ConflictError('This occurrence was already confirmed as a bill.');
      }
      if (row.status === 'pending') {
        this.db
          .prepare("UPDATE recurring_occurrences SET status = 'ignored', updated_at = ? WHERE id = ?")
          .run(this.now(), id);
      }

      const updated = this.db
        .prepare('SELECT * FROM recurring_occurrences WHERE id = ?')
        .get(id) as OccurrenceRow;
      return toOccurrenceDto(updated);
    })();
  }

  // ── validation ─────────────────────────────────────────────────────────────

  private requireName(value: unknown): string {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ValidationError('name must be a non-empty string.');
    }
    const trimmed = value.trim();
    if (trimmed.length > 60) throw new ValidationError('name must be at most 60 characters.');
    return trimmed;
  }

  private requireType(value: unknown): number {
    if (value !== 0 && value !== 1) {
      throw new ValidationError('type must be 0 (expense) or 1 (income).');
    }
    return value;
  }

  private requireAmount(value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new ValidationError(
        'amountCents must be a positive integer number of cents. ' +
          'Convert yuan to cents with Math.round(value * 100) on the client.',
      );
    }
    return value;
  }

  private requireString(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ValidationError(`${field} must be a non-empty string.`);
    }
    return value.trim();
  }

  private requireFrequency(value: unknown): RecurringFrequency {
    if (!isRecurringFrequency(value)) {
      throw new ValidationError(
        'frequency must be one of daily, weekly, monthly, quarterly, yearly.',
      );
    }
    return value;
  }

  private requireAnchor(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ValidationError('anchorDate must be an epoch-millisecond timestamp.');
    }
    if (value > this.now() + FUTURE_SLACK_MS) {
      throw new ValidationError('anchorDate must not be in the future.');
    }
    // Normalised to a local day: the schedule is defined in whole days.
    return dateOnly(value);
  }
}
