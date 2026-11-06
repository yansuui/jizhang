import { createHash } from 'node:crypto';
import type { AssistantToolContext } from './assistant-tool-registry.js';
import { assistantJsonObject, type AssistantJsonObject } from './assistant-types.js';
import { ItemService } from './item-service.js';
import { workspaceError, workspaceOnly, workspaceRecord, workspaceString } from './assistant-workspace-store.js';

/** Native clients submit identifiers, never prose, secrets or file contents as evidence. */
export type NativeCompletionReference =
  | { kind: 'csv-import'; previewId: string }
  | { kind: 'platform-import'; batchId: string }
  | { kind: 'item-photo'; itemId: string; operation: 'saved' | 'viewed'; sha256: string }
  | { kind: 'item-photo'; itemId: string; operation: 'removed' }
  | { kind: 'export'; exportKind: 'transactions' | 'salaries' | 'recurring' | 'transfers' };

export function nativeCompletionReference(raw: unknown): NativeCompletionReference {
  const r = workspaceRecord(raw);
  switch (r['kind']) {
    case 'csv-import':
      workspaceOnly(r, ['kind', 'previewId']); return { kind: r['kind'], previewId: workspaceString(r['previewId']) };
    case 'platform-import':
      workspaceOnly(r, ['kind', 'batchId']); return { kind: r['kind'], batchId: workspaceString(r['batchId']) };
    case 'item-photo': {
      workspaceOnly(r, ['kind', 'itemId', 'operation', 'sha256']);
      const itemId = workspaceString(r['itemId']);
      if (r['operation'] === 'removed' && r['sha256'] === undefined) return { kind: r['kind'], itemId, operation: 'removed' };
      if ((r['operation'] === 'saved' || r['operation'] === 'viewed') && typeof r['sha256'] === 'string' && /^[a-f0-9]{64}$/.test(r['sha256'])) return { kind: r['kind'], itemId, operation: r['operation'], sha256: r['sha256'] };
      break;
    }
    case 'export': {
      workspaceOnly(r, ['kind', 'exportKind']);
      const kind = r['exportKind'];
      if (kind === 'transactions' || kind === 'salaries' || kind === 'recurring' || kind === 'transfers') return { kind: r['kind'], exportKind: kind };
    }
  }
  return workspaceError(400, 'INVALID', '原生操作回执类型无效。');
}

export function nativeCompletionMatches(action: Record<string, unknown>, reference: NativeCompletionReference): boolean {
  switch (reference.kind) {
    case 'csv-import': return action['destination'] === 'data-import';
    case 'platform-import': return action['destination'] === 'platform-import';
    case 'export': return action['destination'] === 'data-export';
    case 'item-photo': return (action['destination'] === 'item-photo' || action['destination'] === 'item-cutout') && action['itemId'] === reference.itemId;
  }
}

function receiptCounts(raw: string, keys: readonly string[]): AssistantJsonObject {
  const result = workspaceRecord(JSON.parse(raw));
  const counts: Record<string, number> = {};
  for (const key of keys) {
    const value = result[key];
    if (typeof value === 'number' && Number.isSafeInteger(value)) counts[key] = value;
  }
  if (typeof counts['inserted'] !== 'number') workspaceError(409, 'STALE', '没有可核实的成功导入回执。');
  return counts;
}

/** Reads authoritative tenant state. It performs no native/financial mutation. */
export function verifyNativeCompletion(c: AssistantToolContext, conversationId: string, reference: NativeCompletionReference, sourceCreatedAt: number): AssistantJsonObject {
  switch (reference.kind) {
    case 'csv-import': {
      const row = c.db.prepare('SELECT kind,result_json,confirmed_at FROM assistant_csv_previews WHERE id=?').get(reference.previewId) as { kind: string; result_json: string | null; confirmed_at: number | null } | undefined;
      if (!row) workspaceError(404, 'NOT_FOUND', '没有找到这份导入回执。');
      if (!row.result_json) workspaceError(409, 'STALE', '导入尚未确认成功，请先在原生页面核对。');
      if (row.confirmed_at === null || row.confirmed_at < sourceCreatedAt) workspaceError(409, 'STALE', '这是先前任务的导入回执，请完成当前请求的导入后继续。');
      return { ...reference, importKind: row.kind, verified: 'confirmed-import', result: receiptCounts(row.result_json, ['inserted', 'skipped', 'total']) };
    }
    case 'platform-import': {
      const row = c.db.prepare('SELECT status,result_json,updated_at FROM assistant_import_batches WHERE id=? AND conversation_id=?').get(reference.batchId, conversationId) as { status: string; result_json: string | null; updated_at: number } | undefined;
      if (!row) workspaceError(404, 'NOT_FOUND', '没有找到当前会话的导入批次。');
      if (row.status !== 'confirmed' || !row.result_json) workspaceError(409, 'STALE', '导入批次尚未确认成功，请先完成核对。');
      if (row.updated_at < sourceCreatedAt) workspaceError(409, 'STALE', '这是先前任务的导入批次，请核对当前任务。');
      return { ...reference, verified: 'confirmed-import', result: receiptCounts(row.result_json, ['inserted', 'selected', 'excluded', 'preexisting', 'expenseCents', 'incomeCents', 'accountsCreated', 'categoriesCreated', 'categoriesReused', 'categoriesSkippedUnused']) };
    }
    case 'item-photo': {
      const service = new ItemService(c.db, { now: c.now, actorId: c.actorId });
      if (!service.getById(reference.itemId)) workspaceError(404, 'NOT_FOUND', '没有找到当前物品。');
      const photo = service.getPhoto(reference.itemId);
      if (reference.operation === 'removed') {
        if (photo) workspaceError(409, 'STALE', '当前物品仍有图片，请重新核对。');
        return { ...reference, verified: 'current-state', hasPhoto: false, attribution: '仅核实当前图片不存在，不能据此推断操作来源。' };
      }
      if (!photo || createHash('sha256').update(photo.bytes).digest('hex') !== reference.sha256) workspaceError(409, 'STALE', '当前图片已变化，请重新核对后继续。');
      return { ...reference, verified: 'current-state', hasPhoto: true, mimeType: photo.mimeType, byteLength: photo.bytes.length, attribution: '仅核实服务器当前图片与所选摘要一致，不能据此推断操作来源。' };
    }
    case 'export': {
      const p = c.services.portability;
      const csv = reference.exportKind === 'transactions' ? p.exportTransactionsCsv() : reference.exportKind === 'salaries' ? p.exportSalariesCsv() : reference.exportKind === 'recurring' ? p.exportRecurringCsv() : p.exportTransfersCsv();
      return assistantJsonObject({ ...reference, verified: 'server-read', byteLength: Buffer.byteLength(csv), sha256: createHash('sha256').update(csv).digest('hex'), attribution: '仅核实服务器当前可生成导出文件；不能证明设备已保存或系统分享已完成。' }, '导出事实');
    }
  }
}
