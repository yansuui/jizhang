import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_TOOL_NAMES,
  isAssistantToolName,
  findClarification,
  normalizeAssistantContent,
  normalizeAssistantJson,
  normalizeAssistantProviderTurn,
  requireAssistantToolName,
  AssistantProviderTurnError,
  AssistantValidationError,
} from '../src/services/assistant-types.js';
import { AssistantToolRegistry } from '../src/services/assistant-tool-registry.js';

describe('assistant JSON contract', () => {
  it('keeps decimals used by ratios, weights, and confidence', () => {
    const normalized = normalizeAssistantJson({
      ratio: 0.4,
      weight: 0.35,
      confidence: 0.875,
      nested: { share: 0.125, list: [0.5, 1.25] },
    }) as Record<string, unknown>;

    expect(normalized['ratio']).toBe(0.4);
    expect(normalized['weight']).toBe(0.35);
    expect(normalized['confidence']).toBe(0.875);
    expect((normalized['nested'] as Record<string, unknown>)['share']).toBe(0.125);
    expect((normalized['nested'] as Record<string, unknown>)['list']).toEqual([0.5, 1.25]);
  });

  it('still rejects non-finite numbers and unsafe large integers', () => {
    expect(() => normalizeAssistantJson({ value: Number.NaN })).toThrow(AssistantValidationError);
    expect(() => normalizeAssistantJson({ value: Number.POSITIVE_INFINITY })).toThrow(AssistantValidationError);
    expect(() => normalizeAssistantJson({ value: Number.MAX_SAFE_INTEGER + 2 })).toThrow(AssistantValidationError);
  });
});

describe('assistant progress / error / toolName', () => {
  it('accepts a known tool name on progress and rejects unknown names', () => {
    const ok = normalizeAssistantContent('progress', {
      version: 1,
      progress: { state: 'running', toolName: 'stats.monthly' },
    });
    expect(ok.progress?.toolName).toBe('stats.monthly');
    expect(normalizeAssistantContent('progress', { version: 1, progress: { state: 'failed', toolName: 'stats.monthly' } }).progress?.state).toBe('failed');

    expect(() =>
      normalizeAssistantContent('progress', {
        version: 1,
        progress: { state: 'running', toolName: 'not-a-tool' },
      }),
    ).toThrow(AssistantValidationError);

    expect(() =>
      normalizeAssistantContent('progress', {
        version: 1,
        progress: { state: 'running', toolName: 42 },
      }),
    ).toThrow(AssistantValidationError);
  });

  it('validates result toolName against the allowlist', () => {
    const ok = normalizeAssistantContent('result', {
      version: 1,
      result: { version: 1, toolName: 'accounts.balances', summary: 'ok', data: { total: 1 } },
    });
    expect(ok.result?.toolName).toBe('accounts.balances');

    expect(() =>
      normalizeAssistantContent('result', {
        version: 1,
        result: { version: 1, toolName: 'injected.tool', summary: 'ok', data: {} },
      }),
    ).toThrow(AssistantValidationError);
  });

  it('requires a structured error payload', () => {
    const ok = normalizeAssistantContent('error', {
      version: 1,
      error: { code: 'AI_UNAVAILABLE', message: 'AI 暂不可用' },
    });
    expect(ok.error).toEqual({ code: 'AI_UNAVAILABLE', message: 'AI 暂不可用' });

    expect(() =>
      normalizeAssistantContent('error', { version: 1, error: 'boom' }),
    ).toThrow(AssistantValidationError);
    expect(() =>
      normalizeAssistantContent('error', { version: 1, error: { code: 'X' } }),
    ).toThrow(AssistantValidationError);
  });

  it('requireAssistantToolName rejects non-allowlisted values', () => {
    expect(requireAssistantToolName('transaction.create', 'toolName')).toBe('transaction.create');
    expect(() => requireAssistantToolName('drop table', 'toolName')).toThrow(AssistantValidationError);
    expect(() => requireAssistantToolName(undefined, 'toolName')).toThrow(AssistantValidationError);
  });
});

describe('provider clarification and persisted choice cards', () => {
  it('accepts a bounded clarification and normalizes the labels', () => {
    const turn = normalizeAssistantProviderTurn({
      message: '请选择账户',
      toolCall: null,
      clarification: { question: ' 使用哪个账户？ ', options: [' 微信 ', '银行卡'] },
    });
    expect(turn.toolCall).toBeNull();
    expect(turn.clarification).toEqual({ question: '使用哪个账户？', options: ['微信', '银行卡'] });
  });

  it('treats a missing clarification member as null', () => {
    const turn = normalizeAssistantProviderTurn({ message: 'ok', toolCall: null });
    expect(turn.clarification).toBeNull();
  });

  it('ignores provider-only members and accepts the snake_case tool_call spelling', () => {
    const turn = normalizeAssistantProviderTurn({
      message: '查一下',
      tool_call: { name: 'transactions.query', arguments: { q: '淘宝' } },
      reasoning: 'internal hint',
    });
    expect(turn.message).toBe('查一下');
    expect(turn.toolCall?.name).toBe('transactions.query');
  });

  it('keeps a decided tool call when the provider omits the prose', () => {
    const turn = normalizeAssistantProviderTurn({
      toolCall: { name: 'transactions.query', arguments: {} },
    });
    expect(turn.message).toBe('正在处理…');
    expect(turn.toolCall?.name).toBe('transactions.query');
  });

  it('still rejects an empty answer without a tool call', () => {
    expect(() => normalizeAssistantProviderTurn({ message: '   ', toolCall: null })).toThrow(AssistantProviderTurnError);
  });

  it('bounds a buffered provider message without cutting a surrogate pair', () => {
    // 3999 BMP units + one astral character: a raw UTF-16 `slice(0, 4000)` keeps the lone
    // high surrogate and persists half an emoji (JSON escapes it, the client renders '�').
    const emoji = '\u{1F600}';
    const bounded = normalizeAssistantProviderTurn({ message: 'a'.repeat(3_999) + emoji, toolCall: null });
    expect(bounded.message.length).toBe(3_999);
    expect(bounded.message.endsWith('a')).toBe(true);
    const last = bounded.message.charCodeAt(bounded.message.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);

    // A message that fits keeps its astral characters intact.
    const intact = normalizeAssistantProviderTurn({ message: 'a'.repeat(100) + emoji, toolCall: null });
    expect(intact.message.endsWith(emoji)).toBe(true);
    expect(intact.message.length).toBe(102);
  });

  it('rejects clarification combined with a tool call', () => {
    expect(() =>
      normalizeAssistantProviderTurn({
        message: 'both',
        toolCall: { name: 'stats.monthly', arguments: {} },
        clarification: { question: 'q', options: ['a', 'b'] },
      }),
    ).toThrow(AssistantProviderTurnError);
  });

  it('rejects option counts outside 2-6, duplicates and blank labels', () => {
    const withOptions = (options: string[]): unknown => ({
      message: 'q',
      toolCall: null,
      clarification: { question: '选一个', options },
    });
    expect(() => normalizeAssistantProviderTurn(withOptions(['只有一个']))).toThrow(AssistantProviderTurnError);
    expect(() => normalizeAssistantProviderTurn(withOptions(['a', 'b', 'c', 'd', 'e', 'f', 'g']))).toThrow(AssistantProviderTurnError);
    expect(() => normalizeAssistantProviderTurn(withOptions(['a', 'a']))).toThrow(AssistantProviderTurnError);
    expect(() => normalizeAssistantProviderTurn(withOptions(['a', '   ']))).toThrow(AssistantProviderTurnError);
    expect(() => normalizeAssistantProviderTurn(withOptions(['a'.repeat(101), 'b']))).toThrow(AssistantProviderTurnError);
    expect(() =>
      normalizeAssistantProviderTurn({ message: 'q', toolCall: null, clarification: { question: '', options: ['a', 'b'] } }),
    ).toThrow(AssistantProviderTurnError);
  });

  it('round-trips a persisted clarification and rejects malformed ones', () => {
    const content = normalizeAssistantContent('text', {
      version: 1,
      text: '请选择',
      generationId: 'gen_1',
      clarification: {
        id: 'q_1',
        selection: 'single',
        question: '使用哪个账户？',
        options: [
          { id: 'o_1', label: '微信' },
          { id: 'o_2', label: '银行卡' },
        ],
        allowFreeText: true,
      },
    });
    expect(content.generationId).toBe('gen_1');
    expect(content.clarification?.options.length).toBe(2);
    expect(findClarification({ content })?.question).toBe('使用哪个账户？');

    const base = { id: 'q_1', selection: 'single', question: 'q', allowFreeText: true };
    expect(() =>
      normalizeAssistantContent('text', { ...base, version: 1, clarification: { ...base, options: [{ id: 'o_1', label: 'a' }] } }),
    ).toThrow(AssistantValidationError);
    expect(() =>
      normalizeAssistantContent('text', {
        version: 1,
        clarification: { ...base, options: [{ id: 'o_1', label: 'a' }, { id: 'o_1', label: 'b' }] },
      }),
    ).toThrow(AssistantValidationError);
    expect(() =>
      normalizeAssistantContent('text', {
        version: 1,
        clarification: { ...base, selection: 'multi', options: [{ id: 'o_1', label: 'a' }, { id: 'o_2', label: 'b' }] },
      }),
    ).toThrow(AssistantValidationError);
    expect(findClarification({ content: { version: 1, text: 'x' } })).toBeNull();
  });
});

describe('assistant tool catalog', () => {
  it('registers every allowlisted tool and never shrinks the catalog', () => {
    const registry = new AssistantToolRegistry();
    const catalog = registry.catalog();
    const names = catalog.map((tool) => tool.name);

    expect(names).toEqual([...ASSISTANT_TOOL_NAMES]);
    expect(new Set(names).size).toBe(ASSISTANT_TOOL_NAMES.length);
    for (const name of ASSISTANT_TOOL_NAMES) {
      expect(isAssistantToolName(name)).toBe(true);
      expect(registry.get(name)).toBeDefined();
    }
  });
});
