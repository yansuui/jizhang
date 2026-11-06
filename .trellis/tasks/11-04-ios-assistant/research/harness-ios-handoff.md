# iOS conversational workspace implementation handoff

Owned scope: Assistant Swift files, `AssistantWorkspaceTests.swift`, and this handoff.
No App/My/APIClient/project generation, commit, deployment or live-provider operation.
The root owns project generation and real Xcode validation on GitHub.

## Implemented

- Advertise additive `workspace-v1` on ordinary generations; preserve v1 reducer/SSE,
  same-request submission retry, Stop and owner fences.
- `AssistantSelectionStore/Card`: authoritative opaque choice IDs, readable equal-name
  rows, search and real paging, multiple selection across pages, native date range,
  stale/expired state and immutable uncertain retry body. Response conversation is checked.
- `AssistantWorkspaceResultCard`: readable money/account/category rows, full inspectable
  details and direct server-owned offset paging. Trusted native destination cards route
  through root's enum/environment; invitation buttons honor the injected permission flag.
- Ordinary draft review now offers adjustment. GET retrieves full arguments plus editable
  schema; the form preserves opaque tokens/revisions, supports account/category pickers,
  enums, dates, money, booleans and complex argument editing, then calls deterministic
  revise. The returned old cancelled/new pending cards replace history; no ledger change.
- Structural/historical organization selects actual eligible action IDs and calls typed
  prepare directly. Ready spending cards and their pages use `/workspace/organization/card`.
  Selection survives page changes; no composer text or model round trip on these controls.
  Explicit resume invokes the existing run resume route with a stable uncertain identity.
- Successful confirmation continues its original task via an idempotent action-scoped
  request. Reconciled uncertain confirmation can continue only after authoritative history
  says confirmed. Later writes remain new pending cards. Manual continuation retries use
  `continue-<actionID>`, including reopening. Old servers without workspace discovery keep
  their original confirmation behavior.
- Persisted workflow original intent/status is read separately and shown compactly; it
  cannot displace messages when its optional read fails. One current-generation activity
  observer does bounded read-only trace refresh. Historical per-generation traces are
  deduplicated, still collapse, and never display legacy arbitrary argument summaries.
- Capability launcher reads the runtime catalog, starts the selected dialogue capability,
  and opens real native workspaces. Item/photo actions select a real item first. Merged
  import history opens its owned conversation/batch in root's native import workspace.
- `AssistantView(api:launch:onLaunchCheckpoint:)` adopts the reminder worker's immutable
  intent and checkpoint API. Shared in-flight launch task prevents duplicate tap races.
  Persist conversation/submitting before direct daily-review inference; freeze day/zone/
  request. Accepted/uncertain checkpoints persist, including explicit retry callbacks.
  Non-starting reopen only reads/reconciles and offers same-request retry. No extra
  Generate tap, background automatic inference or wrong-owner launch.

The old standalone `AssistantSpendingSelection.prompt`/preview view is retained for
existing source tests/visual fixtures. Actual conversation paths now use the typed
organization view and never invoke that composer bridge.

## Verification and integration

- Added **21** native mock/state tests: multi-page equal-name selection IDs; frozen
  ambiguous selection replay; foreign-owner response rejection; exact money/opaque facts;
  immutable revision; organization preparation without inference; persisted daily launch;
  confirmed operation continuation identity; native inclusive date selection; failed
  outbox barrier preventing inference; wrong-owner/reopen behavior; bounded GET-only trace;
  additive item/recurring/goal/fund-source/transfer/trash kinds retaining authoritative IDs.
- Ready-run suggestion sheets close only after a validated new pending card is installed;
  inline organization cards do not dismiss the conversation. Valid/invalid transport
  regressions prove the callback runs after card installation and never for a missing card.
- Verified native CSV/batch/photo/export completion receipts resume the original task only
  after App's actual sheet dismissal event. The source must be an owned `workspace.open`
  result; generic capability/library/import-history links carry no completion authority.
  Immutable API/conversation/message/reference/request identity is preserved, duplicate
  delivery posts once, failures retain the exact receipt for explicit retry, and a hidden
  original conversation can receive its generation without changing the visible thread.
  Four composed mock regressions cover duplicate/foreign/source/uncertain cases. Native
  completion itself does not change the ledger or claim OS share completion.
- Different daily-review days share a Store-owned serial launch tail; same-day repeats
  still coalesce before it. Actual conversation creation settlement wakes checked waiters,
  so an unrelated held UI create cannot silently consume a notification. Daily history/
  snapshot reads have a read-ticket fence and do not call global `open()` or steal a
  displayed thread. Three held-transport regressions cover two dates and repeated day A,
  an unrelated manual create, and a cancelled first create releasing day B while leaving
  day A's receipt unaccepted. Each real daily POST retains its exact day/zone/request ID.
- Date choices use the existing Shanghai ledger calendar and explicitly display that zone,
  independently of the device's clock/locale, matching the server's accepted day scope.
- Mocks target `https://example.com`, the host actually intercepted by CoreMockURLProtocol.
- Static duplicate label scan and `git diff --check` passed. No local Swift compiler or
  Xcode is available; these tests are source until root's macOS CI passes.
- Root must generate pbx membership for three new app Swift files and this new test file.
  New files: `AssistantWorkspaceModels.swift`, `AssistantWorkspaceViews.swift`,
  `AssistantDraftRevisionView.swift`.
- Root owns actual screenshots/compact and large-text review with the reminder worker,
  native IPA checksum/source validation and the final capability coverage gate.

Wire coordination uses `research/harness-wire-contract.md`, including the added direct
spending card read, draft `action.inputSchema`, capability/native-action catalogs and
the original confirm + explicit workspace continuation pair.

## Intermediate native evidence before consent-copy clarification — 2026-11-06

Run [42230352224](https://github.com/yansuui/jizhang/actions/runs/42230352224), build 21,
completed successfully at exact source `0e90dfa27b2a1ef42df85f1603d2c8394023ff39`.
Downloaded diagnostic `logs/tests.log:1954` and `:1956` records **214 XCTest cases,
zero failures**, including the three serialized daily-launch regressions; `:1964` is
`TEST SUCCEEDED`. `logs/device-build.log:256` records `BUILD SUCCEEDED`.

The official download helper verified completed success, exact source and SHA-256.
An independent check also verified ZIP CRC, `Payload/Jizhang.app`, iPhoneOS plist,
arm64 executable with `LC_BUILD_VERSION` platform 2, minimum iOS 17, matching bundle/build,
36 linked libraries and no XCTest files or runtime linkage.

- Intermediate verified IPA: `clients/ios/build/delivery/Jizhang-iOS-harness-0e90dfa.ipa`.
- Size: **3,447,130 bytes**; SHA-256:
  `acd600183c93a131169dc0902f88f4cac56e05fcce802733293ebc44541ab5b1`.
- Official download: `clients/ios/build/downloads/42230352224/`.
- Diagnostics: `clients/ios/build/diagnostics-42230352224/`.
- Independent review copy: `clients/ios/build/review-42230352224/`.
- Version 0.1.0, build 21, bundle `com.yansuu1.jizhang.ios`, Xcode 16.4 (16F6).

Actual exported test images were inspected using `view_image`; the manifest maps them
to iPhone SE (3rd generation) fixture tests. All carry the synthetic-test-data banner:

| Fixture | PNG | Observed evidence |
| --- | --- | --- |
| `testAssistantPagedAccountSelectionAtCompactWidth` | `6DFAB749-265E-4E75-B307-D43E0C5EC160.png` | Seven rows, equal account names disambiguated by subtitle, search, next page and disabled unselected Continue are readable; no overlap. |
| `testDailyReminderPermissionDeniedAtLargeText` | `2EB622B4-7467-458B-8A43-516BCB1CBB5B.png` | Large dark layout wraps the denied-permission explanation, OS Settings link, times and tap-only review note. Further List content is normally scrollable. |
| `testDailyReminderSettingsAtCompactWidth` | `4FBD5139-3C27-4609-926E-8401C390DF9D.png` | 20:00/21:00 controls and tap-only model-call text are readable. The render captures the transient updating state, so it does not prove final ready-state copy. |
| `testNativeCSVImportPreviewAtCompactWidth` | `E60B7479-79CD-47C0-B8D2-94C5B0CBA1B4.png` | File identity, preview/effect counts, two source rows and explicit whole-file confirmation remain readable without overlap. |

The unique delivery copy matches the verified download hash. These are actual native
compilation, fixture and binary checks, not production-provider, signed hardware,
OS notification delivery/permission or physical Sideloadly installation evidence.

This successful snapshot is superseded for final delivery by a narrow consent-copy fix:
shared result counts use neutral "新增数量/跳过数量/忽略数量" and the CSV preview heading
explicitly says it has not written yet. The old screenshot's "已新增" label in a rollback
preview could misstate the state even though actual confirmation guards passed. No
accounting behavior or data keys changed. The next exact-source native run/package
must pass before the final IPA is delivered; retain this intermediate provenance.

## Final consent-clarified delivery

Successful run [42233753337](https://github.com/yansuui/jizhang/actions/runs/42233753337)
at exact source `b5d9013eda3108339b45d823da757b889ca677ed`, build **22**, supersedes the
intermediate build above. Final diagnostic `logs/tests.log:1956`/`:1958` records
**214 tests, zero failures**; `:1966` is `TEST SUCCEEDED`. Device log `:256` is
`BUILD SUCCEEDED`. The workflow reached terminal success, and the official helper
verified that state, source metadata and checksum before the unique delivery copy.

- Final file: `clients/ios/build/delivery/Jizhang-iOS-harness-b5d9013.ipa`.
- Size **3,447,263 bytes**; SHA-256
  `5e1131925243e28cb5e3e6b91ec0d39af9c6c9fa762fea8e252d3454feca4e1f`.
- Download `clients/ios/build/downloads/42233753337/`; diagnostics
  `clients/ios/build/diagnostics-42233753337/`; review copy
  `clients/ios/build/review-42233753337/`.
- Metadata matches exact commit/run, version 0.1.0/build22/minimum17.0/bundle above.
  Independent ZIP CRC, iPhoneOS plist, arm64 executable/platform2, 36 linked libraries
  and absence of XCTest files/runtime all passed. Root independently repeated these checks.
- Re-inspected changed CSV fixture `9B524D40-21A2-4C3D-A3D1-7A55DF85EA9A.png`, mapped
  by the final manifest to `testNativeCSVImportPreviewAtCompactWidth`. It explicitly says
  "预计导入结果（尚未写入）", uses neutral new/skip counts, and retains source rows and
  the confirmation button without overlap/clipping. Root independently inspected it.
- Other unchanged fixture layouts retain the earlier independent review; actual final
  test execution reran all 12 preview cases. No signed-device notification/provider or
  physical installation acceptance is claimed by this package verification.

## Final automated verification - 2026-11-06

Final native source `0e90dfa27b2a1ef42df85f1603d2c8394023ff39`, run42230352224,
build21 passed all214 XCTest cases with zero failures and Release device packaging.
This supersedes earlier pending/source-only counts above. See `../harness-verification.md`
for exact logs, screenshots and local IPA provenance. Signed-device notification/login/
modal behavior and live-provider acceptance remain separate; no physical installation occurred.

## Final build22 delivery

Final source b5d9013, native run42233753337, build22 passed all214 XCTest cases
with zero failures and Release device packaging. This supersedes build21 as the delivery
artifact after screenshot review corrected preview-versus-completed counter wording.
The contracts/behavior remain unchanged. Exact SHA256, IPA, raw logs, actual screenshot
review and the deferred physical-device boundary are in `../harness-verification.md`.
