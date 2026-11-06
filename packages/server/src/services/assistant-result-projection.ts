import { boundedProviderMessage, type AssistantJsonObject, type AssistantJsonValue } from './assistant-types.js';
import type { AssistantToolResult } from './assistant-tool-registry.js';

/** Leave room for the message/event envelope below the native SSE single-line ceiling. */
export const ASSISTANT_READ_RESULT_MAX_BYTES = 40 * 1024;
const TEXT_UNITS = 200;
const TEXT_FIELDS = new Set(['note', 'reason', 'description', 'explanation', 'suggestedNote', 'originalNote', 'beforeNote', 'afterNote']);
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
function record(value: AssistantJsonValue | undefined): AssistantJsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as AssistantJsonObject : undefined;
}

/** Display-only text summaries; financial facts, identifiers, tags and hashes stay exact. */
export function projectAssistantReadResult(result: AssistantToolResult, args: AssistantJsonObject): AssistantToolResult {
  let omittedTextFields = 0;
  const text = (value: AssistantJsonValue, path: string): AssistantJsonValue => {
    if (Array.isArray(value)) return value.map((child, index) => text(child, `${path}[${index}]`));
    const object = record(value);
    if (!object) return value;
    const output: Record<string, AssistantJsonValue> = {};
    for (const [key, child] of Object.entries(object)) {
      const fullDetailNote = result.toolName === 'transaction.details' && path === '$.transaction' && key === 'note';
      if (!fullDetailNote && TEXT_FIELDS.has(key) && typeof child === 'string' && child.length > TEXT_UNITS) {
        output[key] = boundedProviderMessage(child, TEXT_UNITS - 1) + '…';
        output[`${key}Truncated`] = true;
        output[`${key}OriginalUnits`] = child.length;
        omittedTextFields++;
      } else output[key] = text(child, `${path}.${key}`);
    }
    return output;
  };
  let data = text(result.data, '$') as AssistantJsonObject;
  // Continuation is based on the rows actually returned, including a final short page.
  // Opaque cursor pages intentionally keep their domain-provided cursor unchanged.
  if (typeof data['offset'] === 'number' && typeof data['total'] === 'number' && Array.isArray(data['items'])) {
    const nextOffset = data['offset'] + data['items'].length;
    data = { ...data, nextOffset, hasMore: nextOffset < data['total'] };
  }
  const textNotice = '部分长文本仅展示摘要；账单备注可用单笔查询读取更多，全文请在账单页打开该记录查看。';
  if (omittedTextFields) data = { ...data, notice: [data['notice'], textNotice].filter(Boolean).join(' '), textProjection: {
    fieldsSummarized: omittedTextFields, maximumTextUnits: TEXT_UNITS,
    note: '长备注/理由仅展示摘要，可用 transaction.details 读取更多；全文请在账单详情页查看。金额、编号和标签未缩写。',
  } };
  let projected: AssistantToolResult = { ...result, data };
  const shrink = (values: readonly AssistantJsonValue[], total: number, offset: number) => {
    const size = Math.max(1, Math.floor(values.length / 2));
    const items = values.slice(0, size);
    return { items, total, offset, limit: items.length, nextOffset: offset + items.length, hasMore: offset + items.length < total };
  };
  // Only shrink collections with a known complete count and explicit continuation offset.
  while (bytes(projected) > ASSISTANT_READ_RESULT_MAX_BYTES) {
    const items = data['items'];
    const total = data['total'];
    const offsetPage = typeof data['offset'] === 'number' || result.toolName === 'transactions.recent';
    if (offsetPage && Array.isArray(items) && items.length > 1 && typeof total === 'number') {
      const offset = typeof data['offset'] === 'number' ? data['offset'] : typeof args['offset'] === 'number' ? args['offset'] : 0;
      data = { ...data, ...shrink(items, total, offset), pageReducedForDisplay: true,
        ...(result.toolName === 'transactions.recent' ? { continuationTool: 'transactions.query' } : {}) };
    } else if (result.toolName === 'transaction.details') {
      const transaction = record(data['transaction']);
      const refundPage = record(data['refundDetailsPage']);
      const originalsPage = record(data['refundLinkedTxIdsPage']);
      const refunds = transaction?.['refundDetails'];
      const originals = transaction?.['refundLinkedTxIds'];
      if (transaction && refundPage && Array.isArray(refunds) && refunds.length > 1 && typeof refundPage['total'] === 'number') {
        const page = shrink(refunds, refundPage['total'], refundPage['offset'] as number);
        const { items: reduced, ...meta } = page;
        data = { ...data, transaction: { ...transaction, refundDetails: reduced }, refundDetailsPage: meta, pageReducedForDisplay: true };
      } else if (transaction && originalsPage && Array.isArray(originals) && originals.length > 1 && typeof originalsPage['total'] === 'number') {
        const page = shrink(originals, originalsPage['total'], originalsPage['offset'] as number);
        const { items: reduced, ...meta } = page;
        data = { ...data, transaction: { ...transaction, refundLinkedTxIds: reduced }, refundLinkedTxIdsPage: meta, pageReducedForDisplay: true };
      } else break;
    } else break;
    projected = { ...result, data };
  }
  let suffix = omittedTextFields ? ' ' + textNotice : '';
  if (data['fullNoteOmitted'] === true) suffix += ' 备注超过助手显示上限，当前内容有省略；请在账单页打开该记录查看完整备注。';
  if (data['pageReducedForDisplay'] === true) {
    const shown = Array.isArray(data['items']) ? data['items'].length : undefined;
    suffix += shown === undefined
      ? ' 关联记录已分批展示，请按各分页的 nextOffset 继续查看。'
      : ` 本页展示 ${shown} 项，共 ${String(data['total'])} 项；其余请按 nextOffset 继续查看。`;
  }
  projected = { ...projected, summary: result.summary + suffix };
  if (bytes(projected) <= ASSISTANT_READ_RESULT_MAX_BYTES) return projected;

  // Never invent an empty financial result or partially remove amounts/IDs to fit a frame.
  const proposedSize = Array.isArray(result.data['items']) ? result.data['items'].length : 1;
  return { toolName: result.toolName, summary: '结果内容较多，请缩小查询范围或每页条数后查看。', data: {
    requiresNarrowerQuery: true, financialFactsOmitted: true, suggestedLimit: Math.max(1, Math.min(20, Math.floor(proposedSize / 2))),
    ...(typeof result.data['total'] === 'number' ? { total: result.data['total'] } : {}),
    ...(typeof result.data['offset'] === 'number' ? { offset: result.data['offset'] } : {}),
    note: '本次未展示完整事实，不能据此判断金额或执行写入；请保留原筛选和游标，减小每页条数，或查看单笔详情。',
  } };
}
