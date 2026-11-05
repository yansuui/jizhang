/** Personal item records, lifecycle metrics, and bounded photo persistence. */
import { dateOnly, TYPE_EXPENSE, TYPE_INCOME } from '@jizhang/shared';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import {
  ConflictError,
  escapeLikePattern,
  NotFoundError,
  TransactionService,
  ValidationError,
} from './transaction-service.js';

export const ITEM_STATUSES = ['active', 'idle', 'sold', 'retired'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export type ItemPhotoMime = 'image/jpeg' | 'image/png' | 'image/webp';

const MAX_ITEM_NAME_LENGTH = 120;
const MAX_ITEM_CATEGORY_LENGTH = 60;
const MAX_ITEM_TEXT_LENGTH = 500;
export const MAX_ITEM_PHOTO_BYTES = 2 * 1024 * 1024;
const MAX_ITEM_PHOTO_PIXELS = 40_000_000;
const DEFAULT_ITEM_PAGE_SIZE = 50;
const MAX_ITEM_PAGE_SIZE = 200;
const DAY_MS = 86_400_000;

interface ItemRow {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly brand: string;
  readonly model: string;
  readonly note: string;
  readonly purchase_price_cents: number | null;
  readonly purchase_date: number;
  readonly status: ItemStatus;
  readonly closed_date: number | null;
  readonly sale_price_cents: number | null;
  readonly purchase_transaction_id: string | null;
  readonly sale_transaction_id: string | null;
  readonly deleted: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly has_photo?: number;
}

interface ItemPhotoRow {
  readonly mime_type: ItemPhotoMime;
  readonly image_bytes: Buffer;
}

export interface ItemDto {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly brand: string;
  readonly model: string;
  readonly note: string;
  readonly purchasePriceCents: number | null;
  readonly purchaseDate: number;
  readonly status: ItemStatus;
  readonly closedDate: number | null;
  readonly salePriceCents: number | null;
  readonly purchaseTransactionId: string | null;
  readonly saleTransactionId: string | null;
  readonly photoUrl: string | null;
  readonly heldDays: number;
  readonly netCostCents: number | null;
  readonly dailyCostCents: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ItemListDto {
  readonly items: ItemDto[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface ItemSummaryDto {
  readonly totalItems: number;
  readonly activeItems: number;
  readonly idleItems: number;
  readonly soldItems: number;
  readonly retiredItems: number;
  /** Recorded purchase amounts across all live item records, not cash/account assets. */
  readonly cumulativePurchaseCents: number;
  /** Current daily cost for active/idle items with known prices and non-zero holding time. */
  readonly currentDailyCostCents: number;
}

export interface ItemListQuery {
  readonly status?: unknown;
  readonly category?: unknown;
  readonly q?: unknown;
  readonly limit?: unknown;
  readonly offset?: unknown;
}

export interface ItemPhoto {
  readonly mimeType: ItemPhotoMime;
  readonly bytes: Buffer;
}

export interface ItemServiceOptions {
  readonly now?: (() => number) | undefined;
  readonly actorId?: string | undefined;
}

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(label + ' must be an object.');
  }
  return value as Record<string, unknown>;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(field + ' is required.');
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new ValidationError(field + ' must be at most ' + maxLength + ' characters.');
  }
  return trimmed;
}

function optionalText(value: unknown, field: string, maxLength: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ValidationError(field + ' must be text.');
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new ValidationError(field + ' must be at most ' + maxLength + ' characters.');
  }
  return trimmed;
}

function optionalCents(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError(field + ' must be a non-negative integer number of cents.');
  }
  return value;
}

function requiredDate(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError(field + ' must be a valid local-date epoch timestamp.');
  }
  return dateOnly(value);
}

function optionalId(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim() === '' || value.length > 100) {
    throw new ValidationError(field + ' must be a valid id or null.');
  }
  return value.trim();
}

function requireStatus(value: unknown, field = 'status'): ItemStatus {
  if (typeof value !== 'string' || !ITEM_STATUSES.includes(value as ItemStatus)) {
    throw new ValidationError(field + ' must be active, idle, sold, or retired.');
  }
  return value as ItemStatus;
}

function requirePageInteger(value: unknown, field: string, fallback: number, max: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) {
    throw new ValidationError(field + ' must be an integer between 0 and ' + max + '.');
  }
  return parsed;
}

function daysBetweenLocalDates(startDate: number, endDate: number): number {
  const start = new Date(dateOnly(startDate));
  const end = new Date(dateOnly(endDate));
  const startUtc = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const endUtc = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.max(0, Math.round((endUtc - startUtc) / DAY_MS));
}

function rowToDto(row: ItemRow, now: number): ItemDto {
  const terminal = row.status === 'sold' || row.status === 'retired';
  const endDate = terminal ? (row.closed_date ?? now) : now;
  const heldDays = daysBetweenLocalDates(row.purchase_date, endDate);
  let netCostCents: number | null = row.purchase_price_cents;
  if (row.status === 'sold') {
    netCostCents =
      row.purchase_price_cents === null || row.sale_price_cents === null
        ? null
        : row.purchase_price_cents - row.sale_price_cents;
  }
  const dailyCostCents =
    netCostCents === null || heldDays === 0 ? null : Math.round(netCostCents / heldDays);

  return {
    id: row.id,
    name: row.name,
    category: row.category,
    brand: row.brand,
    model: row.model,
    note: row.note,
    purchasePriceCents: row.purchase_price_cents,
    purchaseDate: row.purchase_date,
    status: row.status,
    closedDate: row.closed_date,
    salePriceCents: row.sale_price_cents,
    purchaseTransactionId: row.purchase_transaction_id,
    saleTransactionId: row.sale_transaction_id,
    photoUrl: row.has_photo === 1 ? '/api/v1/items/' + encodeURIComponent(row.id) + '/photo' : null,
    heldDays,
    netCostCents,
    dailyCostCents,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

function imageDimensions(bytes: Buffer, mimeType: string): ImageDimensions | null {
  if (mimeType === 'image/jpeg') {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    const startOfFrame = new Set([
      0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
    ]);
    let offset = 2;
    while (offset + 1 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset];
      offset += 1;
      if (marker === undefined || marker === 0xd9 || marker === 0xda) return null;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) return null;
      const segmentLength = bytes.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
      if (startOfFrame.has(marker)) {
        if (segmentLength < 7) return null;
        return {
          height: bytes.readUInt16BE(offset + 3),
          width: bytes.readUInt16BE(offset + 5),
        };
      }
      offset += segmentLength;
    }
    return null;
  }
  if (mimeType === 'image/png') {
    if (
      bytes.length < 24 ||
      bytes[0] !== 0x89 ||
      bytes.toString('ascii', 1, 4) !== 'PNG' ||
      bytes[4] !== 0x0d ||
      bytes[5] !== 0x0a ||
      bytes[6] !== 0x1a ||
      bytes[7] !== 0x0a ||
      bytes.toString('ascii', 12, 16) !== 'IHDR'
    ) {
      return null;
    }
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mimeType === 'image/webp') {
    if (
      bytes.length < 21 ||
      bytes.toString('ascii', 0, 4) !== 'RIFF' ||
      bytes.toString('ascii', 8, 12) !== 'WEBP'
    ) {
      return null;
    }
    const chunk = bytes.toString('ascii', 12, 16);
    if (chunk === 'VP8X' && bytes.length >= 30) {
      return {
        width: 1 + bytes.readUIntLE(24, 3),
        height: 1 + bytes.readUIntLE(27, 3),
      };
    }
    if (
      chunk === 'VP8 ' &&
      bytes.length >= 30 &&
      bytes[23] === 0x9d &&
      bytes[24] === 0x01 &&
      bytes[25] === 0x2a
    ) {
      return {
        width: bytes.readUInt16LE(26) & 0x3fff,
        height: bytes.readUInt16LE(28) & 0x3fff,
      };
    }
    if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
      const b1 = bytes[21];
      const b2 = bytes[22];
      const b3 = bytes[23];
      const b4 = bytes[24];
      if (b1 === undefined || b2 === undefined || b3 === undefined || b4 === undefined) return null;
      return {
        width: 1 + (b1 | ((b2 & 0x3f) << 8)),
        height: 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)),
      };
    }
    return null;
  }
  return null;
}

/** Shared binary-photo validation for both persistent photos and transient cutout input. */
export function validateItemPhotoBytes(mimeType: string, bytes: Buffer): ItemPhotoMime {
  if (mimeType !== 'image/jpeg' && mimeType !== 'image/png' && mimeType !== 'image/webp') {
    throw new ValidationError('图片格式必须为 JPEG、PNG 或 WebP。');
  }
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new ValidationError('图片内容为空。');
  }
  if (bytes.length > MAX_ITEM_PHOTO_BYTES) throw new ItemPhotoTooLargeError();

  const dimensions = imageDimensions(bytes, mimeType);
  if (dimensions === null || dimensions.width < 1 || dimensions.height < 1) {
    throw new ValidationError('图片内容与格式不匹配，请使用 JPEG、PNG 或 WebP 图片。');
  }
  if (dimensions.width * dimensions.height > MAX_ITEM_PHOTO_PIXELS) {
    throw new ValidationError('图片尺寸不能超过 4000 万像素。');
  }
  return mimeType;
}

/** Single source for item CRUD, ledger-reference checks, image persistence, and cost math. */
export class ItemService {
  private readonly db: Db;
  private readonly now: () => number;
  private readonly transactions: TransactionService;

  constructor(db: Db, options: ItemServiceOptions = {}) {
    this.db = db;
    this.now = options.now ?? (() => Date.now());
    this.transactions = new TransactionService(db, { now: this.now, actorId: options.actorId });
  }

  list(query: ItemListQuery = {}): ItemListDto {
    const status =
      query.status === undefined || query.status === '' ? undefined : requireStatus(query.status);
    const category =
      query.category === undefined || query.category === ''
        ? undefined
        : requiredText(query.category, 'category', MAX_ITEM_CATEGORY_LENGTH);
    const q = typeof query.q === 'string' ? query.q.trim() : '';
    if (q.length > 100) throw new ValidationError('q must be at most 100 characters.');
    const limit = requirePageInteger(
      query.limit,
      'limit',
      DEFAULT_ITEM_PAGE_SIZE,
      MAX_ITEM_PAGE_SIZE,
    );
    if (limit === 0) throw new ValidationError('limit must be greater than zero.');
    const offset = requirePageInteger(query.offset, 'offset', 0, 1_000_000);

    const where = ['i.deleted = 0'];
    const params: (string | number)[] = [];
    if (status !== undefined) {
      where.push('i.status = ?');
      params.push(status);
    }
    if (category !== undefined) {
      where.push('i.category = ?');
      params.push(category);
    }
    if (q !== '') {
      const pattern = '%' + escapeLikePattern(q) + '%';
      where.push(
        '(i.name LIKE ? ESCAPE char(92) OR i.category LIKE ? ESCAPE char(92) OR i.brand LIKE ? ESCAPE char(92) OR i.model LIKE ? ESCAPE char(92) OR i.note LIKE ? ESCAPE char(92))',
      );
      params.push(pattern, pattern, pattern, pattern, pattern);
    }
    const filter = where.join(' AND ');
    const total = (
      this.db
        .prepare('SELECT COUNT(*) AS total FROM asset_items i WHERE ' + filter)
        .get(...params) as {
        total: number;
      }
    ).total;
    const rows = this.db
      .prepare(
        'SELECT i.*, EXISTS(SELECT 1 FROM asset_item_photos p WHERE p.item_id = i.id) AS has_photo ' +
          'FROM asset_items i WHERE ' +
          filter +
          ' ORDER BY i.purchase_date DESC, i.updated_at DESC, i.id LIMIT ? OFFSET ?',
      )
      .all(...params, limit, offset) as ItemRow[];
    const now = this.now();
    return { items: rows.map((row) => rowToDto(row, now)), total, limit, offset };
  }

  summary(): ItemSummaryDto {
    const rows = this.db
      .prepare('SELECT * FROM asset_items WHERE deleted = 0 ORDER BY id')
      .all() as ItemRow[];
    const now = this.now();
    let activeItems = 0;
    let idleItems = 0;
    let soldItems = 0;
    let retiredItems = 0;
    let cumulativePurchaseCents = 0;
    let currentDailyCostCents = 0;
    for (const row of rows) {
      if (row.status === 'active') activeItems += 1;
      else if (row.status === 'idle') idleItems += 1;
      else if (row.status === 'sold') soldItems += 1;
      else retiredItems += 1;
      if (row.purchase_price_cents !== null) cumulativePurchaseCents += row.purchase_price_cents;
      if (row.status === 'active' || row.status === 'idle') {
        currentDailyCostCents += rowToDto(row, now).dailyCostCents ?? 0;
      }
    }
    return {
      totalItems: rows.length,
      activeItems,
      idleItems,
      soldItems,
      retiredItems,
      cumulativePurchaseCents,
      currentDailyCostCents,
    };
  }

  getById(id: string): ItemDto | undefined {
    const row = this.db
      .prepare(
        'SELECT i.*, EXISTS(SELECT 1 FROM asset_item_photos p WHERE p.item_id = i.id) AS has_photo ' +
          'FROM asset_items i WHERE i.id = ? AND i.deleted = 0',
      )
      .get(id) as ItemRow | undefined;
    return row === undefined ? undefined : rowToDto(row, this.now());
  }

  getByIdOrThrow(id: string): ItemDto {
    const item = this.getById(id);
    if (item === undefined) throw new NotFoundError('物品不存在。');
    return item;
  }

  create(raw: unknown): ItemDto {
    const input = recordOf(raw, '物品');
    const name = requiredText(input.name, 'name', MAX_ITEM_NAME_LENGTH);
    const category =
      input.category === undefined || input.category === null || input.category === ''
        ? '其他'
        : requiredText(input.category, 'category', MAX_ITEM_CATEGORY_LENGTH);
    const brand = optionalText(input.brand, 'brand', MAX_ITEM_TEXT_LENGTH);
    const model = optionalText(input.model, 'model', MAX_ITEM_TEXT_LENGTH);
    const note = optionalText(input.note, 'note', MAX_ITEM_TEXT_LENGTH);
    const purchasePriceCents = optionalCents(input.purchasePriceCents, 'purchasePriceCents');
    const purchaseDate = requiredDate(input.purchaseDate, 'purchaseDate');
    if (purchaseDate > dateOnly(this.now())) {
      throw new ValidationError('购入日期不能晚于今天。');
    }
    const status = input.status === undefined ? 'active' : requireStatus(input.status);
    if (status !== 'active' && status !== 'idle') {
      throw new ValidationError('新物品状态只能是使用中或闲置。');
    }
    const purchaseTransactionId = optionalId(input.purchaseTransactionId, 'purchaseTransactionId');
    this.assertTransactionLink(purchaseTransactionId, 'purchase');

    const id = randomUUID();
    const now = this.now();
    this.db
      .prepare(
        'INSERT INTO asset_items ' +
          '(id, name, category, brand, model, note, purchase_price_cents, purchase_date, ' +
          'status, closed_date, sale_price_cents, purchase_transaction_id, sale_transaction_id, ' +
          'deleted, created_at, updated_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, 0, ?, ?)',
      )
      .run(
        id,
        name,
        category,
        brand,
        model,
        note,
        purchasePriceCents,
        purchaseDate,
        status,
        purchaseTransactionId,
        now,
        now,
      );
    return this.getByIdOrThrow(id);
  }

  update(id: string, raw: unknown): ItemDto {
    const input = recordOf(raw, '物品');
    const current = this.requireLiveRow(id);
    const name = hasOwn(input, 'name')
      ? requiredText(input.name, 'name', MAX_ITEM_NAME_LENGTH)
      : current.name;
    const category = hasOwn(input, 'category')
      ? requiredText(input.category, 'category', MAX_ITEM_CATEGORY_LENGTH)
      : current.category;
    const brand = hasOwn(input, 'brand')
      ? optionalText(input.brand, 'brand', MAX_ITEM_TEXT_LENGTH)
      : current.brand;
    const model = hasOwn(input, 'model')
      ? optionalText(input.model, 'model', MAX_ITEM_TEXT_LENGTH)
      : current.model;
    const note = hasOwn(input, 'note')
      ? optionalText(input.note, 'note', MAX_ITEM_TEXT_LENGTH)
      : current.note;
    const purchasePriceCents = hasOwn(input, 'purchasePriceCents')
      ? optionalCents(input.purchasePriceCents, 'purchasePriceCents')
      : current.purchase_price_cents;
    const purchaseDate = hasOwn(input, 'purchaseDate')
      ? requiredDate(input.purchaseDate, 'purchaseDate')
      : current.purchase_date;
    if (purchaseDate > dateOnly(this.now())) {
      throw new ValidationError('购入日期不能晚于今天。');
    }
    const purchaseTransactionId = hasOwn(input, 'purchaseTransactionId')
      ? optionalId(input.purchaseTransactionId, 'purchaseTransactionId')
      : current.purchase_transaction_id;
    if (purchaseTransactionId !== current.purchase_transaction_id) {
      this.assertTransactionLink(purchaseTransactionId, 'purchase');
    }

    let status = current.status;
    let closedDate = current.closed_date;
    let salePriceCents = current.sale_price_cents;
    let saleTransactionId = current.sale_transaction_id;
    if (hasOwn(input, 'status')) {
      const requested = requireStatus(input.status);
      if ((requested === 'sold' || requested === 'retired') && requested !== current.status) {
        throw new ValidationError('请通过“售出”或“退役”操作结束物品持有状态。');
      }
      if (
        (current.status === 'sold' || current.status === 'retired') &&
        (requested === 'active' || requested === 'idle')
      ) {
        closedDate = null;
        salePriceCents = null;
        saleTransactionId = null;
      }
      status = requested;
    }
    if (closedDate !== null && purchaseDate > closedDate) {
      throw new ValidationError('购入日期不能晚于售出或退役日期。');
    }

    const now = this.now();
    this.db
      .prepare(
        'UPDATE asset_items SET name = ?, category = ?, brand = ?, model = ?, note = ?, ' +
          'purchase_price_cents = ?, purchase_date = ?, status = ?, closed_date = ?, ' +
          'sale_price_cents = ?, purchase_transaction_id = ?, sale_transaction_id = ?, updated_at = ? ' +
          'WHERE id = ? AND deleted = 0',
      )
      .run(
        name,
        category,
        brand,
        model,
        note,
        purchasePriceCents,
        purchaseDate,
        status,
        closedDate,
        salePriceCents,
        purchaseTransactionId,
        saleTransactionId,
        now,
        id,
      );
    return this.getByIdOrThrow(id);
  }

  sell(id: string, raw: unknown): ItemDto {
    const input = recordOf(raw, '售出信息');
    const current = this.requireLiveRow(id);
    this.assertOpenForClosure(current);
    const closedDate = requiredDate(input.closedDate, 'closedDate');
    this.assertCloseDate(current.purchase_date, closedDate);
    const salePriceCents = optionalCents(input.salePriceCents, 'salePriceCents');
    const saleTransactionId = optionalId(input.saleTransactionId, 'saleTransactionId');
    this.assertTransactionLink(saleTransactionId, 'sale');
    this.db
      .prepare(
        'UPDATE asset_items SET status = ?, closed_date = ?, sale_price_cents = ?, ' +
          'sale_transaction_id = ?, updated_at = ? WHERE id = ? AND deleted = 0',
      )
      .run('sold', closedDate, salePriceCents, saleTransactionId, this.now(), id);
    return this.getByIdOrThrow(id);
  }

  retire(id: string, raw: unknown): ItemDto {
    const input = recordOf(raw, '退役信息');
    const current = this.requireLiveRow(id);
    this.assertOpenForClosure(current);
    const closedDate = requiredDate(input.closedDate, 'closedDate');
    this.assertCloseDate(current.purchase_date, closedDate);
    this.db
      .prepare(
        'UPDATE asset_items SET status = ?, closed_date = ?, sale_price_cents = NULL, ' +
          'sale_transaction_id = NULL, updated_at = ? WHERE id = ? AND deleted = 0',
      )
      .run('retired', closedDate, this.now(), id);
    return this.getByIdOrThrow(id);
  }

  remove(id: string): void {
    const current = this.requireLiveRow(id);
    const updated = this.db
      .prepare('UPDATE asset_items SET deleted = 1, updated_at = ? WHERE id = ? AND deleted = 0')
      .run(this.now(), current.id);
    if (updated.changes !== 1) throw new NotFoundError('物品不存在。');
  }

  putPhoto(id: string, mimeType: string, bytes: Buffer): void {
    this.requireLiveRow(id);
    const validMimeType = validateItemPhotoBytes(mimeType, bytes);
    const now = this.now();
    const write = this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO asset_item_photos (item_id, mime_type, image_bytes, updated_at) ' +
            'VALUES (?, ?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET ' +
            'mime_type = excluded.mime_type, image_bytes = excluded.image_bytes, updated_at = excluded.updated_at',
        )
        .run(id, validMimeType, bytes, now);
      this.db
        .prepare('UPDATE asset_items SET updated_at = ? WHERE id = ? AND deleted = 0')
        .run(now, id);
    });
    write();
  }

  getPhoto(id: string): ItemPhoto | undefined {
    if (this.getById(id) === undefined) return undefined;
    const row = this.db
      .prepare('SELECT mime_type, image_bytes FROM asset_item_photos WHERE item_id = ?')
      .get(id) as ItemPhotoRow | undefined;
    return row === undefined ? undefined : { mimeType: row.mime_type, bytes: row.image_bytes };
  }

  removePhoto(id: string): void {
    this.requireLiveRow(id);
    const remove = this.db.transaction(() => {
      this.db.prepare('DELETE FROM asset_item_photos WHERE item_id = ?').run(id);
      this.db
        .prepare('UPDATE asset_items SET updated_at = ? WHERE id = ? AND deleted = 0')
        .run(this.now(), id);
    });
    remove();
  }

  private requireLiveRow(id: string): ItemRow {
    const row = this.db
      .prepare('SELECT * FROM asset_items WHERE id = ? AND deleted = 0')
      .get(id) as ItemRow | undefined;
    if (row === undefined) throw new NotFoundError('物品不存在。');
    return row;
  }

  private assertOpenForClosure(row: ItemRow): void {
    if (row.status !== 'active' && row.status !== 'idle') {
      throw new ConflictError('只有使用中或闲置的物品可以售出或退役。');
    }
  }

  private assertCloseDate(purchaseDate: number, closedDate: number): void {
    const today = dateOnly(this.now());
    if (closedDate < purchaseDate) {
      throw new ValidationError('结束日期不能早于购入日期。');
    }
    if (closedDate > today) {
      throw new ValidationError('结束日期不能晚于今天。');
    }
  }

  private assertTransactionLink(id: string | null, purpose: 'purchase' | 'sale'): void {
    if (id === null) return;
    const transaction = this.transactions.getById(id);
    if (transaction === undefined) {
      throw new ValidationError('关联账单不存在或已删除。');
    }
    if (transaction.isRefund) {
      throw new ValidationError('退款账单不能关联到物品购入或售出。');
    }
    const expected = purpose === 'purchase' ? TYPE_EXPENSE : TYPE_INCOME;
    if (transaction.type !== expected) {
      throw new ValidationError(
        purpose === 'purchase' ? '购入账单必须是支出。' : '售出账单必须是收入。',
      );
    }
  }
}

export class ItemPhotoTooLargeError extends Error {
  readonly statusCode = 413;
  readonly code = 'ITEM_PHOTO_TOO_LARGE';

  constructor() {
    super('物品图片不能超过 2 MiB。');
    this.name = 'ItemPhotoTooLargeError';
  }
}
