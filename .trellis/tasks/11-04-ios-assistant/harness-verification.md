# Conversational workspace and daily reminders — verification

## Authorization and source

The user approved the reviewed full scope with "实施". Work stays directly on original
`yansuui/jizhang` main. No fork/branch, production deployment, real-provider inference,
notification permission change or physical installation is part of the automated work.

Native source milestones pushed:

- `0aa8cc0b5a50d64abca8d3ccaf25438a00cc0a1a`: conversational workspace, dedicated
  native data/photo/password flows and daily notifications/outbox.
- `f86ca4c3287514f516124f63026e7f989ce76ace`: actual Xcode query helper/property fixes,
  correct Section footer and semantic JSON retry comparisons.
- `34337ade91f5826dc4ab66be3fe246d60003d49a`: local test helper visibility and completed
  cutout candidate cleanup. Current native run is 42223268013, build 18.

Final backend source/checks and native artifact evidence are recorded after completion.
The source audits and implementation handoffs are under `research/harness-*.md` and
`research/daily-reminder-design.md`; they are not substitutes for executed checks.

## Implemented acceptance paths

| Scope | Source behavior and verification boundary |
| --- | --- |
| H1/H2 capability coverage | Existing typed business adapters retained; runtime capabilities and trusted native action routing added. Final coverage follows the active route-family audit, not the tool count alone. |
| H3 typed choices | Authoritative paged resource IDs, filters, date/range and structured answers; same-name entries remain distinct. No long composer JSON selection bridge. |
| H4 modifications | Existing explicit confirmation, schema-based edits/repreview, cancelled predecessor, immutable replacement, exact service revisions and replay identity. |
| H5 task continuation | Durable original intent/selected facts/approved references, action-scoped continuation, next modification pauses for new consent; lifecycle phase reconciles separately from prose. |
| H6 streaming/activity | Existing real provider/SSE reducer and Stop/recovery retained; bounded live step metadata and unsafe legacy-argument redaction, no internal reasoning display. |
| H7 native workspaces | Protected settings/invitation/password routing; real generic CSV review/import, merged platform file/conflict/category/note review and confirmation, authenticated CSV sharing, item photos and cutout candidate application. Offline restore remains operator-only. |
| H8 recording/review reminders | Device-local 20:00/21:00 defaults, independent editable switches/times, actual authorization state, serialized owner reconciliation, pending/delivered cleanup on real account change/logout. |
| H9 read-only review | Tap-authorized owner/date/request outbox, duplicate/uncertain recovery, Shanghai ledger date frozen from notification delivery, full salary/refund/ordinary-day facts; no daily write preparation even after choices/clarifications. |

## Concrete issues found and repaired during integration

- Daily scope could be lost through a choice/clarification continuation: move it to
  durable workflow state and inherit it; enforce the read-only guard before write prepare.
- JSON-key-order-sensitive hashing broke exact request replay: canonicalize all keys,
  including nested payloads. Native tests compare decoded JSON meaning, not encoder order.
- Stale photo GET/404 and job-ready responses could overwrite successful save/cancel;
  add mutation/read tickets with regressions.
- A download finishing after dismissal could orphan a private export; active/ticket
  ownership prevents file creation and cleanup removes already published files.
- Native file cache cleanup belonged to actual API-owner changes/logout, not view
  disappearance that can happen during ordinary presentation.
- Legacy trace argument text could contain bill content. New persistence is shape-only;
  old values are redacted at the read boundary with seeded-row regression evidence.

## Executed checks so far

- Exact frozen backend source passed the local full gate with Node 22.23.4/pnpm 10.12.2:
  shared build, repository build, lint, typecheck and **405 shared + 1370 server tests**
  (69 server suites). Logs are under `clients/ios/build/harness-quality/`.
- The focused integration set separately passed **188/188** tests; it includes 30 new
  composed workspace route cases and preserves existing streaming/domain/trace/DB cases.
- Local private cutout service tests: **13 passed**, synthetic engine; includes actual
  PNG/JPEG normalization, mismatched MIME rejection and existing job bounds/lifecycle.
- Local authenticated public cutout proxy tests: **7 passed**, isolated ledger/provider;
  new native PNG preserves exact bytes/type and does not change financial data.
- Native project generated with **65 app / 18 test Swift files**. Source test method
  audit expects **194 XCTest cases**; this is not a test-pass claim.

### Native attempts

- Run [42221845903](https://github.com/yansuui/jizhang/actions/runs/42221845903), build 16,
  failed application compilation on the new batch store's shadowed error and nonexistent
  query helper. XCTest did not run; no IPA.
- Run [42222453278](https://github.com/yansuui/jizhang/actions/runs/42222453278), build 17,
  compiled application code, then failed test compilation on an inaccessible private
  fixture helper. XCTest did not run; no IPA.
- Run [42223268013](https://github.com/yansuui/jizhang/actions/runs/42223268013), build 18,
  is the next exact-source check; record its actual outcome below.

## Remaining evidence boundary

The running server needs the backend update as well as the app update. Source and
synthetic providers do not establish production behavior. Real notification authorization,
closed-app delivery, tap routing, signed Keychain/login, keyboard/large-font gestures and
live-provider latency require the signed iPhone. The user's earlier phone-connection
deferral stands; deliver a verified unsigned arm64 IPA for existing local Sideloadly.
