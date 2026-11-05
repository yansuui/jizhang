import { createRouteServices, type TenantContextManager } from '../tenancy/context.js';
/**
 * Data portability routes (T15 PRD R1–R3).
 *
 *   GET  /api/v1/export/transactions.csv   bills, with isRefund so net expense is reproducible
 *   GET  /api/v1/export/salaries.csv       salary records with their allocation snapshot
 *   GET  /api/v1/export/recurring.csv      recurring rules
 *   GET  /api/v1/export/transfers.csv      account-to-account transfers
 *   POST /api/v1/import/transactions       import a transactions CSV (body is the file text)
 *   POST /api/v1/import/transfers          import a transfers CSV (body is the file text)
 *   POST /api/v1/import/platform-bills     WeChat/Alipay bill import (bytes or CSV text)
 *   GET  /api/v1/backups                   list archives (file names only)
 *   POST /api/v1/backups                   take an archive now
 *
 * ## Why the CSV is served under /api even though the spec forbids HTML there
 *
 * The rule is "never answer an `/api` path with the SPA shell", because a client asking for
 * JSON must not receive HTML. A CSV download is neither: it is a deliberate file response
 * with `text/csv` and an attachment disposition. Serving it from `/api` keeps it behind the
 * same session guard as everything else, which matters more than the letter of the rule.
 *
 * ## Why the import body is raw text rather than multipart
 *
 * `multipart/form-data` needs `@fastify/multipart`, and a CSV is text. The client reads the
 * chosen file with `File.text()` and posts it with `Content-Type: text/csv`. The body size
 * limit still applies, and exceeding it produces a clear 413 rather than a truncated file.
 *
 * ## Why there is no restore endpoint
 *
 * `restoreBackup` requires the server to be stopped — it replaces the database file, and
 * doing that under a live process leaves the connection holding a deleted inode while WAL
 * writers keep writing to it. A button inside the app cannot stop the app. The UI therefore
 * prints the command instead; see `spec/backend/quality-guidelines.md`.
 *
 * Registered inside the auth module (see `app.ts`), so the guard covers all of it.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/index.js';
import { PortabilityService } from '../services/portability-service.js';
import { ValidationError } from '../services/transaction-service.js';

export interface PortabilityRoutesOptions {
  readonly tenants?: TenantContextManager | undefined;
  readonly db: Db;
  readonly dataDir: string;
  readonly dbFile?: string | undefined;
  readonly actorId?: string | undefined;
  readonly now?: (() => number) | undefined;
}

/** A CSV download: attachment, correct type, and explicitly not cacheable. */
function sendCsv(reply: FastifyReply, fileName: string, body: string): FastifyReply {
  return reply
    .header('Content-Type', 'text/csv; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="${fileName}"`)
    .send(body);
}

export async function registerPortabilityRoutes(
  app: FastifyInstance,
  options: PortabilityRoutesOptions,
): Promise<void> {
  const getServices = createRouteServices(app, options, (options, _lifecycle) => {
    const service = new PortabilityService(options.db, { dataDir: options.dataDir, dbFile: options.dbFile, actorId: options.actorId });

    // ── export ─────────────────────────────────────────────────────────────────

    return { service, options };
  });

  app.get(
    '/api/v1/export/transactions.csv',
    async (_request: FastifyRequest, reply: FastifyReply) =>
      {
      const { service } = getServices(_request);
      return sendCsv(reply, 'jizhang-transactions.csv', service.exportTransactionsCsv());
    },
  );

  app.get(
    '/api/v1/export/salaries.csv',
    async (_request: FastifyRequest, reply: FastifyReply) =>
      {
      const { service } = getServices(_request);
      return sendCsv(reply, 'jizhang-salaries.csv', service.exportSalariesCsv());
    },
  );

  app.get(
    '/api/v1/export/recurring.csv',
    async (_request: FastifyRequest, reply: FastifyReply) =>
      {
      const { service } = getServices(_request);
      return sendCsv(reply, 'jizhang-recurring.csv', service.exportRecurringCsv());
    },
  );

  app.get(
    '/api/v1/export/transfers.csv',
    async (_request: FastifyRequest, reply: FastifyReply) =>
      {
      const { service } = getServices(_request);
      return sendCsv(reply, 'jizhang-transfers.csv', service.exportTransfersCsv());
    },
  );

  // ── import ─────────────────────────────────────────────────────────────────
  app.post(
    '/api/v1/import/transactions',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { service } = getServices(request);
      const body = request.body;
      if (typeof body !== 'string' || body.trim() === '') {
        throw new ValidationError(
          'Send the CSV file contents as the request body with Content-Type: text/csv.',
        );
      }
      return reply.send(service.importTransactionsCsv(body));
    },
  );

  app.post(
    '/api/v1/import/transfers',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { service } = getServices(request);
      const body = request.body;
      if (typeof body !== 'string' || body.trim() === '') {
        throw new ValidationError(
          'Send the CSV file contents as the request body with Content-Type: text/csv.',
        );
      }
      return reply.send(service.importTransfersCsv(body));
    },
  );

  /**
   * WeChat / Alipay platform bill import.
   *
   * Two body shapes:
   *   1. Raw bytes (`application/octet-stream` / xlsx) or UTF-8 CSV text — full-file import.
   *      Query: `source=auto|wechat|alipay`, `dryRun=1`.
   *   2. JSON — used by the preview/confirm UI:
   *      `{ fileBase64 | text, source, dryRun, fileName, selectedIds?, categoryOverrides? }`.
   *      `selectedIds: null` = all importable; `[]` = none; overrides map row id → category name.
   *
   * GBK Alipay exports must arrive as bytes/base64 — `File.text()` would corrupt them.
   */
  app.post(
    '/api/v1/import/platform-bills',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { service } = getServices(request);
      const query = request.query as { source?: string; dryRun?: string; fileName?: string };
      const body = request.body;

      const parseSource = (raw: unknown): 'auto' | 'wechat' | 'alipay' => {
        const value = typeof raw === 'string' && raw !== '' ? raw : 'auto';
        if (value !== 'auto' && value !== 'wechat' && value !== 'alipay') {
          throw new ValidationError('source must be auto, wechat, or alipay.');
        }
        return value;
      };
      const parseDryRun = (raw: unknown, fromQuery?: string): boolean => {
        if (typeof raw === 'boolean') return raw;
        if (typeof raw === 'string') return raw === '1' || raw === 'true';
        return fromQuery === '1' || fromQuery === 'true';
      };

      if (body !== null && typeof body === 'object' && !Buffer.isBuffer(body) && !Array.isArray(body)) {
        const json = body as {
          fileBase64?: unknown;
          text?: unknown;
          source?: unknown;
          dryRun?: unknown;
          fileName?: unknown;
          selectedIds?: unknown;
          categoryOverrides?: unknown;
        };

        let payload: Buffer | string;
        if (typeof json.fileBase64 === 'string' && json.fileBase64 !== '') {
          payload = Buffer.from(json.fileBase64, 'base64');
        } else if (typeof json.text === 'string' && json.text.trim() !== '') {
          payload = json.text;
        } else {
          throw new ValidationError(
            'JSON body requires fileBase64 (raw bill bytes) or text (UTF-8 CSV).',
          );
        }

        let selectedIds: string[] | null | undefined;
        if (json.selectedIds === undefined || json.selectedIds === null) {
          selectedIds = json.selectedIds === null ? null : undefined;
        } else if (Array.isArray(json.selectedIds)) {
          selectedIds = json.selectedIds.map((id) => String(id));
        } else {
          throw new ValidationError('selectedIds must be an array of ids or null.');
        }

        let categoryOverrides: Record<string, string> | undefined;
        if (json.categoryOverrides !== undefined && json.categoryOverrides !== null) {
          if (typeof json.categoryOverrides !== 'object' || Array.isArray(json.categoryOverrides)) {
            throw new ValidationError('categoryOverrides must be an object of id → category name.');
          }
          categoryOverrides = {};
          for (const [id, name] of Object.entries(json.categoryOverrides as Record<string, unknown>)) {
            if (typeof name === 'string' && name.trim() !== '') categoryOverrides[id] = name.trim();
          }
        }

        return reply.send(
          service.importPlatformBills(payload, {
            source: parseSource(json.source ?? query.source),
            dryRun: parseDryRun(json.dryRun, query.dryRun),
            fileName:
              typeof json.fileName === 'string' && json.fileName !== ''
                ? json.fileName
                : typeof query.fileName === 'string'
                  ? query.fileName
                  : undefined,
            selectedIds,
            categoryOverrides,
          }),
        );
      }

      const sourceRaw = parseSource(query.source);
      const dryRun = parseDryRun(undefined, query.dryRun);

      let payload: Buffer | string;
      if (Buffer.isBuffer(body)) {
        payload = body;
      } else if (typeof body === 'string' && body.trim() !== '') {
        payload = body;
      } else {
        throw new ValidationError(
          'Send the bill file as the request body (CSV text, raw bytes, or JSON with fileBase64).',
        );
      }

      return reply.send(
        service.importPlatformBills(payload, {
          source: sourceRaw,
          dryRun,
          fileName: typeof query.fileName === 'string' ? query.fileName : undefined,
        }),
      );
    },
  );

  // ── backups ────────────────────────────────────────────────────────────────
  app.get('/api/v1/backups', async (_request: FastifyRequest, reply: FastifyReply) => {
      const { service } = getServices(_request);
    return reply.send({ items: service.listBackups() });
  });

  app.post('/api/v1/backups', async (_request: FastifyRequest, reply: FastifyReply) => {
      const { service } = getServices(_request);
    return reply.status(201).send(service.createBackupNow());
  });
}
