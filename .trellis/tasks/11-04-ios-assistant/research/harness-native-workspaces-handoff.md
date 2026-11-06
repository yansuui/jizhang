# Native workspace implementation handoff

Root owns NativeWorkspaceRoute/APIClient binary transport and Native* My views/stores,
My/item-photo entries, NativeWorkspaceTests and cutout input adaptation. Other workers own
assistant conversation and notification modules. No production/deployment/live inference
or physical installation occurred during these changes.

## Actual source behavior

- Trusted enum routes open real protected/native workspaces, not model URLs; invitation
  permission is checked with the real authenticated user. Password stays in its secure
  form, posts only to the current server and returns to login after session invalidation.
- Binary transport shares auth, redirect refusal, owner cancellation and CSRF with JSON.
  Native CSV review calls dedicated safe preview/confirm, keeps source bytes and the
  frozen uncertain receipt, and never submits CSV as model input.
- Merged platform import uses current dedicated batch routes: multiple files, parsing,
  exact original resupply, page traversal, explicit selection/conflict comparison,
  category create/reuse and note review, optional explicit analysis, file replace/remove,
  final review token and immutable atomic confirmation. Terminal batches can start anew.
- Pending batch caches distinguish conversations and API identities. Owner replacement
  and logout clear them; ordinary presentations retain uncertain receipts.
- Real CSV exports download through the authenticated same-origin transport, then expose
  a protected local share file. A request ticket prevents creation after dismissal and
  stop removes an existing file. All four existing export kinds are supported.
- Photos support native photo/file selection, oriented/metadata-free <=2 MiB payloads,
  alpha-preserving candidate previews, explicit save/remove, cutout start/status/cancel/
  candidate pick and cleanup. Read tickets reject delayed old photo/job replies.
- iOS prepares JPEG/PNG, so proxy/private worker now accept those alongside WebP with
  unchanged byte/pixel/concurrency limits and exact declared/decoded MIME validation.

## Verification levels

Root added 11 native regressions: trusted routes, binary CSRF/body/origin/size, CSV no-write
preview and uncertain same-request retry, conversation/account cache ownership, transparent
photo preparation and explicit save, merged-file frozen original confirmation, and late
export/photo/job reply fences, and canonical source-bound completion identity. The original
10 passed in build 19; the completion case belongs to the final native verification.

Executed on Windows: Python cutout test service **13 passed** with a synthetic engine;
the public Node cutout proxy **7 passed** with isolated ledgers. No SAM model inference or
real device is claimed. The unchanged synthetic-engine service emitted its existing
Starlette/httpx deprecation warning; pinned CI dependencies are checked separately.

First native run 42221845903 at 0aa8cc0 failed application compilation on a shadowed error
property and three calls to a nonexistent query helper. Root corrected to `self.error`
and existing `LedgerURL.path`, also corrected a Section footer initializer and changed
retry tests to compare JSON meaning. Commit f86ca4c starts run 42222453278; this handoff
does not claim its result. Final delivery verification owns native results and IPA hash.

## Native outcomes and source identity

Source-bound forms collect only receipt IDs/current photo hashes/export kinds after
actual successful responses. A trusted route includes conversation and source message.
The App retains the latest same-source outcome and publishes it only after the root
sheet's actual dismissal. The Assistant submits the canonical frozen receipt through
`workspace/native-completions` and adopts the returned generation; ambiguous responses
keep the same request. Standalone capability launches do not create a model call.

CSV caches include the API identity and source message, and platform caches additionally
include conversation and batch. Stable SHA256 identities are calculated once per file;
reattachment verifies original names/bytes. A source-bound generic CSV form does not
open the unrelated standalone platform-import flow. Photo cache reads clear previous
completion evidence and publish only the current successful read/save/removal; late
reads/jobs remain fenced. Password/logout/server switch invalidate their original auth
scope instead of attempting credential continuation. The server verifies current state
and durable import receipts, without claiming OS sharing or who caused a photo change.

Final backend source is `d32b0442e63fe05972bdf116f4e6eab9435c3520` and passed local
build/lint/typecheck plus **405 shared + 1380 server tests**. Migration 025 records the
first confirmed CSV timestamp; old receipts retain ordinary replay but cannot be
misattributed to a newly opened task. Exact final CI/IPA evidence is centralized in
`../harness-verification.md`.

## Final build22 delivery

Final source b5d9013, native run42233753337, build22 passed all214 XCTest cases
with zero failures and Release device packaging. This supersedes build21 as the delivery
artifact after screenshot review corrected preview-versus-completed counter wording.
The contracts/behavior remain unchanged. Exact SHA256, IPA, raw logs, actual screenshot
review and the deferred physical-device boundary are in `../harness-verification.md`.
