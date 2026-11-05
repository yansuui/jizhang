# Quality Guidelines — Backend

> Code quality standards for `packages/server`.
> Established by T1 (`09-11-t1-skeleton`); extended by later tasks as they land.

> The repository targets API-only delivery; production upgrade is not established by repository changes. See [Native Client Delivery](./native-delivery.md).
> Older SPA/browser field notes below describe historical or temporary reference
> checks, not production hosting. Validate root/old assets returning JSON 404,
> and validate APK functionality separately from backend tests or compilation.

---

## Overview

The quality gate for every backend task is the same set of commands, run from the
repo root:

```bash
pnpm -r run lint        # eslint, --max-warnings 0
pnpm -r run typecheck   # tsc --noEmit (test config includes test/)
pnpm -r run test        # vitest run
```

Plus, for anything that touches the image or the process lifecycle:

```bash
docker compose build && docker compose up -d
curl -fsS http://127.0.0.1:8081/api/v1/health
docker compose exec -T jizhang whoami          # must be `node`, never root
```

A task is not done while any of those is red. "It compiles" is not the gate.

---

## Required Patterns

- **Pure logic belongs in `packages/shared`.** The budget engine and money maths
  are pure functions with no IO so they are testable without a database, an HTTP
  server or a clock. A route must not re-implement a rule the shared package owns.
- **One ordinary aggregation rule, one implementation.** Use `expenseContribution`
  and `incomeContribution` in `packages/shared/src/types.ts` for ordinary budget,
  statistics and summaries rather than duplicating type checks. A refund is an income
  transaction (`type=1`, `isRefund=true`), while ordinary and category-envelope
  expense remains gross. Confirmed refund allocations reduce the separate four-purpose
  execution view's net spending; they do not change ordinary ledger facts.
- **Money is integer cents.** Every `*Cents` field is an `INTEGER`. Convert at the
  boundary only, and always with `Math.round(value * 100)` — `19.99 * 100` is
  `1998.9999999999998`.
- **Tests drive the app with `app.inject()`**, never a real port, so tests cannot
  collide or leak a listener.
- **Compare complete SQLite snapshots with `Buffer.equals`.** Use
  `expect(actual.equals(expected)).toBe(true)` for whole database byte equality.
  Deep assertions such as `expect(actual).toEqual(expected)` walk every byte and
  can make otherwise fast file-backed tests hit their timeout; do not hide that
  assertion overhead by increasing timeouts or weakening the content check.
- **API cache and delivery regressions stay covered.** `Cache-Control: no-store`
  applies to API responses, including errors and 404s. `test/app.test.ts` asserts
  this and JSON 404 for root and retired Web paths even with stale assets present;
  preserve these assertions rather than restoring a shell fallback.

---

## Forbidden Patterns

- `process.env.X` outside `config.ts`.
- `app.listen()` in `app.ts`, or a second Fastify instance anywhere.
- Returning HTML for any path under `/api`.
- A default value for a credential. Missing `JIZHANG_*` must abort startup with
  the aggregated `ConfigError` list (AC12), never a silent fallback.
- `--ignore-scripts` on a `pnpm install` that feeds the image, or removing
  `better-sqlite3` from `onlyBuiltDependencies` in `pnpm-workspace.yaml`. Either
  one ships an image where the native addon is absent and `require` throws.
- Binding a container port to `0.0.0.0` or to `80`/`443` — see below.

---

## Testing Requirements

- Every rule that has a source-of-truth behaviour gets a test that names the
  behaviour, not the implementation. For the budget engine the reference project's
  21 behavioural cases are the spec (`research/budget-engine-behavior-spec.md`);
  they must all pass.
- Regression tests are named after the bug they prevent (see the `X1` case: month
  grouping must use an integer key because `'2026-12' < '2026-9'` as strings).
- Time is injected, never read from the real clock, so expiry/period logic is
  deterministic.

---

## Docker & deployment verification (T1 field notes)

These cost real debugging time. Keep them in mind before reporting a deployment
task as verified.

### Database snapshots MUST go through `VACUUM INTO`, never a file copy

The container runs SQLite in WAL mode, so recent commits live in the `-wal` sidecar
and are **not** in the `.db` file. `docker compose cp jizhang:/data/jizhang.db …`
therefore yields a **stale snapshot** — during T6 this produced an investigation
into a non-existent engine bug, because the copy contained data from an earlier test
run entirely.

Use the app's own consistent snapshot path:

```js
db.exec("VACUUM INTO '/tmp/snapshot.db'");   // includes everything in the WAL
```

The same rule applies to backups (design.md §7.4).

### Verify the numbers you assert, or you will "find" bugs that are not there

Three separate false alarms in T6 came from **hand-computed expectations**, not from
the code:

1. `listTags()` returned `[]` → the only tagged row had been soft-deleted a few lines
   earlier; the endpoint was right and the assertion was ordered wrong.
2. The carryover pool was `+450,000` where `-150,000` was expected → the expectation
   only subtracted one module's overspend and forgot that the other five modules were
   untouched. The pool is per-**cycle** net, not per-module.
3. The pool was `1,350,000` where `350,000` was expected → two cycles had closed, not
   one, so both left-overs belong in the pool.

Before changing engine code to match an expectation, recompute the expected value
from the raw rows (`SELECT` everything the engine reads) and state the arithmetic in
a comment next to the assertion. When a figure surprises you, dump the ledger first.

### `new Date()` is overloaded — name your month helpers by argument kind

`new Date(x)` treats `x` as an epoch timestamp; `new Date(year, monthIndex, day)` is a
calendar constructor. A helper called `startOfMonth(offset)` therefore silently does
two different things depending on the argument, and `new Date(0, -2)` is not "two
months ago" — it is November of year 0.

This bit the stats service: a month-bucket key computed from a month OFFSET instead of
the transaction's timestamp put every expense into the current bucket. The existing
tests missed it because they each used activity in a single month; only a row from an
earlier month reveals it.

Two rules:

- Name helpers after what they take: `startOfMonthOf(epochMs)` vs
  `monthStartOffset(epochMs, offset)`.
- **Every month-bucketing feature needs a test with data in at least two different
  months**, asserting that each row lands in its own bucket. Single-month fixtures
  cannot catch a wrong key.

### Integration scripts must not depend on "today" or on each other

Two rules, both learned by having suites fail only when run together:

**Time.** A salary dated more than a day in the future is rejected (deliberate: it
catches a mistyped year), so an e2e script that hard-codes a future month fails
purely because of when it runs. Derive dates from the current date going
**backwards** (`dayIn(-1, 5)` style).

**State.** Every suite must start from the same known baseline. `e2e-master-data`
renames the builtin 餐饮 category — that IS one of the things it verifies — and the
other suites then could not find it by name, so they passed alone and failed in
sequence. Each suite resetting only "the tables it cared about" was the root cause.

`packages/server/scripts/lib/e2e-reset.mjs` restores seeded rows and clears user
data. Scripts calling `resetToKnownState()` are destructive: **run them only against
an isolated disposable database and server, never the production ledger**. The helper
also exposes `loadServerModule()` to resolve `dist/` from the repo or image. Verify
independence by changing the order or repeating reset-based suites only in that isolated
environment. Not every script resets: `e2e-pwa.mjs` is a read-only API-only probe.

### Verify inside the container, from the package directory

pnpm keeps dependencies in the **owning package's** `node_modules`, not at `/app`.
A bare `docker compose exec jizhang node -e "require('better-sqlite3')"` fails with
`MODULE_NOT_FOUND` and looks like an ABI bug when the image is actually fine. Run
it with `-w /app/packages/server`, or assert the real thing instead: the server
logs `"msg":"sqlite ready"` with the resolved `dbFile`, which proves the addon
loaded in the actual runtime path.

### Build args and daemon state

- `docker compose build` needs a **running daemon**. On Windows that means Docker
  Desktop (and its `docker-desktop` WSL distro) being up; a stopped daemon fails
  with `failed to connect to the docker API at npipe://…`. Note that
  `docker ps -a` can still list stale exited containers, so it is not a health
  check for the daemon — use `docker version`.
- Docker writes progress to **stderr**, so PowerShell surfaces a successful build
  as a red `NativeCommandError` record. Judge by the build log and
  `docker images`, not by `$LASTEXITCODE`.

### Quoting inside `docker compose exec`

Nested quoting through PowerShell → docker → `node -e` mangles the script (single
quotes, `"`, even unescaped `!`). For anything beyond a one-liner, write the script
to a file, `docker cp` it into the package directory, run it, and remove it.

### Reverse-proxy coexistence is a hard constraint

`docker-compose.yml` publishes `127.0.0.1:8081:8081` and nothing else. The host's
existing Nginx/Caddy owns 80/443 and terminates TLS. Any change that widens this
binding can take down the user's other sites — treat it as a breaking change.

### Verify the deployed API, not a retired SPA

The former browser rendering and PWA field notes are historical: `packages/web` and
its browser tools have been removed, and Fastify does not serve a Web shell. Rebuilding
an image is not itself evidence that the running container was replaced; verify the
actual target image and API behavior using the applicable deployment procedure, without
recreating or stopping a production service merely for a test. Confirm `/` and retired
page/asset paths return JSON 404, and verify Android on a device separately.

`packages/server/scripts/check-api-only.mjs` is a read-only health and retired-path
probe. Its legacy entry point `e2e-pwa.mjs` imports that probe: it does not test a
manifest, service worker or offline shell. Browser offline-simulation notes are not
current deployment or acceptance instructions.

### Container test inventory

Most of these API suites call `resetToKnownState()` and modify or clear data. Run
reset-based suites only against a verified isolated disposable server and database;
never run them against production. Verify independence in that environment. The
legacy-named `e2e-pwa.mjs` is a read-only exception, not a PWA test.

| Suite | Focus |
|---|---|
| `e2e-auth.mjs` | login / logout / change-password / CSRF |
| `e2e-transactions.mjs` | CRUD, filters, soft delete |
| `e2e-budget.mjs` | the envelope engine over HTTP |
| `e2e-master-data.mjs` | categories, accounts, tags |
| `e2e-stats.mjs` | category share, monthly trend (income includes salaries), pool series |
| `e2e-home.mjs` | the dashboard's data contract: month figures agree with the charts page, cycle totals with the budget page, recents ordering |
| `e2e-trash.mjs` | the recycle bin: delete → bin → restore → purge, the 409 guard on live rows, bulk operations, and that `includeDeleted` keeps its old meaning |
| `e2e-periods.mjs` | historical cycle review: a past cycle returns its own figures, neighbours do not leak in, unknown periods 400, and the omitted path is field-for-field unchanged |
| `e2e-recurring.mjs` | recurring bills: due dates become pending (never bills), confirmation is idempotent, ignoring sticks, the backlog cap keeps the NEWEST periods and flags the rest |
| `e2e-portability.mjs` | CSV export/import: BOM on the bytes, round trip preserves count and totals, repeated import is a no-op, malformed files are refused whole, backups list without leaking a path |
| `e2e-pwa.mjs` | read-only API-only health and retired-path JSON 404 probe via `check-api-only.mjs` |
| `security-nopassword.mjs` | an unprovisioned instance is not loginable |
| `e2e-backup.mjs` | two-phase backup → stop → restore → start → assert drill |

### WAL and volume ownership

`journal_mode=WAL` means the SQLite file has `-shm` and `-wal` sidecars. Never copy
the `.db` alone for a backup (use `sqlite3 .backup`), and never assume
`docker compose down` removes the data: the named volume `jizhang-data` outlives
the container by design (that is AC9).

---

## Scenario: API workspace development watcher

### 1. Scope / Trigger

Use this contract when changing root development commands or the shared/server build chain.

### 2. Signatures

Run `pnpm dev` from the repository root; it first builds `@jizhang/shared`, then starts
shared's TypeScript watcher and the server's `tsx` watcher in parallel.

### 3. Contracts

`@jizhang/shared` resolves to `dist`, so a first build must finish before the server starts;
shared source changes must rebuild the output and server watch must see the changed output.
For local development the server reads `packages/server/.env` from its package working
directory. Use an isolated `DATA_DIR` for mutation tests; root Compose `.env` is separate.

### 4. Validation & Error Matrix

| Condition | Required outcome |
|---|---|
| Missing required local credentials | Server refuses startup with configuration errors |
| Shared build failure | Server watcher does not start against stale/missing output |
| Shared source/output changed | Shared rebuilds; server reloads its updated dependency |
| Production deployment not checked | Do not claim an upgrade or device acceptance |

### 5. Good / Base / Bad Cases

Good: both watchers run against a disposable local database and health returns `ok`.
Base: build passes but live watcher reload is not yet verified. Bad: start only the server
watcher and silently execute stale shared accounting code.

### 6. Tests Required

Verify startup and a shared-output-triggered server reload on an isolated server; stop the
managed watcher and clean only verified temporary paths. Never reset a production ledger.

### 7. Wrong vs Correct

Wrong: `pnpm --filter @jizhang/server dev` alone after editing shared source. Correct: root
`pnpm dev`, which builds and watches both packages, with the intended local environment.

## Code Review Checklist

- [ ] Does the change put business rules in a service/shared package rather than a route?
- [ ] Are amounts integer cents, converted once at the boundary with `Math.round`?
- [ ] Do ordinary refunds count as income and ordinary expense stay gross, while confirmed four-purpose allocations affect only that view's net execution?
- [ ] Do API errors remain JSON and carry `Cache-Control: no-store`, and do root and retired Web paths return JSON 404 rather than a shell?
- [ ] Are reset-based integration tests limited to an isolated disposable database and server?
- [ ] Was the container rebuilt and re-verified if the image contents changed?
- [ ] Did `lint` / `typecheck` / `test` pass after the last edit (not before it)?
