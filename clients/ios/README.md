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
| Bills | Visible entry on Home/Bills/Plan, expense/income editing, centred modal detail card (Android-parity layout), linked refunds, delete, account and month/date-range filters, authoritative per-day expense/income/count summary | Server totals; original expense stays gross while refund is separate linked income; the detail card is an overlay so the tab, filters and scroll position survive; daily totals come only from `/transactions/daily-summary` (whole month, ≤32 days) and are never summed from loaded rows |
| Four-purpose plan | Add allocated income, change current ratios, review income allocations and legacy sources | Four fixed purposes, exact 10000-bps totals, frozen historical allocations, server CAS and idempotency |
| Other accounting screens | Server-backed stats, accounts, categories, goals, recurring and items | Existing display surfaces retained; additional mutations available through validated AI tools |
| Tags | My → 标签 lists the tag catalog, including migrated names with zero linked bills; the bill editor can select existing tags or accept manually entered names | Existing transaction tags remain unchanged; no separate iOS template surface |
| Historical organization | Start a background analysis of a date range, poll its progress, preview bill category/tag suggestions, select specific actions, prepare/confirm, undo through conversation | No automatic all-selection; note suggestions are reference only; paginated suggestions remain inspectable; template suggestions were retired with the allocation-template surface and are neither produced nor applicable |
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
- Bill detail is a centred modal overlay on top of the list, not a navigation push: closing it keeps the tab, the active query, the page offset and the scroll position. The system sheet variant (`LedgerBillDetailSheet`) remains only for entry points that already present a sheet, such as item detail.
- Daily totals come exclusively from `GET /transactions/daily-summary?from=&to=&timeZone=` with the displayed calendar zone. The endpoint accepts at most 32 days, so the summary is shown for a whole month and hidden (with an explanation) for "all dates" or a custom range. Decoding is strict and a search revision must match the list page; any mismatch clears the totals instead of fabricating them. Never sum loaded rows.
- Allocation templates are retired: there is no template entry, no `LedgerTemplate` model and no template action in the historical-review sheet. Tag names are the record-level label; existing template rows stay on the server for old clients and are folded into tags by migration 022.
- Historical-organization analysis starts in the background: the assistant tool returns a run id, progress is polled, and the card is readable only once the run is `ready`. One assistant generation must never await the whole batched analysis — that exceeded the server's per-generation deadline and made the second reply fail.

## Verification record

Native compilation, XCTest, simulator launch and device installation are recorded separately in the task delivery evidence. A Windows source review alone is not a build. Live-provider behavior also requires a configured backend and explicit interaction.

The subsequent tag-catalog picker, fixed bottom actions and background-run status UI changes have not yet been compiled by the previously recorded run; verify their exact commit with macOS CI before distributing an IPA.

Initial implementation and verification are tracked in [the iOS task](../../.trellis/tasks/11-04-ios-assistant/implement.md). No production API deployment is included in this client delivery.

Multi-user source and mocked-network coverage are tracked in [the multi-user task](../../.trellis/tasks/11-05-multiuser-invites/implement.md). The added tests cover registration validation, additive identity/capability decoding, cookie-free registration, failed registration preserving saved credentials, required session cookies, account replacement, invitation create/revoke/403, duplicate submission and late results after leaving. Simulator preview tests include registration at compact width and invitation management with large text. These are test sources until the macOS CI run passes; physical registration/invitation interaction and device installation remain separate acceptance checks.

The app icon reuses the existing Android brand artwork, converted to the iOS asset-catalog size; no new brand is introduced.

2026-11-05 bill/detail/tag work (modal bill card with bottom capsule actions, authoritative daily totals, template removal, tag-first catalog, background historical analysis) was verified by [iOS build and IPA run 42013499694](https://github.com/yansuui/jizhang/actions/runs/42013499694) on commit `b114d1f`: Xcode 16.4 on `macos-15-intel` ran **129 XCTest cases with 0 failures** (12 suites; includes the two added previews `testCentredBillDetailOverlayPreview` and `testDaySummaryHeaderPreview`, whose simulator renders were reviewed), built the arm64 device app and packaged `Jizhang-unsigned.ipa` (2,627,321 bytes, SHA-256 `36feac9e012d5fb9a8019f4e56c9b6249ea65b28f618911c3bdf2ee6806958a0`). The server side of the same change passed `pnpm lint`, `pnpm typecheck`, `pnpm build` and 405 shared + 1244 server tests. **Still unverified:** physical-device installation and interaction (Sideloadly signing, real taps, scroll and Dynamic Type on hardware), and live-provider behaviour for the new background analysis flow.
