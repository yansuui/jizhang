import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AssistantTraceStore, MAX_TRACE_STEPS_PER_GENERATION, summarizeToolArguments,
} from '../src/services/assistant-trace-service.js';

let db: Database.Database;
let trace: AssistantTraceStore;
let clock = 1_700_000_000_000;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE assistant_generation_trace (
    id TEXT PRIMARY KEY, generation_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
    step INTEGER NOT NULL, kind TEXT NOT NULL, tool_name TEXT, argument_summary TEXT,
    status TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, created_at INTEGER NOT NULL)`);
  clock = 1_700_000_000_000;
  trace = new AssistantTraceStore(db, () => clock);
});

describe('summarizeToolArguments', () => {
  it('collapses collections to their size so bill contents never land in a trace', () => {
    const summary = summarizeToolArguments({ actionIds: ['a', 'b', 'c'], runId: 'r1' });
    expect(summary).toBe('actionIds[3] runId=r1');
    expect(summary).not.toContain('"a"');
  });

  it('truncates long strings and nested objects', () => {
    const summary = summarizeToolArguments({ note: 'x'.repeat(200), nested: { a: 1, b: 2 } });
    expect(summary).toContain('nested{2}');
    expect(summary.length).toBeLessThanOrEqual(200);
  });

  it('returns an empty summary for non-object arguments', () => {
    expect(summarizeToolArguments(null)).toBe('');
    expect(summarizeToolArguments(['a'])).toBe('');
    expect(summarizeToolArguments('text')).toBe('');
  });
});

describe('AssistantTraceStore', () => {
  it('records a step and closes it with a status and duration', () => {
    const id = trace.begin({ generationId: 'g1', conversationId: 'c1', step: 0, kind: 'tool',
      toolName: 'spending.preview', argumentSummary: 'startDate=2026-11-01' });
    expect(id).not.toBeNull();
    clock += 1_500;
    trace.finish(id, 'ok');
    expect(trace.list('g1')).toEqual([{
      id, step: 0, kind: 'tool', toolName: 'spending.preview',
      argumentSummary: 'startDate=2026-11-01', status: 'ok',
      startedAt: 1_700_000_000_000, finishedAt: 1_700_000_001_500,
    }]);
  });

  it('orders steps by ordinal regardless of insertion order', () => {
    const second = trace.begin({ generationId: 'g1', conversationId: 'c1', step: 2, kind: 'result' });
    const first = trace.begin({ generationId: 'g1', conversationId: 'c1', step: 1, kind: 'tool', toolName: 'funds.read' });
    trace.finish(second, 'ok');
    trace.finish(first, 'ok');
    expect(trace.list('g1').map((entry) => entry.step)).toEqual([1, 2]);
  });

  it('ignores a second finish so the first duration is authoritative', () => {
    const id = trace.begin({ generationId: 'g1', conversationId: 'c1', step: 0, kind: 'tool' });
    clock += 100;
    trace.finish(id, 'ok');
    clock += 900;
    trace.finish(id, 'failed');
    const [entry] = trace.list('g1');
    expect(entry?.status).toBe('ok');
    expect(entry?.finishedAt).toBe(1_700_000_000_100);
  });

  it('closes steps left running when the generation ends early', () => {
    trace.begin({ generationId: 'g1', conversationId: 'c1', step: 0, kind: 'tool', toolName: 'transactions.query' });
    trace.closeOpenSteps('g1', 'failed');
    const [entry] = trace.list('g1');
    expect(entry?.status).toBe('failed');
    expect(entry?.finishedAt).not.toBeNull();
  });

  it('enforces the per-generation step ceiling', () => {
    for (let step = 0; step < MAX_TRACE_STEPS_PER_GENERATION; step += 1) {
      expect(trace.begin({ generationId: 'g1', conversationId: 'c1', step, kind: 'tool' })).not.toBeNull();
    }
    expect(trace.begin({ generationId: 'g1', conversationId: 'c1', step: 99, kind: 'tool' })).toBeNull();
    expect(trace.count('g1')).toBe(MAX_TRACE_STEPS_PER_GENERATION);
  });

  it('keeps traces of different generations separate', () => {
    trace.begin({ generationId: 'g1', conversationId: 'c1', step: 0, kind: 'tool' });
    trace.begin({ generationId: 'g2', conversationId: 'c1', step: 0, kind: 'tool' });
    expect(trace.list('g1')).toHaveLength(1);
    expect(trace.list('g2')).toHaveLength(1);
  });

  it('returns an empty list for an unknown generation', () => {
    expect(trace.list('missing')).toEqual([]);
  });

  it('never throws when the table is unavailable, so diagnostics cannot fail a turn', () => {
    db.exec('DROP TABLE assistant_generation_trace');
    expect(trace.begin({ generationId: 'g1', conversationId: 'c1', step: 0, kind: 'tool' })).toBeNull();
    expect(trace.list('g1')).toEqual([]);
    expect(() => trace.finish('missing', 'ok')).not.toThrow();
    expect(() => trace.closeOpenSteps('g1', 'failed')).not.toThrow();
    expect(trace.count('g1')).toBe(0);
  });
});
