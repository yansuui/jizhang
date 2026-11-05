# Native client audit: multi-user accounts and invite registration

Date: 2026-11-05. Research only; no product changes, builds, device checks, or new tests were performed. This note describes source evidence and recommended scope, not an approved API contract.

## Read before implementation

- Root `AGENTS.md`: changes to Android UI, repositories, or API contracts consumed by Android require corresponding stable-ID updates in `clients/android/README.md`; source, automated, and device evidence must remain separate.
- `.trellis/spec/frontend/index.md`, `ios-client.md`, and `quality-guidelines.md`: native Android/SwiftUI clients, API-only server, Chinese product UI, English engineering documentation, strict session ownership, monetary computation retained on the server/shared layer.
- Android inventory: authentication/account entries P003–P015, navigation P020, logout P033, data backup D023–D026, AI configuration A041/A056/A060 and API coverage.

## Current authentication and ownership

| Surface | Source evidence | Consequence |
| --- | --- | --- |
| Android authentication | `AuthRepository.kt:19,29,53,59,79` stores only a nullable username, consumes JSON from `/auth/me` and `/auth/login`, advances request generation before login and on logout. | There is no user ID, role, capability, registration method, or invitation repository. An explicit authenticated-user value is needed before permission-aware UI can be reliable. |
| Android login | `LoginScreen.kt:47,50,199,207,228,262` is a single-account username/password form, has separate server settings, and directs first use to `set-password`. | Add a small native registration route/form reached from login; replace the single-user guidance while retaining server-address setup. |
| Android root | `MainActivity.kt:66–105` switches between `MainShell` and `LoginScreen` using `signedIn`; session expiration clears this flag. | Existing logout removes the shell. New account changes must go through this reset, or explicitly key shell lifetime by authenticated user/session generation. Do not reuse live account A screen state under B. |
| Android network ownership | `ApiRequestIdentity.kt` and `ApiRequestOwner.kt` use normalized server base URL plus monotonically advanced generation. `ApiTransport.kt:58,92,104` attaches cookies, accepts Set-Cookie only for current generation, and invokes global expiration on every 401 except `/auth/login`. | Retain generation checks for registration and account transitions. Registration is public authentication too: a local registration error must not expire a different account or accept old callbacks. Public login/registration should not carry a previous account cookie. |
| iOS authenticated DTO | `Core/APIClient.swift:213` defines `AuthenticatedUser` with only `username` and `expiresAt`. | Add stable user identity and permission information without removing these existing fields. |
| iOS session | `App/AppSession.swift:46,59,71,97,135` restores only after `/auth/me`, signs in with a fresh client (`restoreSession: false`), rejects missing/expired session cookies, invalidates candidate/previous clients, and guards unauthorized callbacks by API UUID. | Reuse this path for registration completion. A successful registration response needs a valid session cookie if the UX signs in immediately. Do not install authenticated state based on username alone. |
| iOS root | `App/JizhangApp.swift:20–21` gives `MainTabView` `.id(api.identity)`. | Existing account replacement already recreates tab state, conversation stores, and provider drafts. Pass the authenticated user into the shell/My screen for account display and administrative entry visibility. |
| iOS credential persistence | `Core/SessionCredentialStore.swift:42–85` stores a cookie in Keychain by service plus server origin. `AppSession.swift:29,152` remembers one username in UserDefaults. | This is one active account per server, not a multi-account credential vault. Ordinary logout/login account switching fits the minimum change. Never persist registration passwords or invite codes. |

The clients should receive a server-issued stable user ID and role/capabilities from both login and `/auth/me`. A client-supplied user ID must never select which ledger the server reads. Native visibility is a usability layer; the server remains the authorization boundary.

## Minimal mobile interaction

1. Keep login as the default screen. Add “邀请码注册” that opens a native form with invite code, username, password, and password confirmation. Retain the current separate server-address control. Avoid adding an email/phone/recovery workflow without a requirement.
2. Trim username and invite code according to the eventual server contract; do not trim the password. Show bounded field errors, disabled/busy submit state, and a visible server failure with a retry path. Invalid/expired/used invitation handling should share intentional copy if the server avoids revealing invitation state.
3. Recommended completion: registration returns the same auth envelope and session cookie as login, then enters the app through the existing session activation path. If the chosen server contract instead requires a subsequent login, preserve only the entered username and explicitly clear secret fields.
4. Show current username in “我的”, with a concise role badge only if useful. Android currently explicitly omits it (P033); iOS currently shows the generic ledger name and server host (`Features/My/MyView.swift:11–18`).
5. Add “邀请码管理” under “我的” only for server-granted invitation management capability. A single list can show status and expiration, with “创建邀请码”, copy/share immediately after creation, and revoke for an active invitation. Use server-defined fixed defaults for expiry/use count to avoid a configuration-heavy mobile form. Exact expiry, usage policy, and owner/admin distinction remain product decisions.
6. Invite code paste is sufficient for the first version. Android has no current URL deep-link entry (P037), and no native deep-link implementation is required merely to support invite registration. Do not fabricate a web registration route; this is an API-only project.

Likely implementation surfaces:

- Android: `AuthRepository.kt`, `ApiTransport.kt`/`ApiClient.kt`, `LoginScreen.kt`, `MainActivity.kt`, `MainShell.kt`, `MyTab.kt`, a small invitation DTO/repository/screen, relevant scoped preference code, and `DataTab.kt` permission gating.
- iOS: `Core/APIClient.swift` auth DTO, `Core/APIError.swift`, `App/AppSession.swift`, `App/LoginView.swift`, `App/JizhangApp.swift`, `Features/My/MyView.swift`, and invitation DTO/store/view. Regenerate checked-in Xcode source/test membership with `python3 clients/ios/scripts/generate_project.py` after adding files.

## Durable Android state requires special care

Current durable scoping already separates different usernames on the same server:

- `ui/FinancialPrefs.kt:33–66,80–112`: verified `/auth/me` username is used with server base URL for home budget mode.
- `ui/RecordingDefaults.kt:54–77`: remembered default recording account uses server plus username and validates active account availability before use.
- `ui/FinancialPrefs.kt:187–208`: `OperationReplayStore` stores unresolved financial operation payloads under a server-plus-username hash. These are potentially consequential future writes, not just cosmetic preferences.

Prefer stable user ID for new durable scopes. A username rename, deletion/recreation, or future case-normalization change must not transfer a previous user's pending operation to another principal. Migration should be conservative: home-display preferences can be deliberately migrated after verified identity, but old pending operations must only be adopted when their original owner is proven. Otherwise preserve them as legacy unresolved data and explain recovery rather than replaying or silently discarding them. If the product keeps immutable, never-reused usernames initially, document that restriction explicitly; stable IDs are still the better contract.

Appearance preferences can stay device-wide. No need to turn theme/icon settings into account-specific server configuration.

## AI configuration: personal versus shared

Both clients currently call the same unqualified AI endpoints: Android `repo/AssistantRepository.kt:206–210` uses `/api/v1/ai/config`; iOS `Features/Settings/ProviderSettingsStore.swift:43,65,82` and `Assistant/AssistantStore.swift:98` use `/ai/config`. No client account selector exists in the payload. The native provider forms already preserve hidden secrets and do not need a user ID field to become per-user: the server can derive ownership from the session.

Recommended minimum for independent users: each user has their own conversations, provider connection/configuration, and key; the migrated existing user retains the current configuration, while a new account starts unconfigured. Keep the iOS three-field main setup and existing advanced options. Retain explicit save/model fetch/test actions, blank secret preservation, and late-response rejection on logout/account change. Configuration must not expose another user's saved headers, API key presence, model history, or connection details.

If the intended product instead shares the owner's provider and bill, this is a separate permission and cost policy: ordinary users should not be allowed to edit/reveal its connection settings, and the server needs explicit usage boundaries. Do not implicitly share an existing key by cloning the old singleton configuration. Similarly, invite-manager status should not automatically grant visibility into other users' conversations or ledger records unless that is an explicit product decision.

## Administrative and compatibility boundaries

- Android `DataTab.kt:98–116` automatically loads backups on opening the screen. `repo/PortabilityRepository.kt:51–55` lists/creates `/backups`. Inventory D023–D025 says these are whole-server SQLite snapshots, with no native download/restore endpoint. In a multi-user server, gate the loader and backup section to appropriate capability, and enforce the same server-side restriction. Keep personal CSV import/export available to ordinary users after server isolation. iOS backup/import/export currently are informational placeholders (`Features/My/MyView.swift`), so do not claim these are implemented.
- `AdminRepository.kt` manages categories/accounts/tags, despite its name; these are normal personal-ledger controls and should not become owner-only merely because of the class name.
- Preserve `username` and `expiresAt` in auth responses so old Android/iOS clients can continue logging in. Additive response fields are compatible with JSONObject/Swift Decodable. Unknown or absent permission fields in a new client must never imply administrator access.
- Decide support for new clients connected to old single-user servers. Safe options are explicit capability discovery or a readable registration-unavailable response; do not emulate invitation acceptance locally or silently register through login. A missing role should hide administrative UI, not guess that the username is the owner.
- iOS `Core/APIError.swift:17–25` maps known error codes to safe localized text rather than echoing arbitrary response bodies. Add registration, invite management, and forbidden-action codes to that mapping. Keep public registration errors separate from global authenticated-session expiration.
- Existing automatic restore should continue requiring `/auth/me`; cached username/role is not authoritative. Refresh/relogin must recover permission changes safely, while server authorization protects stale UI immediately.

## Verification and documentation work to budget

- Extend Android `ApiTransportTest`/`NetworkContractTest` around public-auth errors and cookie-free registration; exercise login/register A-to-B-to-A with late 401/Set-Cookie and late AI/config completions.
- Add meaningful auth DTO/session tests: missing/invalid identity, old additive-compatible envelope, cookie required on successful auto-login registration, denied/missing role hides invitation actions, sign-out clears account data and cancels in-flight work.
- Test stable identity scopes for home/default-account preferences and, especially, unresolved financial operation replay. Ensure a recreated username cannot read or replay the previous owner's operations.
- Test invitation UI/store states for creation, list, revocation, used/expired errors, duplicate taps, cancellation, and role rejection. Server tests must prove ownership and consume-once concurrency; UI tests alone cannot prove isolation.
- iOS existing `CoreAPIClientTests.swift` covers login cookie handling, current/stale unauthorized callbacks, persistence expiry, and fresh-client behavior; extend these contracts. Windows cannot execute Xcode tests; use the existing macOS GitHub build workflow after implementation. Source/build evidence must remain separate from Sideloadly/device installation.
- Android required gate remains `testDebugUnitTest`, `lintDebug`, and `assembleDebug`; run after the changes, not during this research-only pass.
- Update Android stable inventory entries P003/P004/P007/P011–P013/P020/P033, applicable API coverage, D023–D025 for backup permissions, A041/A056/A060 for configuration ownership, and the change log. Add fresh stable IDs for invitation-specific features. Advance only affected source-audit dates. Document native source support separately from backend capability and device acceptance.

## Decisions for the parent task

The minimal coherent proposal is independent user ledgers, invite-only registration, existing owner retained, owner/admin invitation controls, and per-user AI setup. User-level ledger ownership and global-server administration must remain separate. Confirm scope/contract through the parent task's planning flow before implementation; this audit does not approve schema, endpoint names, invite limits, role taxonomy, or rollout.
