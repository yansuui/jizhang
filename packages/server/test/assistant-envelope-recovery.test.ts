import { describe, expect, it } from 'vitest';
import { extractBalancedObject, recoverProviderEnvelope, stripEnvelopeFence } from '../src/services/assistant-envelope-recovery.js';

const ENVELOPE = '{"message":"好的，我来整理。","toolCall":null}';

describe('envelope fence stripping', () => {
  it('removes a json fence and keeps the payload verbatim', () => {
    expect(stripEnvelopeFence('```json\n' + ENVELOPE + '\n```')).toBe(ENVELOPE);
    expect(stripEnvelopeFence('```\n' + ENVELOPE + '\n```')).toBe(ENVELOPE);
    expect(stripEnvelopeFence('```JSON' + ENVELOPE + '```')).toBe(ENVELOPE);
  });

  it('leaves text without a fence untouched', () => {
    expect(stripEnvelopeFence(ENVELOPE)).toBe(ENVELOPE);
    expect(stripEnvelopeFence('```\n```')).toBe('```\n```');
  });
});

describe('balanced object extraction', () => {
  it('ignores braces inside string literals', () => {
    const value = '{"message":"含 } 和 { 的文本","toolCall":null}';
    expect(extractBalancedObject(value)).toBe(value);
  });

  it('respects escaped quotes', () => {
    const value = '{"message":"say \\"}\\" now","toolCall":null}';
    expect(extractBalancedObject(value)).toBe(value);
  });

  it('returns null for a truncated object', () => {
    expect(extractBalancedObject('{"message":"未完成","toolCall":')).toBeNull();
    expect(extractBalancedObject('no object here')).toBeNull();
  });
});

describe('provider envelope recovery', () => {
  it('accepts a clean object without marking it repaired', () => {
    expect(recoverProviderEnvelope(ENVELOPE)).toEqual({ object: JSON.parse(ENVELOPE), repaired: false });
  });

  it('recovers a fenced object', () => {
    const recovered = recoverProviderEnvelope('```json\n' + ENVELOPE + '\n```');
    expect(recovered?.repaired).toBe(true);
    expect(recovered?.object).toEqual(JSON.parse(ENVELOPE));
  });

  it('recovers an object surrounded by prose', () => {
    const recovered = recoverProviderEnvelope('好的，结果如下：\n' + ENVELOPE + '\n以上。');
    expect(recovered?.repaired).toBe(true);
    expect(recovered?.object).toEqual(JSON.parse(ENVELOPE));
    expect(recovered?.text).toBeUndefined();
  });

  it('recovers a fenced object inside prose', () => {
    const recovered = recoverProviderEnvelope('请看：\n```json\n' + ENVELOPE + '\n```\n完成。');
    expect(recovered?.object).toEqual(JSON.parse(ENVELOPE));
  });

  it('treats brace-free prose as a plain answer', () => {
    const recovered = recoverProviderEnvelope('这个月餐饮支出偏高，建议减少外卖。');
    expect(recovered?.text).toBe('这个月餐饮支出偏高，建议减少外卖。');
    expect(recovered?.object).toBeUndefined();
  });

  it('never presents a broken object as prose', () => {
    expect(recoverProviderEnvelope('{"message":"被截断了')).toBeNull();
    expect(recoverProviderEnvelope('{"message":oops}')).toBeNull();
  });

  it('refuses a top-level array or scalar', () => {
    expect(recoverProviderEnvelope('[1,2,3]')).toBeNull();
    expect(recoverProviderEnvelope('42')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(recoverProviderEnvelope('')).toBeNull();
    expect(recoverProviderEnvelope('   ')).toBeNull();
  });
});
