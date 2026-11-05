/**
 * Budget template service: the "modules = category + ratio" definitions that a
 * salary allocation is generated from.
 *
 * ⚠️ DEPRECATED SURFACE. A template no longer drives salary allocation — every new
 * salary writes a frozen four-purpose grant keyed by operation id
 * (`salary-service.ts`), and the product direction moved the meaning of a template
 * to an ordinary bill tag. Migration 022 folds each template name into `tags` and
 * `routes/budget.ts` marks `/templates` deprecated.
 *
 * The class stays because two things still depend on the existing rows:
 *   * shipped Android/Harmony builds call `/templates`;
 *   * historical `budget_allocations` reference template-shaped module lists.
 * Adding a feature here is therefore the wrong move; read the tags of a bill instead.
 *
 * Behavior contract is unchanged and still transcribed from the reference:
 *   * ratios sum to 1 within a tolerance of **1e-4**
 *     (`salary_entry_page.dart:206`);
 *   * every module needs a non-empty category and a finite ratio `> 0`;
 *   * a template may not repeat a category
 *     (`ids.length === template.modules.length`);
 *   * exactly one template is the default at a time.
 *
 * The allocation arithmetic itself (`allocateSalaryCents`) lives in
 * `@jizhang/shared` because the web app previews the same numbers the server will
 * store — two implementations would drift.
 */
import { RATIO_SUM_TOLERANCE, templateRatioSum, type SeedTemplateModule } from '@jizhang/shared';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import { NotFoundError, ValidationError } from './transaction-service.js';

interface TemplateRow {
  readonly id: string;
  readonly name: string;
  readonly is_default: number;
  readonly modules_json: string;
  readonly deleted: number;
  readonly updated_at: number;
}

export interface TemplateModuleDto {
  readonly categoryId: string;
  readonly ratio: number;
}

export interface TemplateDto {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly modules: TemplateModuleDto[];
  readonly updatedAt: number;
}

/** Reads `modules_json`, tolerating a malformed value rather than throwing. */
export function parseModulesJson(raw: unknown): TemplateModuleDto[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const decoded: unknown = JSON.parse(raw);
    if (!Array.isArray(decoded)) return [];
    const out: TemplateModuleDto[] = [];
    for (const item of decoded) {
      if (typeof item !== 'object' || item === null) continue;
      const record = item as Record<string, unknown>;
      const categoryId = record['categoryId'];
      const ratio = record['ratio'];
      if (typeof categoryId !== 'string' || categoryId.trim() === '') continue;
      if (typeof ratio !== 'number' || !Number.isFinite(ratio)) continue;
      out.push({ categoryId, ratio });
    }
    return out;
  } catch {
    return [];
  }
}

function toDto(row: TemplateRow): TemplateDto {
  return {
    id: row.id,
    name: row.name,
    isDefault: row.is_default === 1,
    modules: parseModulesJson(row.modules_json),
    updatedAt: row.updated_at,
  };
}

/** Validated module list: the checks `salary_entry_page.dart:199-206` performs. */
export function validateModules(
  modules: readonly TemplateModuleDto[],
  options: { readonly assertCategoryUsable?: (id: string) => void } = {},
): void {
  if (modules.length === 0) {
    throw new ValidationError('A template needs at least one module.');
  }

  const seen = new Set<string>();
  for (const module of modules) {
    if (module.categoryId.trim() === '') {
      throw new ValidationError('Every module needs a category.');
    }
    if (!Number.isFinite(module.ratio) || module.ratio <= 0) {
      throw new ValidationError(`Module ${module.categoryId} needs a positive ratio.`);
    }
    if (seen.has(module.categoryId)) {
      throw new ValidationError(
        `Category ${module.categoryId} appears more than once in the template.`,
      );
    }
    seen.add(module.categoryId);
    options.assertCategoryUsable?.(module.categoryId);
  }

  const sum = templateRatioSum(modules as readonly SeedTemplateModule[]);
  if (Math.abs(sum - 1) >= RATIO_SUM_TOLERANCE) {
    throw new ValidationError(
      `Module ratios must add up to 100% (got ${(sum * 100).toFixed(2)}%).`,
    );
  }
}

export interface TemplateServiceOptions {
  readonly now?: () => number;
}

export class TemplateService {
  private readonly db: Db;
  private readonly now: () => number;

  constructor(db: Db, options: TemplateServiceOptions = {}) {
    this.db = db;
    this.now = options.now ?? (() => Date.now());
  }

  private assertNoParentChildMix(modules: readonly TemplateModuleDto[]): void {
    const ids = new Set(modules.map((module) => module.categoryId));
    for (const module of modules) {
      const row = this.db
        .prepare('SELECT parent_id FROM categories WHERE id = ? AND deleted = 0')
        .get(module.categoryId) as { parent_id: string | null } | undefined;
      if (row?.parent_id !== null && row?.parent_id !== undefined && ids.has(row.parent_id)) {
        throw new ValidationError(
          `A template cannot select parent ${row.parent_id} and child ${module.categoryId} together.`,
        );
      }
    }
  }
  private assertCategoryUsable(categoryId: string): void {
    const row = this.db
      .prepare('SELECT 1 AS x FROM categories WHERE id = ? AND deleted = 0')
      .get(categoryId) as { x: number } | undefined;
    if (row === undefined) {
      throw new ValidationError(`Unknown or deleted category: ${categoryId}`);
    }
  }

  list(): TemplateDto[] {
    const rows = this.db
      .prepare('SELECT * FROM budget_templates WHERE deleted = 0 ORDER BY is_default DESC, name')
      .all() as TemplateRow[];
    return rows.map(toDto);
  }

  getById(id: string): TemplateDto | undefined {
    const row = this.db
      .prepare('SELECT * FROM budget_templates WHERE id = ? AND deleted = 0')
      .get(id) as TemplateRow | undefined;
    return row === undefined ? undefined : toDto(row);
  }

  getByIdOrThrow(id: string): TemplateDto {
    const found = this.getById(id);
    if (found === undefined) throw new NotFoundError('Template not found.');
    return found;
  }

  /** The default template, falling back to the first live one. */
  getDefault(): TemplateDto | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM budget_templates WHERE deleted = 0 ORDER BY is_default DESC, name LIMIT 1',
      )
      .get() as TemplateRow | undefined;
    return row === undefined ? undefined : toDto(row);
  }

  create(name: string, modules: readonly TemplateModuleDto[], makeDefault = false): TemplateDto {
    if (name.trim() === '') throw new ValidationError('A template needs a name.');
    validateModules(modules, {
      assertCategoryUsable: (id) => this.assertCategoryUsable(id),
    });
    this.assertNoParentChildMix(modules);

    const id = randomUUID();
    const nowMs = this.now();

    const run = this.db.transaction((): void => {
      this.db
        .prepare(
          `INSERT INTO budget_templates (id, name, is_default, modules_json, deleted, updated_at)
           VALUES (?, ?, ?, ?, 0, ?)`,
        )
        .run(id, name.trim(), makeDefault ? 1 : 0, JSON.stringify(modules), nowMs);
      if (makeDefault) this.clearOtherDefaults(id);
    });
    run();

    return this.getByIdOrThrow(id);
  }

  update(
    id: string,
    changes: {
      readonly name?: string;
      readonly modules?: readonly TemplateModuleDto[];
    },
  ): TemplateDto {
    const current = this.getByIdOrThrow(id);

    const nextName = changes.name === undefined ? current.name : changes.name;
    if (nextName.trim() === '') throw new ValidationError('A template needs a name.');

    const nextModules = changes.modules ?? current.modules;
    if (changes.modules !== undefined) {
      validateModules(changes.modules, {
        assertCategoryUsable: (categoryId) => this.assertCategoryUsable(categoryId),
      });
      this.assertNoParentChildMix(changes.modules);
    }

    this.db
      .prepare(
        'UPDATE budget_templates SET name = ?, modules_json = ?, updated_at = ? WHERE id = ?',
      )
      .run(nextName.trim(), JSON.stringify(nextModules), this.now(), id);

    return this.getByIdOrThrow(id);
  }

  /** Soft delete. The default template cannot be deleted. */
  softDelete(id: string): void {
    const current = this.getByIdOrThrow(id);
    if (current.isDefault) {
      throw new ValidationError('The default template cannot be deleted.');
    }
    this.db
      .prepare('UPDATE budget_templates SET deleted = 1, updated_at = ? WHERE id = ?')
      .run(this.now(), id);
  }

  /** Makes `id` the only default template. */
  setDefault(id: string): TemplateDto {
    this.getByIdOrThrow(id);
    const run = this.db.transaction((): void => {
      this.db.prepare('UPDATE budget_templates SET is_default = 0 WHERE is_default = 1').run();
      this.db
        .prepare('UPDATE budget_templates SET is_default = 1, updated_at = ? WHERE id = ?')
        .run(this.now(), id);
    });
    run();
    return this.getByIdOrThrow(id);
  }

  private clearOtherDefaults(keepId: string): void {
    this.db.prepare('UPDATE budget_templates SET is_default = 0 WHERE id <> ?').run(keepId);
  }
}
