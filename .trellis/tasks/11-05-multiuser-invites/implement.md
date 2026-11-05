# Implementation and verification plan

Status: user approved the final scope on 2026-11-05; implementation can start.

## Ordered work

1. Finalize private-vs-shared account scope and admin/invitation behavior; reconcile PRD/design with user response.
2. Create a task branch from the existing iOS work on original `origin`; never lose the delivered iOS changes or push to a fork.
3. Add central identity/invitation schema, legacy-owner migration and registration provisioning. Update auth routes/plugin/password CLI; freeze additive client DTOs for parallel native work.
4. Introduce explicit per-user ledger contexts with persistent service lifetimes, bounded resource ownership and shutdown. Adapt **all** route groups, workers, exports and filesystem paths. Do not expose registration while any protected business route still uses the global owner context.
5. Implement iOS and Android registration/admin invitation interfaces in separate worker scopes after the server contract is fixed. Update Android inventory and iOS docs together with behavior.
6. Update backup/verify/restore/bootstrap paths and migration docs; exercise upgraded legacy and fresh installs.
7. Independent two-account isolation review, regression fixes and full relevant verification. Push reviewed changes to original `yansuui/jizhang`; GitHub builds native iOS package.
8. Record exact CI/device/runtime evidence and deferred production deployment. Keep the existing delivered IPA provenance intact.

## Expected edit boundaries

- `packages/server/src/db/**` plus new identity/tenant modules: central schema, repeatable migration, private ledgers and seed lifecycle.
- `packages/server/src/services/auth-service.ts`, `services/password.ts`, `plugins/auth.ts`, `routes/auth.ts`, new admin invitation routes/services: multi-user identity, invitation enforcement, abuse protection and correct revocation.
- `packages/server/src/app.ts`, `index.ts`, `config.ts`, `cli*.ts`: single-app wiring, startup/shutdown, bootstrap and operational migration.
- Existing `routes/*.ts` and narrowly necessary service factories: resolve the correct user's DB/service graph. Preserve financial algorithms and DTO meanings.
- `routes/item-cutouts.ts`, portability/backup/import-comparison paths and async ownership: close non-DB isolation gaps.
- `clients/ios/Jizhang/App`, `Core` and My/auth features/tests; `clients/android` auth/session/UI/preferences/tests and maintained README.
- Relevant `.trellis/spec` and package docs: replace single-user assumptions with executable ownership and operational contracts.

## Verification

- Baseline versions/dependencies: repository-pinned `pnpm@10.12.2`; inspect current Node/tool availability before running.
- `pnpm -r run lint`, `pnpm -r run typecheck`, `pnpm -r run test`, `pnpm run build`.
- Use `app.inject()` with distinct cookie jars, real isolated temporary SQLite files and a mocked provider/worker; no real inference or production requests.
- Test every protected route family: unauthenticated protection, cross-user list and direct-ID reads/writes, foreign nested IDs, CSV, files, worker result/cancel, SSE, idempotent request collisions and caches.
- Test invitation expiry/revoke/reuse, concurrent registration, malformed/oversized inputs, username collisions, privilege escalation, throttle behavior and provisioning failures on each persisted boundary.
- Test legacy migration/restart/backup restore and owner financial snapshots, plus password changes that revoke only the correct user. Test ambiguous legacy ownership refuses to guess.
- Android Gradle tests/assemble using the project's wrapper/toolchain; iOS XCTest and arm64 build on GitHub. Include registration/admin states, fresh login cookies and stale responses after same-server account switches.
- Run required container lifecycle checks when configuration/storage lifecycle changes; report unavailable Docker/device checks explicitly rather than asserting success.

## Rollback and remaining review gates

- Business data must not be deleted, copied into a new user's account or re-seeded over edits. Use consistent snapshots and preserve the exact original data/key pairing.
- Do not retrofit shipped ledger migrations in place. Central identity has an independent schema/version authority.
- Private-ledger ownership and the concrete first-delivery scope are approved.
- Production database migration is not performed as part of planning or synthetic verification.
