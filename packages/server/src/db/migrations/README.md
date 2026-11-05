# Migrations

Migrations run automatically on server start, before the app accepts traffic.

## Rules

1. **Additive only.** Never edit or delete a migration that has shipped. Add a new
   numbered file instead. Rolling the code back must leave the database readable,
   which means new columns need `DEFAULT` values (every row already in the table
   gets one) and dropped columns are not actually dropped.
2. **One file per migration**, named `NNN-short-description.ts`, exporting a single
   string constant. Order comes from the `MIGRATIONS` array in `migrate.ts`, not
   from the filename, so a new entry must also be appended there.
3. **TypeScript, not `.sql`.** `tsc` does not copy non-TS assets into `dist`, so a
   `.sql` file would exist in development and be silently missing from the built
   image. Keeping migrations as string constants makes that class of bug impossible.
4. **`CREATE TABLE` / `CREATE INDEX` only, unless you have a reason.** SQLite cannot
   add a constraint to an existing table; anything beyond `ADD COLUMN` needs the
   documented 12-step table rebuild.
5. **Retiring a feature is a migration, not a delete.** Migration 022 retires allocation
   templates by folding their names into `tags` and leaving every `budget_templates` /
   `budget_allocations` row intact: shipped clients still call the deprecated route, and
   historical salary allocations must stay readable. When a surface is removed, add an
   additive migration that preserves the data and records an audit mapping, and mark the
   route deprecated instead of returning 4xx to clients that are already installed.
   See `docs/migrations/022-template-to-tag.md`.
6. **Never put seed data here.** Preset categories, the default account and the
   default template live in `packages/shared/src/seed-data.ts` and are applied by
   `seed.ts`, which is idempotent and safe to run on every boot.

## Execution semantics

- Each migration runs inside its own transaction; a failure rolls back and the
  version is **not** recorded, so the next start retries it.
- Before any migration is applied, the database file is copied to
  `DATA_DIR/backups/jizhang-<timestamp>.db`. A migration that corrupts data is then
  recoverable without a separate backup job.
- Applied versions are recorded in `schema_migrations`. Re-running the server is a
  no-op (parent task `implement.md` risk check R2).
