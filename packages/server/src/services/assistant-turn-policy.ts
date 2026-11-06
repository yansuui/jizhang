import type { AssistantToolResult } from './assistant-tool-registry.js';
import { AssistantValidationError, type AssistantContextMessage, type AssistantJsonObject } from './assistant-types.js';
import { canonicalFinancialPayload } from './financial-operation-store.js';

/** Shared bounded conversation policy for streamed and legacy buffered turns. */
export const MAX_ASSISTANT_TOOL_CORRECTIONS = 2;
export const ASSISTANT_TOOL_CORRECTION_HINT = '工具参数未通过校验。请按工具目录补齐必填字段并核对类型；资源编号、修订号和来源校验信息必须先读取当前账本，不能猜测。';
export const ASSISTANT_TOOL_CORRECTION_REPLY = '这项操作的参数尚未核对完整，账本没有改动。请补充要操作的记录或具体范围后再试。';
export const ASSISTANT_READ_LIMIT_REPLY = '本轮读取已到处理上限，已保留读取的部分结果。可以继续查询其余范围，账本没有改动。';
export const ASSISTANT_REPEATED_READ_REPLY = '这组查询条件已经读取过，本轮没有重复执行。已取得的结果保存在对话记录中，可以更换范围或页码继续。';
export const ASSISTANT_NARROW_QUERY_REPLY = '本次查询结果较多，尚未完整展示。请缩小日期范围或页大小后继续查询，账本没有改动。';
export const MAX_ASSISTANT_READ_FACT_BYTES = 64 * 1024;
export const MAX_ASSISTANT_MESSAGE_EVENT_BYTES = 48 * 1024;
export const ASSISTANT_PREVIEW_TOO_LARGE_REPLY = '所选操作的预览内容较多，请减少所选记录后分批确认，账本没有改动。';
const MAX_ASSISTANT_HISTORY_BYTES = 128 * 1024;

export class AssistantPreviewTooLargeError extends AssistantValidationError {
  constructor() { super(ASSISTANT_PREVIEW_TOO_LARGE_REPLY); }
}

/** Keep a bounded recent history window, with an explicit omission marker. Current
 * read facts plus prose remain below this budget before another model call is allowed. */
export function assistantHistory(messages: readonly AssistantContextMessage[]): AssistantContextMessage[] {
  const recent = [...messages];
  let omitted = false;
  while (recent.length > 1 && Buffer.byteLength(JSON.stringify(recent), 'utf8') > MAX_ASSISTANT_HISTORY_BYTES - 512) {
    recent.shift();
    omitted = true;
  }
  if (omitted) recent.unshift({ role: 'assistant', kind: 'text', text: '较早的对话明细未包含在本轮上下文中。需要那些记录时，请用工具重新读取，不能猜测缺少的事实。' });
  return recent;
}

export function assistantRetiredAllocationInput(name: string, args: AssistantJsonObject): boolean {
  return name === 'salary.create' && ['templateId', 'allocations', 'replaceAllocations', 'moduleAllocations'].some((key) => key in args);
}

export function assistantReadIdentity(name: string, args: AssistantJsonObject): string {
  return `${name}:${canonicalFinancialPayload(args)}`;
}

/** Only known business validation failures get a bounded model correction opportunity. */
export function assistantCanCorrectTool(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const failure = error as Error & { code?: unknown; statusCode?: unknown };
  if (![400, 404, 409].includes(Number(failure.statusCode)) || typeof failure.code !== 'string') return false;
  if (/(?:CANCEL|ABORT|TIMEOUT|BUSY|ACTIVE|AUTH|SESSION)/.test(failure.code)) return false;
  return /^(?:ASSISTANT_INVALID|ASSISTANT_NOT_FOUND|ASSISTANT_ACTION_STALE|ASSISTANT_WORKSPACE_INVALID|TRANSACTION_|ACCOUNT_|CATEGORY_|TAG_|SALARY_|TRANSFER_|RECURRING_|TEMPLATE_|ITEM_|FINANCIAL_)/.test(failure.code);
}

/** Expected organization states get fixed, actionable replies without retrying inference
 * or exposing the service's error text. Codes and HTTP status must both match. */
export function assistantExpectedToolReply(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const failure = error as Error & { code?: unknown; statusCode?: unknown };
  const replies: Readonly<Record<string, readonly [number, string]>> = {
    AI_ORGANIZATION_OVER_CAP: [400, '一次最多整理 500 笔账单。请缩小日期范围后分批分析，本次尚未启动新任务，账本没有改动。'],
    AI_ORGANIZATION_RUNS_INVALID: [400, '整理任务参数不完整或日期范围无效，请明确起止日期或要继续的任务，账本没有改动。'],
    AI_ORGANIZATION_INVALID: [400, '整理请求中的选择或范围无效，请核对后重新预览，账本没有改动。'],
    AI_ORGANIZATION_RUN_NOT_FOUND: [404, '没有找到这个整理任务。请从已有任务卡片继续，或提供日期范围重新分析，账本没有改动。'],
    AI_ORGANIZATION_NOT_READY: [409, '整理任务尚未完成，请在原任务卡片查看进度；完成后再读取建议，账本没有改动。'],
    AI_ORGANIZATION_CONFLICT: [409, '账本或整理建议已经变化，请重新读取预览后再选择和确认，本次没有执行修改。'],
    AI_ORGANIZATION_BUSY: [409, '已有整理任务正在分析，请在原任务卡片查看进度。本次请求的新范围尚未启动，账本没有改动。'],
    AI_ORGANIZATION_OPERATION_NOT_FOUND: [404, '没有找到这个整理操作。请重新读取整理记录并核对操作编号，本次没有执行修改。'],
  };
  if (typeof failure.code !== 'string') return null;
  const reply = replies[failure.code];
  return reply !== undefined && failure.statusCode === reply[0] ? reply[1] : null;
}

/** A scheduled job is a completed chat answer. Its progress belongs to the client job card. */
export function assistantBackgroundReply(result: AssistantToolResult): string | null {
  if (!['spending.preview', 'spending.status', 'spending.resume', 'spending.card'].includes(result.toolName)) return null;
  const run = result.data['run'];
  if (typeof run !== 'object' || run === null || Array.isArray(run) || !('runId' in run) || typeof run.runId !== 'string' || !('status' in run)) return null;
  switch (run.status) {
    case 'running': return '历史账单整理正在后台进行，请在任务卡中查看进度；完成后可读取并选择建议。账本尚未修改。';
    case 'ready': return '历史账单整理建议已准备好，请在任务卡中查看并选择；确认前不会修改账本。';
    case 'failed':
    case 'interrupted': return '历史账单整理暂未完成，请在任务卡中查看原因，确认后可继续剩余分析。账本尚未修改。';
    case 'cancelled': return '历史账单整理任务已取消，账本尚未修改。';
    default: return '历史账单整理任务状态已读取，请在任务卡中继续查看。账本尚未修改。';
  }
}
