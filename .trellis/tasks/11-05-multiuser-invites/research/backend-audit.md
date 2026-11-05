# Backend multi-user / invitation audit

Research only, 2026-11-05. Source inspected on the existing `feat/ios-assistant` checkout. No product changes or tests executed in this audit.

## Recommendation

Use a **separate central identity database** plus a ledger database and service context per user. Keep the original `DATA_DIR/jizhang.db` attached exclusively to the configured existing owner; provision new ledgers under `DATA_DIR/users/<internally-generated-user-id>/jizhang.db`. Store users, sessions, roles, invitation hashes, tenant mappings and external-job ownership in a new `DATA_DIR/auth.db` with its own migrations.

Do not make the original owner's ledger the central identity database. Its ordinary ledger backups and restores must not contain, export or roll back other users' password hashes, sessions or invitation state. Existing legacy auth tables may remain in that file for migration compatibility, but must cease being authoritative and should be cleared after verified identity transfer. Old backups already contain the old owner's identity state and need documented legacy handling.

Physical ledger separation is the smaller auditable change here: 48 business tables currently have no account owner column, and services contain many unscoped queries. Existing built-in IDs, singleton rows, import IDs and financial counters can remain unchanged inside each ledger. A shared database would require every read, write, join, aggregate, idempotency lookup, unique index and relevant foreign key to be tenant-aware; simply adding `user_id` columns would not isolate it. Physical separation costs more connections, per-tenant migrations, backup coordination and service lifecycle management; bound active contexts and avoid eviction during live jobs or streams.

## Existing auth is explicitly single-user

- `packages/server/src/routes/auth.ts:63`: `/auth/me` looks up `config.username`, not the resolved session user. Login rejects any username unequal to that configured name. Return the actual session user, with additive `id`/`role` fields, and allow existing database users to authenticate.
- `services/auth-service.ts:120`: CLI-style `setPassword` deletes **all** sessions. Scope reset/revocation to the changed user. The normal `changePassword` path already scopes deletion by `user_id` at line 217.
- `cli.ts:154`: setup opens the legacy ledger DB, initializes it and calls `setPassword(config.username, password)`. Changing the configured username can leave old user rows behind; do not grant every historical row access to the one legacy ledger.
- `plugins/auth.ts`: the verified session already exposes `userId`. Keep all protected registrars inside the same auth module encapsulation. Only the explicit registration route should join the public allowlist; preserve the existing CSRF/header protection.
- `services/password.ts`: Argon2id and hashed random session tokens are reusable. Registration needs bounded username/password/invite input and rate/concurrency limits. Existing unknown-user login exits before password verification, so use a dummy verification if normalizing timing.
- `config.ts:183`: `dbFile` currently always resolves to `DATA_DIR/jizhang.db`; central identity and ledger paths need distinct types/configuration. Fresh setup must still explicitly create an administrator rather than letting the first public registrant claim existing data.

## Exact schema ownership inventory

There are **50 application tables** across migrations 001–021, plus the migration journal. Only `sessions` has `user_id`; all 48 business tables below are globally scoped within the current DB. Assistant “ownership” checks mean conversation/batch/job relationships, not user ownership.

| Migration | Tables |
|---|---|
| 001 | `users`, `sessions`; `categories`, `accounts`, `transactions`, `salary_records`, `budget_allocations`, `budget_templates`, `settings` |
| 002 | `recurring_rules`, `recurring_occurrences` |
| 004 | `transfers` |
| 005 | `refund_links` |
| 008 | `ai_organization_audit` |
| 009 | `assistant_conversations`, `assistant_messages`, `assistant_pending_actions` |
| 010 | `asset_items`, `asset_item_photos` |
| 011 | `assistant_generations`, `assistant_generation_events` |
| 012 | `assistant_import_batches`, `assistant_import_batch_rows`, `assistant_import_batch_categories`, `assistant_import_batch_operations` |
| 013 | `tags` |
| 014 | `ai_analysis_runs`, `ai_note_suggestions` |
| 016 | `ai_organization_operations` |
| 018 | `ai_organization_resume_requests` |
| 019 | `financial_config_revisions`, `financial_mapping_revisions`, `financial_periods`, `financial_period_revisions`, `financial_period_sources`, `financial_refund_splits`, `financial_refund_split_sets`, `financial_bill_purpose_events`, `financial_operations` |
| 020 | `manual_goal_openings`, `manual_goal_entries`, `manual_goal_state`, `manual_goal_operations` |
| 021 | `financial_fund_config_revisions`, `financial_fund_grants`, `financial_fund_grant_revisions`, `financial_fund_grant_sources`, `financial_fund_purposes`, `financial_fund_purpose_events`, `financial_fund_migration_issues` |

Examples obstructing a small shared-DB patch: `settings.key` is the global primary key; seeded category/account IDs are constants; `manual_goal_state` is a singleton `id = 1`; financial revision and operation keys assume one ledger. Existing seed/migration SQL and client-visible built-in IDs must remain stable.

## Isolation boundaries beyond SQL

- `app.ts:150` passes the same captured DB to all route registrars. Each registrar constructs services around it. Introduce an explicit tenant-context resolver using verified session user ID; every business handler obtains services from that context. Do not use a mutable global “current DB”, generic SQL rewriting, or request-only context that disappears in background work.
- `routes/assistant.ts:226–292` creates conversation/orchestration services, an in-memory confirmation map, active lock, generation service/runner, AI config and import analysis runner. These belong to the tenant context. Background generation, pending confirmations, SSE subscribers, cancellation, import jobs and recovery must keep that context for their entire lifetime. Recover each ledger once; drain jobs before closing its DB.
- `services/ai-config-service.ts:263,388`: provider config is one encrypted `settings` entry. Per-tenant DB selection must cover config reads/writes, model lookup, verification and background provider calls. The server encryption key can stay global; credentials and chosen provider must remain tenant data.
- Import batches use conversation IDs and worker lease fields, not users. CSV imports and organization flows consult global existing-ID sets. Resolve the tenant before constructing these services; do not copy owner settings, transactions or assistant history into new-user seeds.
- **External cutout jobs are a separate bypass:** `routes/item-cutouts.ts:20` proxies worker job IDs for status, cancellation and preview/image fetches without a DB owner check. `services/item-cutout-client.ts` sends no user identity to the private worker. Add durable `jobId -> userId` ownership in the identity store (or an equivalently enforced worker contract), check ownership before every proxy request and return the same 404 for foreign and absent jobs. A random job ID is not authorization. On creation, persist ownership before returning the job ID; if persistence fails, best-effort cancel the worker job and return failure. Existing unmapped jobs must fail closed.
- `services/portability-service.ts:1177–1205`: backups share a directory and derive `join(dataDir, 'jizhang.db')`. Give the selected ledger its actual DB path and private backup directory. Members may list/create their own ledger backups only. Central identity backups are administrative/offline operations. CSV exports, asset photo bytes and historical AI events also need tenant selection.

## Migration, crash consistency and failure rules

1. Produce a WAL-safe snapshot with the existing `VACUUM INTO` backup machinery before transition. Do not copy a live SQLite file with the filesystem. Keep shipped numbered migrations unchanged; identity schema has its own migration chain.
2. Resolve the existing owner from `config.username` and an existing user row. Preserve its ID and Argon2 hash; make that explicit account administrator. If legacy users exist but that configured owner is missing, fail closed with an actionable operator error instead of guessing. Other legacy user rows need explicit resolution, not silent access to the original ledger.
3. Atomically commit the identity row, administrator role, verified ledger mapping and migration-complete marker in the **identity DB**. Copy only appropriate owner sessions if preserving login is desired; invalidating them and requesting login is simpler. Never overwrite migrated users on subsequent starts. Only retire legacy authoritative auth data after the central commit is verified; a crash between those steps must be retryable.
4. Keep the existing ledger file in place and bind its absolute, validated path to that owner. New ledgers can run the existing migration/seed chain; unused legacy `users`/`sessions` tables remain empty and are never consulted for auth. Do not run ledger migrations against the identity-only DB.
5. **Registration cannot be one atomic WAL transaction across independently opened files.** Validate/hash outside a write transaction; stage and fully migrate/seed a ledger for a server-generated UUID first. Then use a short central transaction to recheck username uniqueness and invitation validity, create the user plus ready ledger mapping, and consume the invitation together. If it loses a concurrent invitation race, no active account is committed. A crash before central commit leaves an unreferenced staging ledger; after commit the mapped ledger already exists. Alternatively use an explicit provisioning state with idempotent restart recovery; never acknowledge an account whose ledger is missing.
6. Cleanup may touch only verified unreferenced provisioning directories beneath the intended tenant root; do not remove existing user data using unchecked computed paths. Incomplete/unavailable/corrupt mappings must produce a safe failure, never fall back to the owner's DB or silently create a replacement empty ledger.
7. Run migrations and recovery for every registered ledger with deterministic failure reporting. A failed ledger migration must not expose another ledger or leave an account mapped to a partially initialized DB. Central auth failure should stop service startup; per-tenant unavailability can be isolated explicitly if the registry supports it.
8. Extend backup/restore operational docs: restoring a single ledger must not restore central sessions or delete other accounts; full deployment recovery requires the identity DB, all mapped ledgers and the encryption key. Keep restore offline. Make CLI `set-password` and backup/verify/restore scopes explicit.

## Invitation contract proposed for the plan

Existing owner is administrator; invited accounts are members. Only administrators issue/list/revoke invitations. Generate at least 128 random bits; store only a hash; show plaintext once. Use expiry and single-use redemption, rechecked and consumed inside the same central transaction as account creation. Do not accept role or ledger path from registration input. A duplicate username, invalid invite or failed provisioning must not consume an invitation accidentally. Account switching must resolve the new user's context, not reuse previous-session client or server caches.

## Implementation file scope

- Identity schema/migration/service modules; `db/index.ts` explicit database factory; a tenant context registry/service factory; `index.ts` startup, recovery and shutdown.
- `services/auth-service.ts`, `services/password.ts`, `routes/auth.ts`, `plugins/auth.ts`, `config.ts`, `cli.ts`; new invitation/admin routes and their shared contracts.
- `app.ts` and every business route registrar: transactions, master data, budget, transfers, stats, trash, recurring, portability, AI, assistant/import batches, items/cutouts and financial planning/goals/funds. Most business SQL/services can remain unchanged after correct context injection.
- Assistant context construction/lifecycle and cutout job ownership; `services/portability-service.ts`, `cli-db.ts` and backup/restore path handling.
- Server auth/migration/isolation/assistant/cutout/portability tests; architecture/deployment docs and affected specs. Update `clients/android/README.md` for changed API contracts even if Android UI work is deferred. Client login/registration/admin and cache clearing are tracked by the client audit.

## Required validation

- Two users with the same seeded IDs: independent list/detail/create/update/delete, totals/search, salary/budget, transfers/refunds, recurring, trash, financial plans/goals/funds, item/photo bytes and CSV import/export. Supplying another user's known resource ID must behave as absent.
- AI settings including secrets, conversation list/messages, SSE replay/live events, cancellation, pending confirmation, import batches/analysis/commit and organization operations never cross users. Parallel jobs use the right credentials, locks and subscriptions; shutdown/restart recovery stays per tenant.
- Foreign cutout status/cancel/preview/image calls do not reach the worker; ownership survives server restart. Each user's backup list and created snapshot exclude other tenants and central identity.
- Concurrent redemption yields exactly one successful account for a single-use invite; expired/revoked/used codes fail; duplicate usernames and provisioning faults preserve consistency. Non-admin users cannot issue invites or escalate roles. `/auth/me` identifies the session user; changing/resetting A's password does not invalidate B.
- File-backed legacy migration preserves row counts, money totals, IDs and encrypted AI config; restart is idempotent. Inject failure before/after staging and central commit, missing owner, missing/corrupt tenant file and interrupted migration. Verify no fallback to the old shared ledger.

Applicable local contracts: `.trellis/spec/backend/database-guidelines.md` (additive migrations, WAL-safe snapshots, SQLite pragmas, integer cents) and `directory-structure.md` (database factory boundary and Fastify auth encapsulation). No external technical fact or dependency choice was required for this source audit.
