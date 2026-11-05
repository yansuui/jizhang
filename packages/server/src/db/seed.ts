/**
 * First-run seeding: preset categories, the default account, the default template.
 *
 * Contract (T2 PRD R4):
 *   * content comes from `@jizhang/shared`'s `seed-data.ts`, which is transcribed
 *     from the reference app — never invented here;
 *   * seeding is IDEMPOTENT: stable ids mean a second run merges onto the same
 *     rows instead of creating "same name, different id" duplicates (parent
 *     `implement.md` risk check R2);
 *   * it runs on every boot, so a database that lost a preset row (or an older
 *     install that predates one) self-heals.
 *
 * `INSERT ... ON CONFLICT DO NOTHING` is what makes this safe: a row that already
 * exists is left completely untouched, so a user's rename or recolour of a preset
 * category survives every restart.
 *
 * Seeding also re-runs the template→tag backfill. Migrations run *before* seeding,
 * so on a fresh install migration 022 finds no templates to fold; the preset
 * template is inserted afterwards and would otherwise never become a tag.
 */
import {
  SEED_ACCOUNT,
  SEED_CATEGORIES,
  SEED_TEMPLATE,
  SEED_UPDATED_AT_MS,
} from '@jizhang/shared';
import type { Db } from './index.js';
import { backfillTemplateTags } from './migrations/022-template-tags.js';

export interface SeedResult {
  readonly categoriesInserted: number;
  readonly accountsInserted: number;
  readonly templatesInserted: number;
}

/** Serialises template modules the way `budget_templates.modules_json` expects. */
function templateModulesJson(): string {
  return JSON.stringify(
    SEED_TEMPLATE.modules.map((module) => ({
      categoryId: module.categoryId,
      ratio: module.ratio,
    })),
  );
}

/**
 * Seeds the database. Safe to call on every start.
 *
 * All writes share one transaction so a failure cannot leave a half-seeded
 * database (e.g. categories present but the template that references them absent).
 */
export function seedDatabase(db: Db): SeedResult {
  const insertCategory = db.prepare(`
    INSERT INTO categories
      (id, name, type, icon, color, sort_order, is_builtin, deleted, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?)
    ON CONFLICT(id) DO NOTHING
  `);

  const insertAccount = db.prepare(`
    INSERT INTO accounts
      (id, name, type, initial_balance_cents, sort_order, is_builtin, deleted, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, 0, ?)
    ON CONFLICT(id) DO NOTHING
  `);

  const insertTemplate = db.prepare(`
    INSERT INTO budget_templates
      (id, name, is_default, modules_json, deleted, updated_at)
    VALUES (?, ?, ?, ?, 0, ?)
    ON CONFLICT(id) DO NOTHING
  `);

  const run = db.transaction((): SeedResult => {
    let categoriesInserted = 0;
    for (const category of SEED_CATEGORIES) {
      const info = insertCategory.run(
        category.id,
        category.name,
        category.type,
        category.icon,
        category.color,
        category.sortOrder,
        SEED_UPDATED_AT_MS,
      );
      categoriesInserted += info.changes;
    }

    const accountInfo = insertAccount.run(
      SEED_ACCOUNT.id,
      SEED_ACCOUNT.name,
      SEED_ACCOUNT.type,
      SEED_ACCOUNT.initialBalanceCents,
      SEED_ACCOUNT.sortOrder,
      SEED_UPDATED_AT_MS,
    );

    const templateInfo = insertTemplate.run(
      SEED_TEMPLATE.id,
      SEED_TEMPLATE.name,
      SEED_TEMPLATE.isDefault ? 1 : 0,
      templateModulesJson(),
      SEED_UPDATED_AT_MS,
    );

    return {
      categoriesInserted,
      accountsInserted: accountInfo.changes,
      templatesInserted: templateInfo.changes,
    };
  });

  const result = run();
  // Inside the caller's connection but after the rows exist: `template_tag_mappings`
  // is created by migration 022, which has already run on every path that reaches
  // `initializeDatabase` (and the guard in the backfill tolerates a bare call).
  // The seeded template itself is skipped there — it is not user-named content.
  backfillTemplateTags(db);
  return result;
}
