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
  cutout candidate cleanup.
- `ff74edc19470caef35950e565cd6b86965c02d65`: isolated screen fixture JSON decoding.
- `241ac6b1e2ff5273c88df2e18d5495788fd3063a`: native-result return protocol,
  source-scoped file sessions, real-dismissal receipt relay and native presentation gate.
- `0e90dfa27b2a1ef42df85f1603d2c8394023ff39`: serialized different-day review
  handoffs, ordinary conversation creation waiters and owner-scoped/ticketed reconciliation.

Final backend source is `d32b0442e63fe05972bdf116f4e6eab9435c3520`, with additive
migrations 024/025, authoritative native receipt verification and exactly-once return
to the original workflow. Exact-source [run 42229314232](https://github.com/yansuui/jizhang/actions/runs/42229314232)
passed all four jobs: backend build/lint/types and **405 shared + 1380 server tests**,
Android unit/package/lint, actual production-container lifecycle/locking/backup, and
**13 private cutout service tests** with a synthetic engine. The full CI log is
`clients/ios/build/harness-quality/github-42229314232.log`.

Final backend and native checks passed; local artifact evidence is recorded below.
The source audits and implementation handoffs are under `research/harness-*.md` and
`research/daily-reminder-design.md`; they are not substitutes for executed checks.

Final screenshot review found a consent-copy issue in the otherwise passing build21:
generic `inserted`/`skipped` counters said "already inserted/skipped" in the no-write CSV
preview. Source `b5d9013eda3108339b45d823da757b889ca677ed` makes shared count labels
neutral and names the pre-confirmation section as estimated/unwritten (historical
preview after confirmation). No behavior/wire/backend code changed. Exact new native
run42233753337, build22, passed **214 XCTest cases with zero failures** and Release
device packaging. Build21 below remains verified intermediate evidence rather than the
final delivery package.

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
- Final backend local gate at `d32b044` passed shared build, repository build, lint,
  typecheck and **405 shared + 1380 server tests** (69 server suites, 117.12 s).
  `final-*.log` retain the exact frozen-source output. The 39 workspace cases include
  native import/photo/export handoff, source/receipt/replay refusal and forced-rollback
  atomicity; 26 DB cases include additive 025/old receipt preservation.
- Native project at `241ac6b` generated **67 app / 19 test Swift files** with 211 source
  test methods. Actual final XCTest execution is recorded below, not inferred from counts.

### Native attempts

- Run [42221845903](https://github.com/yansuui/jizhang/actions/runs/42221845903), build 16,
  failed application compilation on the new batch store's shadowed error and nonexistent
  query helper. XCTest did not run; no IPA.
- Run [42222453278](https://github.com/yansuui/jizhang/actions/runs/42222453278), build 17,
  compiled application code, then failed test compilation on an inaccessible private
  fixture helper. XCTest did not run; no IPA.
- Run [42223268013](https://github.com/yansuui/jizhang/actions/runs/42223268013), build 18,
  compiled the application, then failed test compilation on the screen fixture's same
  inaccessible JSON helper. XCTest did not run; no IPA.
- Run [42223932118](https://github.com/yansuui/jizhang/actions/runs/42223932118), build 19,
  executed **194 tests, 4 assertion/fixture failures**, with 190 passing. Fixes verify the
  additive negotiated request field, permit read-only generation recovery GETs while
  banning inference POSTs, and mock the additive capability GET in the preview fixture.
  All four newly rendered workspace/reminder/CSV screenshots passed in that run.
  No IPA was produced from this failed run.
- Run [42228505693](https://github.com/yansuui/jizhang/actions/runs/42228505693), build 20,
  checked `241ac6b` and was cancelled as superseded to free the final build queue.
  Its retained partial log shows **211 XCTest cases passed, zero failures**, TEST
  SUCCEEDED at 13:57:35 UTC and Release device BUILD SUCCEEDED at 14:00:57 UTC.
  Cancellation interrupted the later simulator-launch stage; this is not a completed
  delivery run and provides no final IPA artifact. The log is
  `clients/ios/build/harness-native-42228505693-cancelled.log`.
  A final cross-day notification audit found that two queued dates could
  race the shared conversation-creation flag. The assistant launch handoff was then
  serialized with held-first-create regressions; this run is intermediate, not delivery.

### Integration audit follow-up

The modal gate correctly retained two review dates, but acknowledging destination
appearance allowed the next date to call the Assistant before the prior conversation
was created. Same-day dedupe alone did not serialize different dates. The final fix
preserves each tap's owner/date/request identity, serializes the handoff and retains
uncertain requests; no automatic inference on startup or foreground is permitted.
Three held-transport regressions cover two dates plus a duplicate tap, an existing
ordinary conversation creation, and cancellation of the first create releasing the next
date without accepting the cancelled receipt. The final read-only peer review passed.
The feature-complete build21 source has **214 test methods**, including 21 assistant workspace, 17 reminder
and 10 presentation/receipt-relay cases. Exact native
run [42230352224](https://github.com/yansuui/jizhang/actions/runs/42230352224) at `0e90dfa`
completed successfully as build 21: **214 XCTest cases passed, zero failures**,
TEST SUCCEEDED and Release device BUILD SUCCEEDED. Root independently rechecked
`clients/ios/build/diagnostics-42230352224/logs/tests.log` lines 1954/1956/1964
and `logs/device-build.log` line 256. Xcode 16.4 was used on macOS 15 Intel.

## Final delivery and screenshot review

- Final source: `b5d9013eda3108339b45d823da757b889ca677ed`, original repository main.
- Successful [native run 42233753337](https://github.com/yansuui/jizhang/actions/runs/42233753337):
  **214 XCTest cases, zero failures**, TEST SUCCEEDED and Release BUILD SUCCEEDED.
  Root independently rechecked `clients/ios/build/diagnostics-42233753337/logs/tests.log`
  lines 1956/1958/1966 and `logs/device-build.log` line 256.
- Device package: version **0.1.0**, build **22**, minimum **iOS 17.0**,
  bundle `com.yansuu1.jizhang.ios`, Xcode 16.4 (16F6), unsigned iPhone arm64.
- Ready file: `clients/ios/build/delivery/Jizhang-iOS-harness-b5d9013.ipa`;
  **3,447,263 bytes**, SHA-256
  `5e1131925243e28cb5e3e6b91ec0d39af9c6c9fa762fea8e252d3454feca4e1f`.
- The download helper checks successful run status, exact source and manifest checksum.
  Worker and Root separately checked ZIP CRC, plist, real arm64 Mach-O executable,
  iPhoneOS platform, exact build/source/hash and absence of XCTest runtime. Worker also
  checked Mach-O platform 2 and 36 linked libraries. Prior IPAs remain separate files.
- Actual simulator fixtures use a visible synthetic-data banner and a 390x844-point
  hosting window on iPhone SE (3rd generation), iOS 18.5. Root reviewed account paging
  with equal-name rows, compact reminder clocks, denied/large-text/dark reminders,
  background organization and confirmation from build21; these companion layouts are
  unchanged. The review found the preview-counter wording issue and rechecked the changed
  CSV image in build22: `9B524D40-21A2-4C3D-A3D1-7A55DF85EA9A.png` under
  `clients/ios/build/review-42233753337/previews/`. It now explicitly marks an unwritten
  estimate and neutral counts, with the full-file confirmation still visible.
- Same-name choices have distinct subtitles and authoritative IDs, search and next-page
  controls; Continue remains disabled before selection. Reminder fields wrap at large
  text and remain scrollable. The compact authorized fixture captures transient
  "updating reminders", not proof of final scheduling; the actual state is covered by
  the reminder tests. No simulator fixture proves system notification delivery.

The final code differs from backend-tested `d32b044` only in native source; server,
shared, Android and cutout implementations remain identical to their passing run.

## Remaining evidence boundary

The running server needs the backend update as well as the app update. Source and
synthetic providers do not establish production behavior. Real notification authorization,
closed-app delivery, tap routing, signed Keychain/login, keyboard/large-font gestures and
live-provider latency require the signed iPhone. The user's earlier phone-connection
deferral stands; deliver a verified unsigned arm64 IPA for existing local Sideloadly.
