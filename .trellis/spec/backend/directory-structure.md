# Backend Directory Structure

> How backend code is organized in this project (`packages/server`).
> Established by T1 (`09-11-t1-skeleton`); update this file whenever the layout changes.

---

## Overview

The backend is a single Fastify (TypeScript, ESM) package inside a pnpm workspace.
It serves the `/api/v1/**` JSON API for native clients. Web hosting and the
`packages/web` client are retired; no Web reference host is required.

Three rules shape the layout:

1. **Assembly and process lifecycle are separate.** `app.ts` builds and returns a
   `FastifyInstance` and never calls `listen`; `index.ts` owns env loading, SQLite,
   `listen`, signals and `process.exit`. Tests therefore use `app.inject()`.
2. **Configuration is validated once, at startup, with no silent defaults.**
   Only `config.ts` reads `process.env`. Everything else receives an `AppConfig`.
3. **`/api/**` is JSON by default.** The authenticated assistant generation events route explicitly uses bounded SSE; see [streaming](./assistant-streaming.md). Unmatched API routes answer
   `{error:{code,message}}`; unmatched non-API paths also return JSON 404.

```
packages/server/
├─ package.json          # type: module — ESM everywhere
├─ tsconfig.json         # build: rootDir src → outDir dist
├─ tsconfig.test.json    # typecheck: src + test, noEmit, bundler resolution
├─ src/
│  ├─ index.ts           # entry point: env → config → db → listen → graceful exit
│  ├─ app.ts             # buildApp(options): Fastify instance (no listen)
│  ├─ config.ts          # env parsing/validation, AppConfig, ConfigError
│  ├─ db/
│  │  └─ index.ts        # better-sqlite3 open/PRAGMA/close  (T1: no tables)
│  ├─ routes/            # (T2+) one file per resource, registered from app.ts
│  ├─ services/          # (T2+) business logic, no HTTP types, unit-testable
│  └─ plugins/           # (T2+) auth guard, error mapping, shared instance config
└─ test/
   └─ app.test.ts        # vitest, drives the app with app.inject()
```

---

## Module Organization

### Private account contexts

`identity/` owns its separate schema, original-owner cutover and immutable relative
ledger bindings. Production `index.ts` acquires `storage-lock.ts` before opening
storage, then passes the identity store into `buildApp`. The explicit legacy
single-DB test mode does not expose registration.

`tenancy/context.ts` resolves only the authenticated immutable user ID inside the
auth module. A request leases a context until the response/stream closes. Route
service factories are cached per context, with busy checks preventing eviction
while background work runs. Shutdown cancels and drains work before closing DBs.
Never switch a process-global DB, proxy SQL, or build one Fastify app per user.

Every nested service receives the selected `dbFile`/`dataDir`; direct worker job
IDs require durable account ownership checks too. `cli-system.ts` coordinates
offline full-system recovery; `cli-db.ts` single-file snapshots remain personal
or legacy operations. The complete recovery and stale-lock procedures live in
`docs/MULTIUSER.md`. An interrupted restore marker blocks startup.

- **`config.ts` is the only place that touches `process.env`.** Add a variable by
  extending `AppConfig`, adding it to `DEFAULTS` (defaulted) or `REQUIRED` (no
  default) and validating it; collect problems and throw one `ConfigError` that
  lists *every* problem. Missing required variables must abort startup — never
  invent a default for a credential.
- **A cross-cutting concern is ONE plugin, not a plugin plus routes.** See
  "Authentication is a single module" below — this is the single most expensive
  mistake made in this codebase so far.
- **`app.ts` receives dependencies through `BuildAppOptions`** (`config`, optional
  `db`/`authService`), so a test can inject a fixed-clock `AuthService`. Production
  `buildApp` is API-only and exposes no static-root option. `buildApp` stays
  synchronous: registrations are not awaited, and `app.ready()` (implicit before
  `listen`, explicit in tests) resolves them.
- **Routes must not contain business rules.** Register thin route handlers that
  parse/validate input and call a `services/` function; services take/return plain
  domain objects and are tested without HTTP. Money maths lives in
  `packages/shared`, never duplicated here.
- **DB access goes through `db/index.ts`.** Do not call `new Database(...)` from a
  route. PRAGMAs are set once when the connection is opened; schema comes from
  `db/migrate.ts` and seed data from `db/seed.ts`, both applied by
  `initializeDatabase(db, dataDir)`.
- **Errors use the project contract**: throw an error carrying `statusCode` and
  `code`; `app.ts`'s error handler renders `{error:{code,message}}`, passes the
  message through for 4xx, and never leaks a stack or internal message for 5xx.

### Ledger projections, types and validation

`transaction-types.ts` owns transaction input/DTO types; `transaction-errors.ts` owns the
three legacy error constructors. `transaction-service.ts` re-exports the **same** types and
constructors for compatibility. Do not define parallel error classes with matching fields:
constructor identity and `instanceof` must remain stable.

`ledger-row-mapping.ts` converts the common transaction row (`id`, `type`, `amount_cents`,
`category_id`, `date`, `is_refund`) to the shared `Transaction`; only integer `1` means
refund. Callers retain their own SQL predicates and ordering. Account balances explicitly
add `accountId` and remain unbounded by date; stats retains its requested window and order;
budget retains its own live-row selection. Do not merge these into one broad query.

`ledger-input-validation.ts` holds the identical salary/transfer positive **safe** integer
and date validators, including lazily reading the clock only after basic date checks.
Ordinary transaction amount validation currently uses a different integer contract and
error vocabulary: do not silently replace it with the salary/transfer validator. The
compatibility, mapping, boundary and atomicity regressions live in
`ledger-row-mapping.test.ts`, `ledger-input-validation.test.ts`, `transactions.test.ts`,
`budget.test.ts` and `transaction-financial-purpose.test.ts`.

### The `import-batches` routes live inside the assistant auth plugin

`routes/import-batches.ts` is registered through the assistant route module, so the existing session and mutation-CSRF hooks cover it. Keep those routes in that protected encapsulation context; a sibling plugin registration can silently bypass hooks. The feature routes specify a scoped 12 MiB limit only for batch routes carrying file/review bodies; do not raise the global JSON body limit for the legacy APIs.

The full signatures, request fields, owner checks, errors, dedicated paging DTOs and batch transaction boundary are in [Merged Bill Import](./merged-bill-import.md).



`plugins/auth.ts` exports `authModule`, a `fastify-plugin` that registers the
cookie plugin, the session-resolution hook, the guard hook, **and** the auth routes.

Do **not** split the guard and the routes into two sibling calls:

```ts
// WRONG — the routes escape the guard.
app.register(authPlugin, { authService });
app.register(async (instance) => registerAuthRoutes(instance, options));
```

Fastify hooks apply only to routes registered in the same or a descendant
encapsulation context. In the wrong version above, `/api/v1/auth/logout` was
reachable without the CSRF header, `/api/v1/auth/password` was not guarded, and a
`CsrfError` thrown from the hook was converted by the error handler into a bare
`400` — while `/api/v1/health`, registered at the root before the module, still
looked perfectly correct. All 29 unit tests passed because they were written
against the same broken wiring.

Symptoms to recognise it: a mutating route returning `200` or a generic `400`
instead of `403`, and a protected route returning `200` with no cookie.

### The guard runs before routing — on purpose

While signed out, an unknown `/api/...` path answers **401, not 404**. A 401/404
difference would let anyone enumerate which routes exist on a public hostname.
Signed in, the same path answers JSON 404. Do not "fix" the 401.

### Mutating requests must send `X-Requested-With: fetch`

`SameSite=Lax` already blocks cross-site form posts; this header is the second
layer (design.md §5). Notes:

- It applies to `POST /api/v1/auth/login` too — login cannot require a session, but
  it must still prove the request came from our own page.
- Send `Content-Type: application/json` **only when there is a body**. Fastify
  rejects `Content-Type: application/json` with an empty body as
  `FST_ERR_CTP_EMPTY_JSON_BODY` (400) before the route runs, which is what a
  bodiless logout request hit during T3 verification.

---

## Naming Conventions

| Thing | Rule |
|---|---|
| Files/directories | `kebab-case` (`budget-engine.ts`, `date-utils.ts`) |
| Route modules | plural resource name (`routes/transactions.ts`) |
| Service modules | resource + concern (`services/budget-service.ts`) |
| Types/interfaces | `PascalCase`, no `I` prefix (`AppConfig`, `BuildAppOptions`) |
| Constants | `UPPER_SNAKE_CASE` (`API_PREFIX`, `PRAGMAS`) |
| Environment variables | `UPPER_SNAKE_CASE`, app-specific ones prefixed `JIZHANG_` |
| Tests | `<module>.test.ts` under `test/` |

---

## Import & Module Rules

- ESM only (`"type": "module"` in `package.json`). **Relative imports must end in
  `.js`** (`import { buildApp } from './app.js'`) — required by
  `moduleResolution: NodeNext` for both tsc and Node.
- `verbatimModuleSyntax` is on: type-only imports must say `import type`.
- Tests (`tsconfig.test.json`, `moduleResolution: bundler`) may omit the extension.
- `packages/shared` is declared as a workspace dependency but **is not imported by
  the server yet**. The first real import lands in T5 (budget engine); at that
  point `pnpm -r run build` already orders shared first, but a bare
  `pnpm --filter @jizhang/server run build` will require `shared/dist` to exist.
  Prefer adding TypeScript project references at that point instead of building
  shared from the server's scripts.
- Static serving and SPA fallbacks are retired. Root and unknown non-API paths
  return JSON 404 even if legacy Web files remain on disk. See
  `native-delivery.md` and `test/app.test.ts`.

---

## Forbidden Patterns

- `process.env.X` outside `config.ts`.
- `app.listen()` inside `app.ts`, or building a second Fastify instance in a route.
- Returning HTML for a path that starts with `/api`.
- Registering `better-sqlite3` without the PRAGMAs in `db/index.ts`
  (`journal_mode=WAL` is required for the `.backup` workflow).
- Adding `--ignore-scripts` to a `pnpm install` that feeds the image, or removing
  `better-sqlite3` from `onlyBuiltDependencies` in `pnpm-workspace.yaml`
  (both silently produce an image where the native addon is missing).

---

## Examples

- Minimal correct wiring: `packages/server/src/app.ts` (error handler, health
  route, API registration, JSON not-found handler).
- Validation style to copy: `packages/server/src/config.ts` (`REQUIRED` + `DEFAULTS`,
  one aggregated `ConfigError`).
- Test style to copy: `packages/server/test/app.test.ts` (`app.inject()`, no port
  binding, legacy files must not enable static hosting).
