# Private account service ownership

## Scope and signatures

Production `index.ts` opens the original ledger and `IdentityStore`, then supplies both to `buildApp`. Identity owns authentication and immutable ledger bindings; `TenantContextManager` owns the open business DB/service graphs. `buildApp({ db })` without an identity store is the explicit single-ledger compatibility harness, with invitation registration disabled.

- `TenantContextManager.lease(request)` resolves only `requireUserId(request)` through `IdentityStore.getLedger`; a missing binding fails closed.
- `createRouteServices(app, options, factory)` constructs a reusable typed service graph once per open ledger. Route handlers obtain that graph from the current request; routes themselves are registered once inside the authentication module.
- Each graph receives its actual `db`, `dbFile`, `dataDir` and immutable actor ID. Nested `AppConfig` values are copied with the same storage descriptor. Do not fall back to the original account for an unresolved request.

After migration, ledger `users` tables are empty. Purpose-bearing transaction writes and assistant tool confirmations must receive the immutable actor explicitly through constructor options, including rebuilt generation tool contexts. Reconstructing `{ now }` from route options loses `actorId` and breaks authenticated writes; preserve both. Legacy local-user resolution is for the single-ledger test harness only.

## Lifetime contracts

The cache is bounded (32 open graphs by default). It evicts the least-recently-used idle graph, or answers `503 TENANT_BUSY` when every graph is busy. A mapped file must already exist before opening; missing storage is an operator recovery error, never a silently created empty ledger.

Request leases last until **both** the handler and its response finish. A disconnected socket does not mean an awaited provider call has stopped touching the DB. The business `onRoute` wrapper signals handler completion; the raw response finish/close signals response completion. Unknown routes, health, auth and administrator identity routes do not acquire business leases.

Assistant generation, merged import analysis and spending organization register explicit busy checks. Background work pins an otherwise idle graph. Runners and subscriber/lock maps are never reconstructed per request. Their recovery routines run once per newly opened graph and never resume provider work automatically.

Fastify `preClose` aborts and drains service work before waiting for connections; `onClose` closes owned ledger handles only after the requests have drained. `TenantContext.service` refuses construction or access after draining starts, preventing a leased request from creating a new runner after the shutdown pass. Failed eviction retains the context for shutdown rather than losing its handle.

`ImportBatchAnalysisRunner.shutdown()` invokes registered provider abort callbacks and waits for tracked promises. Clearing an abort callback without invoking it is not cancellation and must never precede closing that runner's DB.

## Files, external workers and backup boundaries

`PortabilityService` uses an explicit `dbFile` (or the actual DB handle's file name), not a guessed root path. The assistant's nested portability service receives the scoped `AppConfig.dbFile`. Ordinary backup lists and creation use only the selected account's directory. Central identity and coordinated system recovery remain operator operations.

Every cutout job proxy checks durable `cutout_job_owners(job_id, user_id)` ownership **before** contacting the private worker. Creation records ownership before returning the ID. A foreign or unknown job returns 404 for status, cancel, preview and image. An opaque job ID is not permission. If creation succeeds but ownership recording fails, cancel best effort unless a pre-existing mapping shows that cancellation could affect another user's job.

## Verification

`test/multiuser-isolation.test.ts` uses real temporary SQLite files and two accounts. Its cases cover ledger/nested IDs, shared builtin IDs, CSV, budgets/statistics, transfers/trash/recurring, planning/goals/funds, private AI configuration, conversations/import/generations, cross-user cancellation/SSE, photos/cutouts, backup scope, missing files, cache eviction and shutdown races. Mock providers/worker responses are synthetic evidence; physical-device and production migration acceptance are separate.

Keep existing route/service regressions passing after factory changes. Financial algorithms remain in the existing services/shared package. CSV header/row widths must match, legacy exports may omit the later `fundPurpose` column, and valid explicit purpose evidence must survive a round trip through existing purpose-write helpers.
