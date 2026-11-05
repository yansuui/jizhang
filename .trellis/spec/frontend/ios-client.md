# Native iPhone client contracts

## 1. Scope / trigger

Applies to `clients/ios`, its Xcode project and `.github/workflows/ios.yml`. The initial iOS scope is functional AI text chat/provider setup with read-only presentation of other accounting domains. It is not evidence of complete Android feature parity. See `clients/ios/README.md` for supported and deferred behavior.

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

Generation events follow the existing backend protocol, including UTF-16 offsets, monotonically increasing sequence, stable provisional/final message identity and snapshot reconciliation. Leaving a view unsubscribes; Stop explicitly cancels server generation. Network loss does not authorize a new inference POST.

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
- Provider tests: bootstrap, secret/hidden field preservation, model selection/discovery failure and exclusivity.
- Ledger tests: actual read DTOs, exact cents and authoritative window/fund contracts.
- Native build/test/package on macOS; inspect the real simulator launch artifact. Large fonts, keyboard, long chats, provider latency and physical installation remain separate acceptance evidence.

## 7. Wrong vs correct

- Wrong: defaulting a failed balance response to zero. Correct: typed decoding and visible error/retry.
- Wrong: persisting a new login cookie before validating its response. Correct: validate response shape, then retain the accepted session.
- Wrong: accepting an arbitrary download labelled latest. Correct: successful run ID, expected commit and SHA-256.
- Wrong: a Windows source scan proves iOS compilation. Correct: record actual GitHub Xcode and XCTest outcomes, then separately record local installation.
