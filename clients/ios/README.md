# Jizhang for iPhone

Native SwiftUI client for iOS 17 and later. It uses the same authenticated Fastify API as Android, including invitation registration and isolated user ledgers. The current delivery adds bill entry/refunds, account/date filtering, four-purpose allocation editing and confirmed AI business actions.

## Build and install from Windows

The GitHub workflow [iOS build and IPA](../../.github/workflows/ios.yml) uses a macOS 15 Intel runner with Xcode 16.4. It runs XCTest on an available iPhone simulator, builds the device app for arm64, and packages an unsigned IPA. Apple ID credentials and signing certificates are not required by CI.

1. Push the iOS source and workflow to your GitHub repository. The workflow runs on iOS changes; it also supports manual dispatch.
2. Wait for a successful run. Download its `Jizhang-ios-<run number>` artifact, containing `Jizhang-unsigned.ipa`, `SHA256SUMS.txt`, `build-metadata.json`, and a real simulator launch screenshot.
3. Or use the PowerShell helper with the exact successful run ID:

   ```powershell
   .\clients\ios\scripts\download-ipa.ps1 -RunId <run-id> -Repository <owner>/jizhang
   ```

   It verifies both the IPA checksum and the artifact's commit against the selected run.

4. Open the IPA in [Sideloadly](https://sideloadly.io/), select your connected iPhone and use your Apple ID locally to sign/install. On this workstation, the existing application is `D:\Sideloadly\Sideloadly.exe`.
5. Complete any iPhone trust or Developer Mode prompt. Keep the app's bundle identifier stable when updating so iOS can retain its local session. The server remains the authoritative store for accounting data.

Sideloadly documents device trust, Developer Mode and signing renewal in its [official FAQ](https://sideloadly.io/faq). A free account's signing expires after seven days; its automatic refresh feature requires the computer to reach the device. Installation is separate from a successful GitHub build.

## Local Mac build

No CocoaPods, XcodeGen or third-party Swift packages are required. Open `Jizhang.xcodeproj`, choose the `Jizhang` scheme and an iPhone simulator. Add your own signing team only when installing directly from Xcode.

The project is checked in and generated deterministically. After adding/removing Swift files:

```sh
python3 scripts/generate_project.py
xcodebuild -project Jizhang.xcodeproj -scheme Jizhang -sdk iphonesimulator \
  -configuration Debug CODE_SIGNING_ALLOWED=NO build
```

Run the same build/test/package sequence as Actions:

```sh
bash scripts/ci-build.sh
```

The generated project contains app and XCTest targets. The script selects a simulator compatible with the selected Xcode SDK rather than assuming a particular device UUID. Native build output stays in the ignored `build/` directory.

## Feature inventory

| Area | Intended behavior | Boundary |
|---|---|---|
| Login/session | Configurable HTTPS server, login, invite-only registration, verified session restoration, logout | A successful registration requires a stable account ID and session cookie; server/account changes replace request and screen ownership |
| Invitations | Administrator-only My entry: create, copy once, list status/expiry and revoke | Single use, seven-day validity; server capability required; codes/passwords are never persisted in preferences |
| Navigation | Home, Bills, Plan, Assistant, My | iPhone native navigation, safe areas and system appearance |
| Conversations | Full-width history, title search/date groups, creation, selection, archive | Stable server IDs, no narrow fixed-width cards |
| Chat | Text generation, streaming, Stop, clarification, history, reconnect, detailed business results and confirmation/cancellation | Every financial write requires explicit confirmation of its persisted action; lost responses reconcile/retry the same action ID |
| AI configuration | Address/key/model, searchable model picker/manual entry, explicit save/test | Advanced fields folded; blank key preserves saved credential; no automatic inference |
| Bills | Visible entry on Home/Bills/Plan, expense/income editing, compact detail sheet, linked refunds, account and month/date-range filters | Server totals; original expense stays gross while refund is separate linked income; mutations use existing operation identity/revision contracts |
| Four-purpose plan | Add allocated income, change current ratios, review income allocations and legacy sources | Four fixed purposes, exact 10000-bps totals, frozen historical allocations, server CAS and idempotency |
| Other accounting screens | Server-backed stats, accounts, categories, goals, recurring and items | Existing display surfaces retained; additional mutations available through validated AI tools |
| Historical organization | Preview bill category/tag/template suggestions, select specific actions, prepare/confirm, undo through conversation | No automatic all-selection; note suggestions are reference only; paginated suggestions remain inspectable |
| File import | Attach a single WeChat XLSX or Alipay CSV, review rows/categories/notes, select 1–100 rows and confirm | Original-file SHA-256/size required; 5 MB limit; merged multi-file workspace remains available in Android |
| Backups/admin | Existing read results and trusted UI | No model access to account secrets, unrestricted filesystem operations or offline restore |

The current plan surface follows the backend's continuous four-purpose fund contracts. Cumulative balances are not presented as a monthly reset. Ordinary income/expense views retain their server-defined refund treatment.

## Contracts

- API paths remain under `/api/v1`; mutations require `X-Requested-With: fetch`.
- Authentication consumes additive `id`, `role` and `capabilities` fields. Old servers can still log in; missing permissions hide invitation administration. Registration uses `/auth/register` and never sends a previous account cookie. Public login/registration failures cannot clear another saved account's session.
- Registration validates a 3–64 character ASCII username (letters/digits/`_.-`), an 8–128 UTF-16-unit password plus matching confirmation, and an invitation code. Only username/code outer whitespace is trimmed. The server remains authoritative; successful registration automatically enters the account after validating its cookie.
- Invitations use `/admin/invitations`; one-time plaintext is only held while its screen is open. Copy is local to the device and expires from the clipboard after at most ten minutes. Unknown/missing permissions never imply administrator access. A rejected admin request removes sensitive invitation presentation.
- Accounts have separate ledger data, conversations and provider configuration on the multi-user backend. The iOS shell and feature stores are recreated for each activated API identity; credentials represent one active account per server, not a multi-account vault.
- Session cookie is `jizhang_session`. A restored username does not establish authentication; `/auth/me` must succeed.
- Money uses integer cents and timestamps use epoch milliseconds. Server results own balances, totals and financial windows.
- AI secrets remain encrypted server-side. Model discovery uses saved configuration; the phone never receives an existing plaintext key.
- Same-draft retries keep their request ID. A disconnect reconciles the same generation; it does not automatically create another model request.
- Drafts, messages and in-flight work belong to a server/session/conversation identity. Changing server or expiring a session cannot publish into a newer one.
- Generated previews do not confirm ledger changes. A reply being complete does not mean money was recorded.
- `APIClient.ledgerRevision` invalidates ledger surfaces after successful writes within one API identity. Obsolete sessions cannot broadcast into another account.
- Ambiguous bill/plan/assistant writes retain the same operation/action identity and payload while the current session remains alive. Closing and reopening a sheet must recover that pending operation. Cold-start persistence of manual draft state is not implemented.
- Uploaded bill bytes and selected confirmation payloads remain in memory only for the active assistant store. Reopening an old import card can reattach its original file; mismatched hashes or sizes cannot confirm it.

## Verification record

Native compilation, XCTest, simulator launch and device installation are recorded separately in the task delivery evidence. A Windows source review alone is not a build. Live-provider behavior also requires a configured backend and explicit interaction.

Initial implementation and verification are tracked in [the iOS task](../../.trellis/tasks/11-04-ios-assistant/implement.md). No production API deployment is included in this client delivery.

Multi-user source and mocked-network coverage are tracked in [the multi-user task](../../.trellis/tasks/11-05-multiuser-invites/implement.md). The added tests cover registration validation, additive identity/capability decoding, cookie-free registration, failed registration preserving saved credentials, required session cookies, account replacement, invitation create/revoke/403, duplicate submission and late results after leaving. Simulator preview tests include registration at compact width and invitation management with large text. These are test sources until the macOS CI run passes; physical registration/invitation interaction and device installation remain separate acceptance checks.

The app icon reuses the existing Android brand artwork, converted to the iOS asset-catalog size; no new brand is introduced.
