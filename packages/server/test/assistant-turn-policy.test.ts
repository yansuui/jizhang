import { describe, expect, it } from 'vitest';
import {
  assistantCanCorrectTool, assistantExpectedToolReply, assistantHistory, assistantReadIdentity,
} from '../src/services/assistant-turn-policy.js';
import { AssistantValidationError, type AssistantContextMessage } from '../src/services/assistant-types.js';

describe('bounded assistant turn policy', () => {
  it('gives known business argument failures a correction opportunity without accepting infrastructure or auth failures', () => {
    expect(assistantCanCorrectTool(new AssistantValidationError('invalid argument'))).toBe(true);
    for (const [code, statusCode] of [['AI_PROVIDER_TIMEOUT', 502], ['AUTH_REQUIRED', 401], ['FINANCIAL_CANCELLED', 409], ['INTERNAL_ERROR', 500]] as const) {
      expect(assistantCanCorrectTool(Object.assign(new Error('private-internal-details'), { code, statusCode }))).toBe(false);
    }
  });

  it('identifies semantically identical read arguments independently of property order', () => {
    expect(assistantReadIdentity('transactions.query', { limit: 10, offset: 0 })).toBe(assistantReadIdentity('transactions.query', { offset: 0, limit: 10 }));
  });

  it('maps expected organization states to fixed feedback without exposing internal text', () => {
    for (const [code, statusCode] of [['AI_ORGANIZATION_OVER_CAP', 400], ['AI_ORGANIZATION_RUNS_INVALID', 400], ['AI_ORGANIZATION_RUN_NOT_FOUND', 404], ['AI_ORGANIZATION_NOT_READY', 409], ['AI_ORGANIZATION_CONFLICT', 409], ['AI_ORGANIZATION_BUSY', 409]] as const) {
      const reply = assistantExpectedToolReply(Object.assign(new Error('private-internal-details'), { code, statusCode }));
      expect(reply).not.toBeNull();
      expect(reply).not.toContain('private-internal-details');
      expect(assistantExpectedToolReply(Object.assign(new Error('private-internal-details'), { code, statusCode: 401 }))).toBeNull();
    }
    expect(assistantExpectedToolReply(Object.assign(new Error('private-internal-details'), { code: 'AI_PROVIDER_TIMEOUT', statusCode: 502 }))).toBeNull();
  });

  it('bounds older context explicitly while retaining the latest authoritative facts', () => {
    const data = { items: Array.from({ length: 30 }, () => ({ note: '字'.repeat(4000) })) };
    const messages: AssistantContextMessage[] = [
      { role: 'assistant', kind: 'result', text: 'old query', data },
      { role: 'assistant', kind: 'result', text: 'latest query', data: { marker: 'latest-authoritative-fact' } },
    ];
    const result = assistantHistory(messages);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(128 * 1024);
    expect(JSON.stringify(result)).toContain('latest-authoritative-fact');
    expect(result[0]?.text).toContain('较早的对话明细未包含');
  });
});
