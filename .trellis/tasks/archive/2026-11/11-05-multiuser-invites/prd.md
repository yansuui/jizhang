# Multi-user accounts with invite-only registration

## Goal

Add invitation-only registration and multiple accounts to the existing native-client accounting service. Preserve the original user's ledger and keep the iPhone configuration simple. User requested GPT delegation and continued development on 2026-11-05. User approved the concrete private-ledger proposal on 2026-11-05: ??? ???. Implementation is authorized.

## Baseline evidence (before implementation)

- The current backend is intentionally single-user: login allows only `config.username`; `/auth/me` returns that configured user (`packages/server/src/routes/auth.ts:63,84`).
- Services in every business route capture the same database at startup (`packages/server/src/app.ts`, `routes/assistant.ts`, `routes/ai.ts`). Ledger, assistant history and provider settings are not scoped by account.
- `AuthService.setPassword` clears every user's sessions; password changes already have a per-user variant (`packages/server/src/services/auth-service.ts`).
- Existing SQLite migrations contain 48 business tables plus users/sessions. Only sessions has a user foreign key. Adding registration alone would expose existing ledger data.
- Current seed category/account/template identifiers and many unique keys assume one ledger (`packages/server/src/db/seed.ts`).
- Both iOS and Android have login/restore/logout but no registration or admin capability surface. Backend API changes require updating the Android function inventory under `AGENTS.md`.
- Code submissions and builds must use original repository `yansuui/jizhang`; do not create/use a fork for this task. Existing iOS source is on `feat/ios-assistant`.

## Approved first-delivery scope

| ID | Requirement |
|---|---|
| R1 | Invite-only username/password registration; no open self-registration. Invalid, expired, revoked and consumed codes fail without creating a usable account. |
| R2 | Original configured account becomes the initial administrator; its existing records and encrypted AI configuration remain intact. |
| R3 | Each account has its own ledger, accounts/categories/tags, plans, items/photos, imports, AI conversations and configuration. User A cannot read, modify, export, subscribe to, or cancel User B's resources by guessing IDs. |
| R4 | Administrator generates/copies/revokes invitation codes and sees their state. Default: one registration per code, seven-day expiry. Ordinary users cannot manage invitations or promote themselves. |
| R5 | iOS and Android login screens add a compact registration form (username/password/confirmation/invitation); administrator gets an invitation-management entry. Keep existing financial feature parity boundaries unchanged. |
| R6 | Authentication/session responses identify the actual current user and role. Logout, password changes and same-server account switching cannot leak data or invalidate unrelated users. |
| R7 | Session ownership also covers files, backup listings, background AI/cutout jobs, recovery, SSE and in-memory caches. |
| R8 | Registration and invitation consumption are failure-safe and concurrency-safe. Codes are unpredictable, stored as hashes and never logged; validation is bounded and abuse limited. |
| R9 | Migration is repeatable and recoverable, with verified consistent backups; no implicit live production deployment or ledger reset. |

## Acceptance criteria

- [x] A1 (R1/R4/R8): One valid code can create exactly one account even under concurrent attempts; expired/revoked/replayed codes and malformed input leave no active partial account.
- [x] A2 (R2/R9): Upgrade a populated legacy fixture, verify owner totals/history/provider secret remain intact, restart twice and verify consistent restoration/rollback procedure.
- [x] A3 (R3/R7): Two-user API matrix proves isolation for lists, direct IDs, mutations, nested references, exports, files, SSE, cancellation and background recovery. Both users may use identical seeded IDs without cross-account effects.
- [x] A4 (R4/R6): Ordinary user receives 403 on invitation management; current-user identity and per-user session revocation are correct; administrator UI is gated by server capabilities.
- [x] A5 (R5/R6): Both clients register, log in, switch accounts and discard stale responses/caches; registration has recoverable errors and never persists passwords/invitation codes.
- [x] A6 (R8/R9): Rate/body limits, generic credential failures, no secret logging, failed provisioning recovery and shutdown cleanup are tested.
- [x] A7: Relevant backend/shared lint, types, tests and build pass; Android tests/build and iOS GitHub tests/device build pass. Native UI/device acceptance is recorded separately from fixture tests.

## Out of scope

Shared family/team ledgers, billing/subscriptions, email/SMS delivery, third-party login, web hosting, cross-user AI credentials/billing, account deletion and a full user-management console. Existing iOS read-only financial scope remains; this task does not add every Android editing feature to iOS.

## Approval

The user approved independent private ledgers and AI configurations, original-account administration, single-use seven-day invitations, and compact iOS/Android registration. Shared ledgers are out of scope. Source changes and CI target original repository `yansuui/jizhang`.

## Delivery acceptance

All source and automated acceptance criteria passed. See `verification.md` for original-repository commits, 1,622 backend/shared tests, 90 iOS tests, Android build/test/lint, real-container recovery, and the verified IPA. Production deployment and physical device acceptance remain separate and were not performed.
