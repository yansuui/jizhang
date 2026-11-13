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
| Chat | Real streaming, Stop/recovery, live execution metadata, resource/date cards, readable results/paging, draft revision and confirmed task continuation | Every modification has its own preview/consent; superseded drafts cannot execute; uncertain retries retain the same operation identity |
| AI configuration | Address/key/model, searchable model picker/manual entry, explicit save/test | Advanced fields folded; blank key preserves saved credential; no automatic inference |
| Bills | Visible entry on Home/Bills/Plan, **expense-only** editing (income is recorded as 收入分配) with a calculator-style `+`/`-` amount (live running total, `=` collapses it), centred modal detail card (Android-parity layout), linked refunds, delete, account and month/date-range filters, authoritative per-day expense/income/count summary | A new bill can only be an expense; a pre-existing income bill stays editable and keeps its 资金用途 so historical rows can still be classified. An expense can be marked as a refund and linked to one or more original expenses inside the editor (searchable, paginated, expenses only), or started from an expense's 记录退款 action; a refund with no link is refused before any request; the amount expression is evaluated on-device into one integer cents value and never sent as text; server totals; original expense stays gross while refund is separate linked income; the detail card is an overlay so the tab, filters and scroll position survive; daily totals come only from `/transactions/daily-summary` (whole month, ≤32 days) and are never summed from loaded rows |
| Four-purpose plan | Add allocated income, change current ratios, review income allocations and legacy sources, classify bills that still have no 资金用途, and open a purpose's records | Four fixed purposes, exact 10000-bps totals, frozen historical allocations, server CAS and idempotency; 新增收入分配 is the single income entry and `POST /salaries` freezes the ratio split into a grant, so income never needs a category or purpose; each purpose card opens the evidence behind its balance; the 部分资金待核对 card routes each figure to its repair path (待分配工资 → the allocation sheet, 未归类账单 → a list that assigns one purpose per row); the migration-issue list shows only rows with a corrective action, while open archival `salary`/`transaction`/`period` rows collapse into one 已归档 count |
| Transfers | My → 账户转账 lists account-to-account transfers and can create, edit and delete them (two accounts, amount, date, note) | A transfer is neither income nor expense and never enters statistics; both accounts must be distinct and enabled; the endpoint has no idempotency key, so an unconfirmed submission is checked in the list instead of being retried blindly |
| Other accounting screens | Server-backed stats, accounts, categories, goals, recurring and items | Existing display surfaces retained; additional mutations available through validated AI tools |
| Tags | My → 标签 lists the tag catalog, including migrated names with zero linked bills; the bill editor can select existing tags or accept manually entered names | Existing transaction tags remain unchanged; no separate iOS template surface |
| Historical organization | Start a background analysis of a date range, poll its progress, preview bill category/tag suggestions, select specific actions, prepare/confirm, undo through conversation | No automatic all-selection; note suggestions are reference only; paginated suggestions remain inspectable; template suggestions were retired with the allocation-template surface and are neither produced nor applicable |
| File import | Existing single-file assistant import; native reviewed transaction/transfer CSV; 1–5 merged WeChat/Alipay files with pages, conflict comparison, category/note review, replacement/removal and selected confirmation | Original-file identity, current version/review token and frozen retry body are required; parser limits refuse oversized inputs rather than cropping them |
| Export | Authenticated transaction/salary/recurring/transfer CSV download and system sharing | Same-origin transport; protected temporary files are removed on dismissal, including late responses |
| Item photos | Native photo/file selection, preview/save/remove; cutout progress/cancel/candidate preview and explicit application | JPEG/PNG/WebP input, existing byte/pixel limits; metadata stripped on-device, transparent candidate alpha retained |
| Daily reminders | Device-local 20:00 recording and 21:00 review defaults, independently editable, permission status, entry and review tap routing | Local notifications require OS permission; review begins only after a tap, with persisted owner/date/request recovery; no unattended daily inference |
| Protected native actions | Trusted conversation cards open provider/invitation/password/import/export/photo/reminder flows | Enum routes and actual account capabilities; passwords, invitation plaintext, files and existing API keys stay outside model arguments/history |
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
- Background organization turns hand off a durable task card. The phone observes the existing run with bounded, cancellable GET polling; a temporary read failure can recover, and manual refresh restarts observation without another model request. Known safe stream-failure causes have distinct explanations; unknown provider text is never displayed directly.
- `APIClient.ledgerRevision` invalidates ledger surfaces after successful writes within one API identity. Obsolete sessions cannot broadcast into another account.
- Ambiguous bill/plan/assistant writes retain the same operation/action identity and payload while the current session remains alive. Closing and reopening a sheet must recover that pending operation. Cold-start persistence of manual draft state is not implemented.
- Uploaded bill bytes and selected confirmation payloads remain in memory only for the active assistant store. Reopening an old import card can reattach its original file; mismatched hashes or sizes cannot confirm it.
- Bill detail uses a shared native full-screen presentation with a centred card and transparent/dimmed background. It covers the outer navigation and tab bar and blocks background touches. Closing retains the original screen, active query, loaded pages and scroll position. Long details scroll inside the card; large text adapts field/action layout. The system sheet variant (`LedgerBillDetailSheet`) remains for existing item-detail entry points.
- Type/account/date filters are part of the bill List content and scroll with the records. Daily statistics group the date/count and authoritative expense/income values, with vertical fallback for accessibility text or long amounts.
- Daily totals come exclusively from `GET /transactions/daily-summary?from=&to=&timeZone=` with the displayed calendar zone. The endpoint accepts at most 32 days, so the summary is shown for a whole month and hidden (with an explanation) for "all dates" or a custom range. Decoding is strict and a search revision must match the list page; any mismatch clears the totals instead of fabricating them. Never sum loaded rows.
- Allocation templates are retired: there is no template entry, no `LedgerTemplate` model and no template action in the historical-review sheet. Tag names are the record-level label; existing template rows stay on the server for old clients and are folded into tags by migration 022.
- Historical-organization analysis starts in the background: the assistant tool returns a run id, progress is polled, and the card is readable only once the run is `ready`. One assistant generation must never await the whole batched analysis — that exceeded the server's per-generation deadline and made the second reply fail.
- Each reply may carry a diagnostic execution trace (`GET /assistant/conversations/:id/generations/:id/trace`), rendered as a collapsed timeline under the bubble. It holds bounded metadata only — step ordinal, kind, tool name, an argument summary, status and duration — never model reasoning, provider bodies, prompts or raw bill notes. It is collapsed by default and expands automatically when a step failed, which is how a user finds out where a reply stopped. A trace request that fails never disturbs the conversation.
- `POST/PATCH/DELETE /transfers` carry only `fromAccountId`, `toAccountId`, `amountCents`, `date` and `note`. They have no idempotency key, so the iOS editor submits once per explicit tap and an unknown outcome is confirmed in the list before any retry; a duplicated transfer moves the money twice. A transfer needs two distinct enabled accounts and never becomes income, expense or a category row.
- A refund is an income row with `isRefund` and one or more `refundLinkedTxIds`. The editor's picker pages `GET /transactions?type=0` (expenses only) and the server re-validates that every link exists, is not deleted, is an expense and is not itself a refund. Turning the flag off drops the links; a refund without a link is rejected locally, before any request, and never counts as an unconfirmed submission.
- A presentation request is queued per entry point, not per tap: every "记一笔" request shares one slot, so repeat taps (or a reminder arriving while the editor is open) replace the pending request instead of stacking another sheet after dismissal. Only a request that actually failed to present shows the waiting banner, and it is re-armed automatically a bounded number of times before the manual retry takes over.
- `GET /financial-funds/migration-issues` returns archival history, not a task list. Only an open `salary`/`unallocated` issue whose source is still provable carries `source`, and only that row is presented as 待分配收入; open `salary`/`transaction`/`period` rows are already represented by live facts (the salary grant, the bill's 资金用途) and are summarized as one 已归档 count instead of an unactionable "来源状态尚不完整" line per row. A row of any other kind (for example `config`/`invalid-current-config`) still keeps the fund configuration unavailable and is shown as server-side work. That queue never shortens on its own: the server resolves only salary issues, so bill rows stay `open` after the purpose is classified.
- The plan page's coverage card is computed from live facts, so it never clears through that archive. `未归类账单` therefore pushes a repair list: `LedgerUnclassifiedBillsView` reads authoritative `/transactions` pages (100 rows) and keeps only live, non-refund rows whose `fundPurpose` is null, because the endpoint has no purpose filter. One purpose is written per row with a guarded `PATCH /transactions/:id` (`operationId`, `fundPurpose`, plus `expectedFundPurposeRevision`/`expectedTransactionToken` read from `/financial-planning/bill-purposes/:id`). A 4xx other than 408 is a rejection and keeps the row editable; any other outcome freezes the exact body and offers 重试, so the same operation id replays instead of writing a second purpose revision.
- Income is no longer a bill kind: `LedgerTransactionEditor` offers only 支出 for a new bill and points at 计划 → 新增收入分配, while `/salaries` stays the single income entry and the server freezes its ratio split into a grant, so income needs neither a category nor a purpose. A pre-existing income bill is still editable (it keeps its type picker and 资金用途) so historical rows can be classified, and refunds remain income transactions because they must link to their original expenses. Income therefore no longer appears in the bill list or the bill page's per-day income totals; the monthly trend still counts recorded salaries.
- An old income bill can be converted instead of classified (`转为分配` in the bill card, `按比例分配到四用途` on an income row of the unclassified list): `POST /salaries` carries the bill's amount/date/account/note and its operation id is retained, then `DELETE /transactions/:id` removes the bill (404 counts as already deleted). Both steps are resumable — an unknown grant result replays the same operation, and a created grant whose delete failed keeps the row with a retry that only deletes, so the money is never counted twice.
- A purpose card opens `LedgerFundDetailView`, which shows the evidence behind the cumulative balance rather than recomputing it: recorded allocations from `/salaries` (the exact frozen share for this purpose is read per visible row from `/salaries/:id`, because the list omits `fundGrant`) and live bills whose `fundPurpose` matches, selected client-side from authoritative `/transactions` pages. Rows are never summed into a balance.

## Verification record

Native compilation, XCTest, simulator launch and device installation are recorded separately in the task delivery evidence. A Windows source review alone is not a build. Live-provider behavior also requires a configured backend and explicit interaction.

The current bill modal/filter/statistics continuation is verified at code commit `f381bfc` by [native run 42147423830](https://github.com/yansuui/jizhang/actions/runs/42147423830): 133 XCTest cases passed and the Release arm64 IPA was packaged. See [the delivery record](../../.trellis/tasks/11-04-ios-assistant/bill-ui-polish-verification.md) for exact source, visual checks, local IPA and checksum. Physical-device interaction remains separate acceptance.

Initial implementation and verification are tracked in [the iOS task](../../.trellis/tasks/11-04-ios-assistant/implement.md). No production API deployment is included in this client delivery.

Multi-user source and mocked-network coverage are tracked in [the multi-user task](../../.trellis/tasks/11-05-multiuser-invites/implement.md). The added tests cover registration validation, additive identity/capability decoding, cookie-free registration, failed registration preserving saved credentials, required session cookies, account replacement, invitation create/revoke/403, duplicate submission and late results after leaving. Simulator preview tests include registration at compact width and invitation management with large text. These are test sources until the macOS CI run passes; physical registration/invitation interaction and device installation remain separate acceptance checks.

The app icon reuses the existing Android brand artwork, converted to the iOS asset-catalog size; no new brand is introduced.

2026-11-06 conversational workspaces and daily reminders: [native run 42233753337](https://github.com/yansuui/jizhang/actions/runs/42233753337)
at `b5d9013` passed **214 XCTest cases, zero failures**, and Release iPhone arm64
packaging (build **22**, Xcode 16.4). The matching backend is `d32b044`:
[run 42229314232](https://github.com/yansuui/jizhang/actions/runs/42229314232) passed all four
backend/Android/container/cutout jobs, including **405 shared + 1380 server tests** and
13 private image-service tests. Upgrade the server with the app; upgrade the optional
cutout worker for native JPEG/PNG input. See [the final verification record](../../.trellis/tasks/11-04-ios-assistant/harness-verification.md)
for actual screenshot review, exact artifact source/checksum and the signed-device/live-provider
acceptance boundary. Local reminder permission and physical delivery require the phone.

2026-11-06 assistant reliability: [native run 42179267691](https://github.com/yansuui/jizhang/actions/runs/42179267691)
at `d3eddc3` passed **142 XCTest cases, zero failures**, and unsigned iPhone arm64
packaging with Xcode 16.4. Build **14** is 2,698,116 bytes, SHA-256
`cb83e009bb158eba8b2356382b9597b0f27322a9728f8ac0aee58015b173dd8a`.
The matching backend repair is `ebc8086` (no subsequent native source changes), whose
[verification run 42180534737](https://github.com/yansuui/jizhang/actions/runs/42180534737)
passed repository lint/typecheck/build, **405 shared + 1315 server tests**, Android
unit/package/lint and isolated production-container lifecycle checks. Deploy the server
repair as well as updating the app: IPA replacement alone cannot fix orchestration.
See [reliability verification](../../.trellis/tasks/11-04-ios-assistant/assistant-reliability-verification.md)
for workflow evidence, verified local IPA and the separate live-provider/device boundary.

2026-11-05 bill/detail/tag work (modal bill card with bottom capsule actions, authoritative daily totals, template removal, tag-first catalog, background historical analysis) was verified by [iOS build and IPA run 42013499694](https://github.com/yansuui/jizhang/actions/runs/42013499694) on commit `b114d1f`: Xcode 16.4 on `macos-15-intel` ran **129 XCTest cases with 0 failures** (12 suites; includes the two added previews `testCentredBillDetailOverlayPreview` and `testDaySummaryHeaderPreview`, whose simulator renders were reviewed), built the arm64 device app and packaged `Jizhang-unsigned.ipa` (2,627,321 bytes, SHA-256 `36feac9e012d5fb9a8019f4e56c9b6249ea65b28f618911c3bdf2ee6806958a0`). The server side of the same change passed `pnpm lint`, `pnpm typecheck`, `pnpm build` and 405 shared + 1244 server tests. **Still unverified:** physical-device installation and interaction (Sideloadly signing, real taps, scroll and Dynamic Type on hardware), and live-provider behaviour for the new background analysis flow.
