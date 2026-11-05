# Native multi-user implementation

Source review completed 2026-11-05. Product scope was approved before implementation. This note records source changes and local checks, not a passing native build or device acceptance. Root owns GitHub CI/delivery evidence.

## iOS

- Added registration as a compact native sheet from login, with username/password/confirmation/invitation, password visibility, field validation and automatic session activation.
- Authentication retains legacy username/expiry fields and accepts optional immutable ID/role/capabilities. Missing/unknown permissions never enable administration. Registration requires an ID and a valid received session cookie; old servers may still perform ordinary login.
- Login/register use fresh API clients. Public authentication carries no saved cookie and a rejection cannot expire an unrelated saved session. Decode/expiry/registration-ID checks happen before cookie persistence.
- `AppSession.user` carries the verified identity; each activated API UUID recreates all main tabs and feature stores. My shows the current user and only exposes invitations to a server-granted administrator.
- Invitation list/create/copy-once/revoke has serialized operations, current-request tickets, permission-rejection cleanup and late-response rejection after leaving. Plaintext is memory-only; explicit clipboard copy is device-local with a ten-minute maximum expiry.
- Added 13 test methods: 9 multi-user contract/network/state tests, 2 core auth-cookie tests, and 2 real simulator preview test sources (compact registration and large-text invitation management).
- Regenerated checked-in Xcode project: 32 application files and 9 test files. Source membership and whitespace checks passed. Swift/Xcode are unavailable on Windows; native XCTest/build and screenshots require the root's GitHub run. No physical-device acceptance asserted.

## Android

- Added additive `AuthenticatedUser`, bounded `RegistrationDraft`, registration UI, invitation repository/DTOs and capability-gated My invitation screen. Codes/passwords are not saved in preferences or instance state.
- Public POST login/register never carry prior cookies, refuse redirects, do not trigger global expiration on 401, and cannot save cookies from failed or malformed responses. A successful public-auth response must supply a usable `jizhang_session` matching `/auth/me`; an existing saved cookie cannot substitute for it.
- Root shell is keyed by `AuthRepository.sessionKey`, renewed on verified restore/activation. Transport generation checks continue rejecting stale responses before and after reading. Invite screen coroutines are composition-owned and cancelled on leaving; no account B UI reuses account A's invite state.
- Added 9 JVM test methods covering identity/capability fallback, field validation, same-name/different-ID durable isolation, public-auth cookie failure/success/missing-cookie behavior, redirect refusal and invitation wire status/path behavior. Existing login-401 transport test now uses the real POST method.
- Updated Android maintained catalogue: P042-P045 added without reusing IDs; affected existing authentication/navigation/backup/provider fields and API coverage updated. New main Kotlin files are listed. Full catalogue dates were not advanced.

## Durable ownership and legacy-record review

The final source search covered all main Android Kotlin `username`, `FinancialScope`, SharedPreferences/DataStore and replay-store calls, including nullable accesses and financial identity comparisons.

`FinancialScope` retains the display username and adds verified immutable `userId`. `storageIdentity` uses the server ID for new servers and a legacy username only when the server omits ID. Resolution checks API request generation as well as server address before/after `/auth/me`.

Updated consumers:

- Dashboard home mode and transaction recording-account defaults.
- Transaction pending writes, CAS recovery and ownership comparisons.
- Salary pending-operation adapter, salary prompt/sheet and existing-salary execution.
- Manual-goal pending-operation adapter.
- Financial execution workspace, configuration, category mappings and refund splits.
- Assistant batch mutation recovery keys. Platform import owner objects already contain the full `FinancialScope`, so their equality now includes ID automatically.

New pending operations use `op_v2_` prefixes; home/default-account keys use corresponding v2 prefixes; assistant batch recovery adds `v2|`. Existing username-only records remain untouched and are not copied, replayed, deleted, or assigned to a new same-named user. My detects retained legacy financial/assistant records and explains that the user should reconcile server records before operator-assisted recovery. No automatic migration of ambiguous pending financial requests is provided.

Remaining `username` uses are display/authentication, the verified DTO-to-scope construction, legacy-record detection, and existing helper parameter names whose call sites now pass `storageIdentity`. All production financial write/recovery call sites were checked; none still pass a raw scope username. Appearance preferences remain device-wide.

## Verification and delivery limits

- `git diff --check -- clients/android` and iOS equivalent passed.
- Verified P001-P045 are unique and all 5 new Android main Kotlin files have maintained inventory entries.
- Local Android attempt used JDK 17 and `:app:testDebugUnitTest :app:lintDebug :app:assembleDebug`. It never reached configuration/tests: the Gradle wrapper reported a 120-second exclusive-access timeout on `gradle-8.7-bin.zip`. No Android SDK was found in inspected local locations. Root has prepared Ubuntu GitHub CI for the actual gates; this is not a pass claim.
- No production server deployment, device installation, real-provider invocation or physical interaction was performed by this worker.
- Backend API contract was confirmed directly with the identity worker. Additional revoke conflict `409 INVITATION_USED` is localized on both platforms.
