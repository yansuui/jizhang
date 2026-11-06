/**
 * Bounded, diagnostic per-step trace for one assistant generation.
 *
 * The trace answers one question the user could not answer before: "where exactly did this
 * reply fall over?". It is intentionally *metadata only* — a step ordinal, what kind of step
 * it was, which tool ran, a short argument summary, a status and a duration. The model's raw
 * reasoning, the provider request/response body, the system prompt, SQL and raw bill notes are
 * never written here: those must not become queryable history, and the assistant contract
 * already forbids exposing them.
 *
 * Every writer is best-effort. A trace is diagnostics, so a failure to record one must never
 * fail the generation it is describing; the caller keeps its existing behaviour.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import { isAssistantToolName } from './assistant-types.js';

export type AssistantTraceKind = 'thinking' | 'tool' | 'result' | 'error';
export type AssistantTraceStatus = 'running' | 'ok' | 'failed';

/** Ceilings keep one pathological turn from bloating the database. */
export const MAX_TRACE_STEPS_PER_GENERATION = 32;
export const MAX_TRACE_SUMMARY_CHARS = 200;

export interface AssistantTraceEntry {
  readonly id: string;
  readonly step: number;
  readonly kind: AssistantTraceKind;
  readonly toolName: string | null;
  readonly argumentSummary: string | null;
  readonly status: AssistantTraceStatus;
  readonly startedAt: number;
  readonly finishedAt: number | null;
}

interface TraceRow {
  readonly id: string;
  readonly step: number;
  readonly kind: AssistantTraceKind;
  readonly tool_name: string | null;
  readonly argument_summary: string | null;
  readonly status: AssistantTraceStatus;
  readonly started_at: number;
  readonly finished_at: number | null;
}

function toEntry(row: TraceRow): AssistantTraceEntry {
  return {
    id: row.id,
    step: row.step,
    kind: row.kind,
    toolName: row.tool_name !== null && isAssistantToolName(row.tool_name) ? row.tool_name : null,
    argumentSummary: safeShape(row.argument_summary),
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/**
 * Renders a bounded, human-readable summary of tool arguments.
 *
 * Only the number of parameters and their broad value types are kept. No argument keys,
 * string prefixes, numeric amounts, object contents or resource IDs enter the trace.
 */
function safeShape(value: string | null | undefined): string | null {
  return typeof value === 'string' && /^参数\d{1,4}项 · 文本\d{1,4}项 · 数值\d{1,4}项 · 列表\d{1,4}项 · 对象\d{1,4}项$/.test(value) ? value : null;
}
export function summarizeToolArguments(args: unknown): string {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return '';
  const values = Object.values(args as Record<string, unknown>).slice(0, 1000);
  return `参数${values.length}项 · 文本${values.filter((v) => typeof v === 'string').length}项 · 数值${values.filter((v) => typeof v === 'number').length}项 · 列表${values.filter(Array.isArray).length}项 · 对象${values.filter((v) => v !== null && typeof v === 'object' && !Array.isArray(v)).length}项`;
}

export class AssistantTraceStore {
  constructor(private readonly db: Db, private readonly now: () => number = () => Date.now()) {}

  /** Steps already recorded for this generation; used to enforce the per-turn ceiling. */
  count(generationId: string): number {
    try {
      const row = this.db
        .prepare('SELECT COUNT(*) AS count FROM assistant_generation_trace WHERE generation_id = ?')
        .get(generationId) as { count: number } | undefined;
      return row?.count ?? 0;
    } catch {
      // A missing table (an older ledger that has not migrated) must not break a turn.
      return 0;
    }
  }

  /**
   * Records the start of a step and returns its id, or null when the ceiling is reached or
   * the write fails. Callers must tolerate null (diagnostics never block the turn).
   */
  begin(input: {
    readonly generationId: string;
    readonly conversationId: string;
    readonly step: number;
    readonly kind: AssistantTraceKind;
    readonly toolName?: string | null;
    readonly argumentSummary?: string | null;
  }): string | null {
    try {
      if (this.count(input.generationId) >= MAX_TRACE_STEPS_PER_GENERATION) return null;
      const id = randomUUID();
      const at = this.now();
      this.db.prepare(
        `INSERT INTO assistant_generation_trace
           (id, generation_id, conversation_id, step, kind, tool_name, argument_summary, status, started_at, finished_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, NULL, ?)`,
      ).run(
        id,
        input.generationId,
        input.conversationId,
        input.step,
        input.kind,
        input.toolName && isAssistantToolName(input.toolName) ? input.toolName : null,
        safeShape(input.argumentSummary),
        at,
        at,
      );
      return id;
    } catch {
      return null;
    }
  }

  /** Marks a previously begun step finished. A missing id (or a lost row) is a no-op. */
  finish(id: string | null, status: AssistantTraceStatus): void {
    if (id === null) return;
    try {
      this.db
        .prepare('UPDATE assistant_generation_trace SET status = ?, finished_at = ? WHERE id = ? AND finished_at IS NULL')
        .run(status, this.now(), id);
    } catch {
      // Diagnostics are best-effort.
    }
  }

  /** Ordered trace for one generation; an empty array when nothing was recorded. */
  list(generationId: string): AssistantTraceEntry[] {
    let rows: TraceRow[];
    try {
      rows = this.db
        .prepare(
          `SELECT id, step, kind, tool_name, argument_summary, status, started_at, finished_at
             FROM assistant_generation_trace
            WHERE generation_id = ?
            ORDER BY step, created_at`,
        )
        .all(generationId) as TraceRow[];
    } catch {
      // An older ledger without the trace table reads as "no trace" rather than an error.
      return [];
    }
    return rows.map(toEntry);
  }

  /**
   * Closes every step still marked running. Used when a generation reaches a terminal state
   * without its steps finishing (a crash, a Stop mid-tool, or a bounded failure), so the trace
   * never claims an operation is still in flight.
   */
  closeOpenSteps(generationId: string, status: AssistantTraceStatus): void {
    try {
      this.db
        .prepare('UPDATE assistant_generation_trace SET status = ?, finished_at = ? WHERE generation_id = ? AND finished_at IS NULL')
        .run(status, this.now(), generationId);
    } catch {
      // Diagnostics are best-effort.
    }
  }
}
