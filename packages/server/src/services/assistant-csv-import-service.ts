import { randomUUID } from 'node:crypto';
import { parseCsvWithHeader } from '@jizhang/shared';
import type { AssistantToolContext } from './assistant-tool-registry.js';
import { simulateAssistantWrite } from './assistant-business-tools.js';
import { hashWorkspace, ledgerFingerprint, workspaceError, workspaceOnly, workspaceRecord, workspaceString } from './assistant-workspace-store.js';

interface CsvPreviewRow { id: string; kind: string; file_hash: string; request_hash: string; fingerprint: string; preview_json: string; result_json: string | null; expires_at: number }
/** Trusted native CSV review. File text is never supplied to the model or chat history. */
export class AssistantCsvImportService {
  constructor(private readonly context: AssistantToolContext) {}
  private csv(raw: unknown): string {
    if (typeof raw !== 'string' || !raw.trim() || Buffer.byteLength(raw) > 2 * 1024 * 1024) workspaceError(400, 'INVALID', '请选择不超过2 MB的账本CSV文件。');
    return raw;
  }
  preview(raw: unknown): { preview: unknown } {
    const body = workspaceRecord(raw); workspaceOnly(body, ['kind', 'csv', 'clientRequestId']);
    const kind = body['kind']; if (kind !== 'transactions' && kind !== 'transfers') workspaceError(400, 'INVALID', '导入类型无效。');
    const csv = this.csv(body['csv']); const requestId = workspaceString(body['clientRequestId']);
    const requestHash = hashWorkspace({ kind, csv });
    const existing = this.context.db.prepare('SELECT * FROM assistant_csv_previews WHERE request_id=?').get(requestId) as CsvPreviewRow | undefined;
    if (existing) {
      if (existing.request_hash !== requestHash) workspaceError(409, 'CONFLICT', '这个请求编号已用于其他文件。');
      return { preview: JSON.parse(existing.preview_json) };
    }
    const parsed = parseCsvWithHeader(csv);
    const result = simulateAssistantWrite(this.context, () => kind === 'transactions' ? this.context.services.portability.importTransactionsCsv(csv) : this.context.services.portability.importTransfersCsv(csv));
    const id = randomUUID(); const expiresAt = this.context.now() + 1200000;
    // Bound every cell and total response independently from the raw original file.
    const preview = { id, kind, expiresAt, columns: parsed.header, rows: parsed.records.slice(0, 100).map((row) => parsed.header.map((key) => {
      const cell = row[key] ?? ''; return cell.length > 200 ? `${cell.slice(0, 199)}…` : cell;
    })), totalRows: parsed.records.length, rowsOmitted: parsed.records.length > 100, textSummarized: parsed.records.slice(0, 100).some((row) => Object.values(row).some((v) => v.length > 200)), result };
    this.context.db.prepare('INSERT INTO assistant_csv_previews(id,request_id,request_hash,kind,file_hash,fingerprint,preview_json,expires_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, requestId, requestHash, kind, hashWorkspace(csv), ledgerFingerprint(this.context), JSON.stringify(preview), expiresAt);
    return { preview };
  }
  confirm(id: string, raw: unknown): { result: unknown } {
    const body = workspaceRecord(raw); workspaceOnly(body, ['csv']); const csv = this.csv(body['csv']);
    return this.context.db.transaction(() => {
      const row = this.context.db.prepare('SELECT * FROM assistant_csv_previews WHERE id=?').get(id) as CsvPreviewRow | undefined;
      if (!row) workspaceError(404, 'NOT_FOUND', '没有找到这份导入预览。');
      if (row.file_hash !== hashWorkspace(csv)) workspaceError(409, 'CONFLICT', '文件与已审核预览不同，请重新预览。');
      if (row.result_json !== null) return { result: JSON.parse(row.result_json) as unknown };
      if (row.expires_at < this.context.now() || row.fingerprint !== ledgerFingerprint(this.context)) workspaceError(409, 'STALE', '账本或预览已变化，请重新审核后确认。');
      const result = row.kind === 'transactions' ? this.context.services.portability.importTransactionsCsv(csv) : this.context.services.portability.importTransfersCsv(csv);
      this.context.db.prepare('UPDATE assistant_csv_previews SET result_json=?,confirmed_at=? WHERE id=?').run(JSON.stringify(result), this.context.now(), id);
      return { result };
    })();
  }
}
