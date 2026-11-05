# Database Guidelines — Backend

> `packages/server/src/db/`. Conventions are extracted from the code, not aspirational.

---

## Shape of the layer

```
db/
├─ index.ts        openDatabase / initializeDatabase / closeDatabase  (+ PRAGMAs)
├─ migrate.ts      versioned migration runner, pre-migration backup, status
├─ migrations/     001-init.ts  (TS modules, NOT .sql — see below)
└─ seed.ts         idempotent first-run seeding
```

Everything else goes through `db/index.ts`. Nothing outside this directory opens a
`Database` of its own — except `cli-db.ts`, which must, because it operates on files the
running server is not using.

Multi-user deployment adds `identity/store.ts` and `identity/schema.ts`. They still
open connections through `db/index.ts`, but initialize `auth.db` using an independent
`identity_migrations` journal. Do not run ledger migrations or seeds on `auth.db`.
`ledger_bindings.storage_key` is `owner` or a server-generated immutable user UUID;
paths resolve under the configured data directory. Existing `users`/`sessions` in
ledger files become empty, inert compatibility tables after verified credential
cutover. See [Multi-user identity](./multiuser-identity.md) before migration changes.

---

## The rules, and why each one exists

### Migrations are TypeScript modules, never `.sql` files

`tsc` does not copy non-TS assets into `dist`, so a `.sql` migration runs fine in
development and is **silently absent from the built image**. Keeping migrations as
string constants makes that failure mode impossible. See `migrations/README.md`.

### Migrations are additive only

Never edit or delete a migration that has shipped; add a new numbered one. Rolling the
code back must leave the database readable, which means:

- new columns need a `DEFAULT` (existing rows get the value automatically),
- removed columns are not actually dropped,
- anything beyond `ADD COLUMN` needs SQLite's documented 12-step table rebuild.

Order comes from the `MIGRATIONS` array in `migrate.ts`, not from filenames, so a new
file must also be appended there.

### Each migration runs in its own transaction

`runMigrations` wraps every migration in `db.transaction(...)`. A failure rolls back the
partial DDL **and does not record the version**, so the next boot retries it. Asserted by
a test.

### Back up before migrating, but only when there is something to lose

`runMigrations` snapshots the file (`VACUUM INTO`) only when `schema_migrations` already
has rows. A fresh install must not litter `DATA_DIR/backups/`.

> The first implementation decided this with `statSync(file).size > 0`, which is wrong:
> opening the database already writes a header (the WAL pragma alone does it), so a
> brand-new file looks non-empty. "Have any migrations been applied?" is the real
> question.

### All money is `INTEGER` cents; all time is `INTEGER` epoch milliseconds

There is no `REAL` anywhere in the schema. `19.99 * 100 === 1998.9999999999998`, so the
conversion happens once, at the boundary, with `Math.round`.

### Business rows are soft-deleted

Every business table has `deleted INTEGER NOT NULL DEFAULT 0`. Reads filter it unless the
caller opts in (`includeDeleted`). Two consequences that are easy to get wrong:

- A soft-deleted row must disappear from derived views too — the tag vocabulary counts
  only live rows.
- **A soft-deleted category must still label its historical transactions.** That is why
  `getCategory(id, includeDeleted = true)` exists, and why nothing cascades a delete onto
  `transactions`.

#### The one sanctioned exception to soft delete: `TransactionService.purge`

Transactions can be **hard-deleted**, and only through the recycle bin. Three rules make
that safe rather than a hole in the convention:

1. **`purge` refuses a live row** with `409 CONFLICT`. It never checks "does this id exist"
   alone — a mistyped id or a desynchronised UI must not be able to erase a real bill, and
   "missing" (404) is deliberately a different answer from "still live" (409).
2. **It can therefore only ever follow a soft delete**, i.e. a deliberate trip through the
   bin (`DELETE /api/v1/trash/:id`, after `DELETE /api/v1/transactions/:id`).
3. **No cascade is needed.** `transactions` has no inbound foreign keys — the schema's only
   `REFERENCES` is `sessions -> users` — so nothing is left dangling.

The bin reads through its **own endpoint** (`GET /api/v1/trash`), not a flag on the list.
`includeDeleted=true` returns live and deleted rows together and `TransactionDto` carries
no `deleted` field, so a client could not tell them apart; a dedicated read path makes
"the bin never shows a live bill" a structural property instead of a convention.

> **The recycle bin covers transactions only.** Categories, accounts and templates are
> soft-deleted too, but they have **no** bin UI. That is a scope decision, not an
> oversight — do not "fix" it by adding one without deciding what hard-deleting a
> category that historical bills reference would even mean.

The bin's "deleted at" is `updated_at`, used as a proxy: a binned row is not editable, and
`softDelete` stamps it when flipping the flag. Note the limits — `restore` bumps
`updated_at` as well, so it stops being the deletion time once a row comes back, and
`restore` deliberately **returns early for a live row** rather than re-stamping it, because
`updated_at` is the list ordering's tie-breaker and re-stamping would make the row jump
position.

### No materialised balances, ever

There is no `remaining_cents` column and no `carryover_pool_cents` column. The envelope
arithmetic is real-time and lives in `@jizhang/shared`; the database stores only the
inputs. A test asserts those columns are absent so nobody quietly adds one.

### A due bill is stored, not derived

`recurring_rules` + `recurring_occurrences` exist so that two states survive a restart:
**"the user ignored this one"** and **"this one already became a bill"**. Neither can be
reconstructed after the fact — inferring the second from `transactions` would misfire
whenever the user happened to enter an identical bill by hand.

The occurrence table is therefore a queue, not a cache:

- `status` is `pending` / `confirmed` / `ignored`; only `confirmed` implies a bill exists,
  and `transaction_id` records which one.
- The money/date/category columns are **snapshots taken at generation time**. Editing a
  rule must not silently change a pending item the user has already looked at.
- The uniqueness index on `(rule_id, planned_date)` is **partial** (`WHERE deleted = 0`),
  so a soft-deleted occurrence frees its slot. An unconditional index would make a date
  unregenerable forever after one soft delete.
- `has_older_due` records that more periods were due than one run materialised. It is not
  decoration: silently dropping them is the bug it exists to prevent.

**Nothing in the recurring path posts a bill without an explicit confirm.** That is the
feature's contract, not a default that a future change may relax for convenience.

> The recycle bin covers transactions only, and the same is true of occurrences: they have
> no bin UI. Deleting a rule soft-deletes its *pending* occurrences (so no alerts are
> stranded) and leaves the confirmed/ignored ones as history.

### JSON columns are read defensively

`tags_json`, `allocations_json` and `modules_json` are text. Every reader goes through a
parser that returns an empty collection for malformed input instead of throwing
(`parseTagsJson`, `parseAllocationsJson`, `parseModulesJson`). One dirty row must not break
a whole list query.

---

## PRAGMAs (set once, when the connection opens)

| PRAGMA | Value | Why |
|---|---|---|
| `journal_mode` | `WAL` | Readers do not block the writer; required for the backup workflow |
| `foreign_keys` | `ON` | SQLite defaults this OFF per connection |
| `busy_timeout` | `5000` | Avoids spurious `SQLITE_BUSY` under brief contention |
| `synchronous` | `NORMAL` | Durable enough with WAL, much faster than `FULL` |

The central identity connection overrides `synchronous` to `FULL`: committed user
activation and invitation consumption are the authority for separately initialized
ledger files. This does **not** make transactions across WAL files atomic. An unreachable
ledger is initialized first, then identity/binding/invitation changes commit together
inside `auth.db`; `ledger_provisions` records cleanup work across process restarts.

---

## Query patterns

- Prepared statements are created per call site; `better-sqlite3` caches them.
- Filters are built as a `where: string[]` plus a `params` array, so the SQL and its
  bindings cannot drift apart.
- **Escape `LIKE` wildcards.** A keyword search must match a literal `%`:
  `escapeLikePattern` prefixes `\`, `%` and `_`, and the query uses `ESCAPE '\'`.
  Without it, searching for `%` returns the entire ledger.
- Tag filters match the quoted name (`%"<tag>"%`) so tag `food` does not match
  `seafood`.
- Multi-row rewrites (tag rename/delete) run inside one `db.transaction`; a partial
  rewrite would leave two spellings of the same tag and the counts would lie.

---

## Naming conventions

| Thing | Rule |
|---|---|
| Tables | plural, `snake_case` (`budget_allocations`) |
| Columns | `snake_case`; money ends `_cents`, time ends `_at` or is `date` |
| Indexes | `idx_<table>_<column>` (`idx_txn_date`) |
| DTO fields (over the wire) | `camelCase` (`amountCents`) — mapped in the service |

The snake_case/camelCase boundary is the service layer. Routes and the web app only ever
see camelCase.

---

## Testing requirements

- Migrations: every table exists after a run; a second run applies nothing; a failed
  migration rolls back and records no version.
- Seeding: running twice inserts nothing the second time; a user rename of a seeded row
  survives re-seeding.
- Soft delete: hidden from the default list, present with `includeDeleted`, and still
  resolves its name for historical rows.
- PRAGMAs: asserted against a **file-backed** database (WAL is unavailable for
  `:memory:`).
- Backups: a snapshot round-trips through restore; a non-database file is rejected; the
  WAL case is covered explicitly.

---

## Forbidden patterns

- `new Database(...)` outside `db/index.ts` or `cli-db.ts`.
- A `.sql` migration file.
- Editing a shipped migration, or renaming an existing one.
- Storing money as `REAL`, or yuan as an integer.
- Adding a column without a `DEFAULT`.
- A hard `DELETE` on a business row (use soft delete). `scripts/lib/e2e-reset.mjs` is the
  one sanctioned exception: it deliberately wipes state between test suites.
- Reading `tags_json` / `*_json` without the parser.
- `cp` on a live database file (WAL sidecars make that a stale snapshot — use `VACUUM
  INTO`, as `cli-db.ts` does).
