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

Root added 10 native regressions: trusted routes, binary CSRF/body/origin/size, CSV no-write
preview and uncertain same-request retry, conversation/account cache ownership, transparent
photo preparation and explicit save, merged-file frozen original confirmation, and late
export/photo/job reply fences. These are source until actual macOS XCTest succeeds.

Executed on Windows: Python cutout test service **13 passed** with a synthetic engine;
the public Node cutout proxy **7 passed** with isolated ledgers. No SAM model inference or
real device is claimed. The unchanged synthetic-engine service emitted its existing
Starlette/httpx deprecation warning; pinned CI dependencies are checked separately.

First native run 42221845903 at 0aa8cc0 failed application compilation on a shadowed error
property and three calls to a nonexistent query helper. Root corrected to `self.error`
and existing `LedgerURL.path`, also corrected a Section footer initializer and changed
retry tests to compare JSON meaning. Commit f86ca4c starts run 42222453278; this handoff
does not claim its result. Final delivery verification owns native results and IPA hash.
