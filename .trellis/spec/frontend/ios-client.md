# Native iPhone client contracts

## 1. Scope / trigger

Applies to `clients/ios`, its Xcode project and `.github/workflows/ios.yml`. The approved continuation includes bill/refund editing, account/date filters, four-purpose allocation editing and explicit AI action execution. See `clients/ios/README.md` for supported and deferred behavior; native multi-file import and physical-device acceptance remain separate.

## 2. Signatures

- `APIClient.request<Response: Decodable>(_:method:body:)` is the JSON transport boundary.
- `APIClient.stream(_:)` provides authenticated `URLSession.AsyncBytes` for SSE.
- Each client owns an immutable `identity` and `baseURL`; `invalidate()` cancels that session's work.
- Cookie name is `jizhang_session`; mutations require `X-Requested-With: fetch`.
- `python3 clients/ios/scripts/generate_project.py` generates the checked-in project from source/test files without XcodeGen.
- `bash clients/ios/scripts/ci-build.sh` runs native tests, builds an unsigned device app and packages it.
- `download-ipa.ps1 -RunId <id> -Repository <owner>/jizhang` verifies both artifact checksum and source commit.

## 3. Contracts

Native source uses Swift language mode 5 and iOS 17-compatible APIs. Keep app/test project membership synchronized using the generator after adding or removing Swift files. The scheme is `Jizhang`, app module `Jizhang`, bundle ID `com.yansuu1.jizhang.ios`.

Use a dedicated ephemeral URLSession and server-scoped Keychain credentials; preserve cookie domain/path/Secure/expiry behavior. Reject credentialed redirects. A saved username is not authentication: restore requires a successful `/auth/me`. Server/session change must reject stale callbacks and replace feature ownership. Never log passwords, keys or cookies.

Invitation registration uses the same fresh-session activation as login and never
sends the old account's cookie. Validate the complete auth DTO and accepted session
before persisting credentials. A failed public login/register request must not
expire an existing saved account. New auth fields (`id`, `role`, `capabilities`)
are additive for legacy login, but registration requires immutable `id`; admin UI
requires both role `admin` and capability `manageInvitations`. No local username or
missing capability grants admin access. Plaintext invitation codes exist only in
the creation view and are cleared when leaving; never persist passwords or codes.

Amounts are Int64 cents and timestamps epoch milliseconds. Views render authoritative server totals/windows. The current four-purpose fund surface is cumulative; do not silently revive legacy monthly-reset arithmetic. Read-only views and generated action previews must not call accounting confirmation/mutation endpoints.

Financial editors use the existing server operation ID and revision/token contracts. Freeze the submitted payload after an ambiguous response and reconcile/retry that same identity; reopening a sheet within the session must not silently create a duplicate. Ratio edits change current defaults without rebalancing confirmed historical allocations. Refunds are linked income and do not rewrite gross expense. Bill detail is a centred modal overlay (`LedgerBillDetailOverlay` + `LedgerBillDetailCard`) on the bill list and Home, so the tab, query, page offset and scroll position survive; the system-sheet wrapper exists only for entry points that already present a sheet (item detail). Capsule actions (edit / record refund / delete) sit at the bottom of the card; delete requires confirmation and broadcasts `ledgerRevision` on success. Daily totals must come from `GET /transactions/daily-summary` for a whole month (the endpoint caps at 32 days) with the displayed calendar zone; decoding is strict, a search revision must match the list page, and the client never sums loaded rows. Allocation templates are retired: no template entry, model, or review action; tags carry the record-level label and old template names are folded into tags by migration 022.

Centred bill cards use the shared `ledgerBillDetail(api:selection:metadata:)` native full-screen presenter, with a transparent presentation background and a full-screen dimming layer. A child `ZStack` inside a NavigationStack cannot cover or block the outer tab/navigation chrome. Do not fix this with list reconstruction or hidden views that still receive touches. Native hit-testing must route tab, navigation and background-list points to the modal; dismissal retains the original scroll view/offset. The modal content remains scrollable, with nested financial editor ownership in the card. Type/account/date filters are a regular List row, never a pinned header or top safe-area inset; per-day statistics use only authoritative bucket values.

Assistant confirmation/cancellation is scoped to its original conversation and persisted action ID. A late A response can update A and invalidate ledger data, but cannot replace B's messages. Validate action identity/status before publishing success. Historical suggestions require explicit selected action IDs; note-only recommendations cannot be included in apply. Import confirmation requires matching original SHA-256/size, 1–100 explicitly selected eligible rows and the frozen retry body. Never turn uncertain confirmation into a new action.

Use the API client's per-session `ledgerRevision` publisher after actual successful writes. Reading or cancelling a pending draft does not change ledger state. Invalidated clients cannot broadcast updates into new sessions.

Historical-organization analysis is started in the background and polled: one assistant generation must never await the whole batched analysis, because the server caps a generation at `MAX_GENERATION_DEADLINE_MS` (180 s) and the second clarification turn would then fail. Template proposals are neither produced nor selectable.

`AssistantSpendingRunStore` owns progress by immutable API identity and run ID. Poll only
GET status, every three seconds for at most 300 reads; tolerate up to three consecutive
transient failures and stop immediately for 401/403/404. Manual refresh starts a fresh
observation ticket; cancellation/disappearance and replaced tickets reject late results.
Validate run ownership, legal status and `0 <= completed <= eligible <= 500` before display.
Show the actual date range and fixed safe failure cause. Opening ready suggestions is a
read, not confirmation or new inference. Unknown server/provider messages retain the
generic fallback; only explicitly allowlisted fixed server messages may explain a stream
failure. Never expose raw provider response text or automatically retry a model request.

Generation events follow the existing backend protocol, including UTF-16 offsets, monotonically increasing sequence, stable provisional/final message identity and snapshot reconciliation. Leaving a view unsubscribes; Stop explicitly cancels server generation. Network loss does not authorize a new inference POST.

`AssistantTraceStore` reads the diagnostic trace of one generation
(`GET /assistant/conversations/:id/generations/:id/trace`) and `AssistantTraceView` renders it
as a collapsed timeline under the bubble. The trace is metadata only — step ordinal, kind,
tool name, argument summary, status, duration — and must never be presented as model reasoning.
It is collapsed by default and expanded automatically when the reply carries an error, because
that is the moment the user needs to know where the reply stopped. A trace read failure is
swallowed: diagnostics must never displace the conversation, replace a message or trigger a
retry. The view is keyed by API identity plus generation id so switching accounts or
conversations cannot show a foreign trace. Android renders no trace in this iteration, so new
message/trace data must stay additive and ignorable by older clients.

Keep POST ownership separate from the current screen's subscription: a delayed A response after A → B → A must resume the currently visible A. Definite client rejections release the draft for editing; ambiguous transport/server failures retain the original request ID and explicit retry notice across reopening. Successful list mutations invalidate reads started before their completion.

Provider forms read saved configuration before allowing a save. Blank key preserves stored secret. Hidden/redacted settings must not be overwritten by empty defaults. Discovery uses saved connection metadata; initial disabled-connection bootstrap is an explicit user action. Selection edits a draft. Save, model fetch and test are mutually exclusive; testing is never an automatic side effect.

Provider URL templates retain literal `{{model}}`/`{{input}}` placeholders. Validate a substituted sample; do not persist URLComponents serialization that percent-encodes the backend's template braces.

CI uses GitHub macOS/Xcode to build the device app with signing disabled. Package `Payload/Jizhang.app` in `Jizhang-unsigned.ipa`, include SHA-256 and commit metadata, and sign locally using Sideloadly. Apple ID credentials and signing certificates do not belong in the workflow. Artifacts are downloaded only from an identified successful run, with checksum and commit verification.

## 4. Validation and error matrix

| Condition | Required result |
|---|---|
| Invalid or non-HTTPS server address | Visible validation; no credentialed request |
| 401 from old session | Clear/invalidate only its owner; never expire a newer session |
| Bodyless POST | No empty JSON content type |
| Non-JSON API success or invalid DTO | Safe failure, not fabricated empty/zero data |
| SSE gap, unknown owner, malformed frame | Reconcile same generation; never silently concatenate invalid text |
| Conversation switch during a read | Old response cannot replace current messages |
| Blank key / hidden provider field | Preserve stored value unless explicitly cleared/edited |
| Model discovery failure | Keep the draft and selected model |
| Unavailable financial endpoint | Show unavailable/error state rather than an empty account |
| Successful CI, no phone detected | Build passed; installation still pending |
| Wrong artifact hash or commit | Refuse local handoff |

## 5. Good / base / bad cases

Good: successful simulator tests and device compilation produce an unsigned IPA, whose checksum is verified before local signing. Base: phone is disconnected, so deliver the verified IPA and record device installation pending. Bad: rename a simulator app to IPA and call it installed, upload Apple credentials to CI, or equate compilation with device acceptance.

Good: the user reads history while the current stream advances and gets a jump-to-latest affordance. Bad: every text delta forcibly scrolls the view, or a stream retry starts another paid request.

## 6. Required checks

- Core tests: URL/origin checks, CSRF, bodyless POST, cookie persistence/expiry, exact monetary decoding, safe errors and ownership/401 behavior.
- Assistant tests: real wire shapes, framing/Unicode, sequence gaps, terminal replacement, same-draft identity and snapshot freshness.
- Background tests: read-only ready handoff, transient recovery, manual observation restart,
  missing/wrong-owner/invalid-count rejection, leaving-view cancellation and finite safe
  error mapping without provider detail leaks.
- Provider tests: bootstrap, secret/hidden field preservation, model selection/discovery failure and exclusivity.
- Ledger tests: actual read DTOs, exact cents and authoritative window/fund contracts.
- Native build/test/package on macOS; inspect the real simulator launch artifact. Large fonts, keyboard, long chats, provider latency and physical installation remain separate acceptance evidence.

## 7. Wrong vs correct

- Wrong: defaulting a failed balance response to zero. Correct: typed decoding and visible error/retry.
- Wrong: persisting a new login cookie before validating its response. Correct: validate response shape, then retain the accepted session.
- Wrong: accepting an arbitrary download labelled latest. Correct: successful run ID, expected commit and SHA-256.
- Wrong: a Windows source scan proves iOS compilation. Correct: record actual GitHub Xcode and XCTest outcomes, then separately record local installation.
