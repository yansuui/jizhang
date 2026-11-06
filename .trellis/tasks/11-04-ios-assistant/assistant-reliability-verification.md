# Assistant workflow reliability verification — 2026-11-06

## User-visible repair

The screenshot's organization request formerly started a real background job, then spent
the remaining short model turn polling it and failed before storing its visible task card.
Start/status/resume and not-ready-card reads now hand off the actual durable run immediately.
The iPhone reads progress independently and opens ready suggestions without new inference;
financial modifications still require explicit selected actions and confirmation.

Ordinary queries formerly allowed only three decisions (including the answer), lost earlier
read results and rejected valid fund snapshot hashes. Both generation and legacy paths now
share eight bounded decisions and the existing 180-second deadline, persist successful reads,
retain bounded facts, stop identical reads and allow limited typed-argument correction.
Month-only statistics use the requested month. Expected busy/capacity/not-ready states explain
what happened rather than generating a generic unfinished reply.

Populated results now fit native transport bounds. Long text excerpts are labelled; money,
IDs, tags, concurrency hashes and actual pagination remain authoritative. Offset reduction
uses the actual returned row count. Opaque cursor pages are never sliced with an old cursor.
Oversized exact results ask for a smaller query; oversized financial previews create no
pending action. Very long single-note reads disclose the existing 4000-unit assistant limit
and direct the user to native bill details for complete text.

The native task observer recovers transient failures, restarts on manual refresh, rejects
wrong-owner/invalid progress, and cancels stale observations. The task displays its actual
date range, ready/failed/cancelled status and safe fixed causes. Unknown internal/provider
text still uses the generic fallback.

## Executed checks

Frozen core backend changes passed with Node 22.23.4 and pnpm 10.12.2:

- `pnpm --filter @jizhang/shared build`
- `pnpm -r run lint`
- `pnpm -r run typecheck`
- `pnpm -r run test`: shared **405**, server **1314**, all passed.
- `pnpm build`

Real Fastify scripted-provider regressions cover streamed and buffered one-call task
handoff, four reads plus answer/plan preview, seven reads plus eighth answer, explicit
confirmation, invalid-argument recovery, duplicate reads, deadline/cancellation, preserving
facts after later failure, long populated pages and replay, oversized preview rejection,
501-record capacity feedback, not-ready-card handoff and busy different-range feedback.

Independent review reproduced a completed large query with two approximately 27 KiB cards
and a 56,098-byte replay; it verified all earlier facts remained in subsequent prompts.
Realistic 200-bill, 80-refund and 120-goal fixtures check exact financial facts, complete
offset traversal and safe opaque-cursor behavior. Final review caught a legal >4000-unit
note disclosure gap; its focused regression and final CI result are recorded below.

The final >4000-unit note follow-up passed **82/82** focused business/contracts/read
tests (including **50** read reliability cases), server typecheck and changed-file ESLint.
It preserves the global string guard and the original domain note unchanged while
disclosing actual displayed/original length and omission in both data and human text.
Independent final review found no other high-confidence blocker in paging, background
handoff, safe error vocabulary, native observation ownership or financial confirmation.

## Delivery and remaining acceptance

Native source commits are `4033d265c7a01109ee23cb430aa370a599d7b637` and
`d3eddc3aad1a8dba9650f9c51e62fde06f504a54` on original `main`.
Backend source is `ebc8086e4653fec2c48a43deef09b77ff853dde6`, pushed directly to original
`main`; it changes no iOS source/project/workflow from the final native source commit.
Final [backend/Android/container run 42180534737](https://github.com/yansuui/jizhang/actions/runs/42180534737)
at that exact backend commit completed successfully in all three jobs. The final source
passed repository lint/typecheck/build and **405 shared + 1315 server tests**. Android
unit tests, APK compilation and lint passed. The actual production image built and its
isolated multi-user process/locking/restart/complete-backup checks passed; this is not a
deployment to the user's production host. Logs are retained locally under
`clients/ios/build/backend-verification-42180534737.log`.
The earlier run 42177723136 at 4033d26 passed 141 XCTest cases and arm64 packaging;
it is superseded by the final native run below.

Final [iOS run 42179267691](https://github.com/yansuui/jizhang/actions/runs/42179267691)
at exact native source `d3eddc3` completed successfully. Xcode 16.4 on macOS 15 Intel
passed **142 XCTest cases, zero failures**, then built the Release iPhone arm64 app and
packaged the unsigned device IPA.

- Ready file: `clients/ios/build/delivery/Jizhang-iOS-assistant-reliability-d3eddc3.ipa`.
- Original download: `clients/ios/build/downloads/42179267691/Jizhang-unsigned.ipa`.
- Size: **2,698,116 bytes**; version **0.1.0**, build **14**, minimum iOS **17.0**.
- SHA-256: `cb83e009bb158eba8b2356382b9597b0f27322a9728f8ac0aee58015b173dd8a`.
- Bundle: `com.yansuu1.jizhang.ios`; metadata matches the exact source SHA and run ID.
- Download helper checksum/source checks and independent ZIP CRC, iPhoneOS plist,
  arm64 Mach-O and no-XCTest-runtime checks passed. Diagnostics are retained under
  `clients/ios/build/diagnostics-42179267691`.

An independent reviewer inspected the actual compact task-card render
`37FF12F6-4CBC-42B6-A8FC-6DBE3570BC36.png`, mapped by the exported manifest to
`testBackgroundSpendingTaskCardAtCompactWidth`. Completion, suggestion entry,
confirmation warning and refresh are readable without clipping/overlap. The synthetic
fixture omits start/end dates, so that render does not establish date-range-row visual
acceptance. The unique delivery copy's hash matches the original downloaded IPA.

Automated fixtures use isolated ledgers and scripted providers. They establish
source/state/transport behavior, not a production-provider conversation or deployment.

The running server must also be upgraded to the backend repair; replacing only the IPA
cannot fix server orchestration. No production credentials/configuration/ledger changes,
live inference or physical installation were performed. The user's deferred phone
connection remains in effect; the unsigned device IPA is for existing local Sideloadly
signing. Keep the broader task active for its deferred device acceptance.
