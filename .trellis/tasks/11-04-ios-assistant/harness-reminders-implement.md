# Execution and verification plan

This is a planning artifact, not an implementation completion report. Start product
edits only after the expanded-scope final review. Work directly on original main.

The user approved the reviewed scope with "实施". Phase 2 is active; no further scope
approval is required for this implementation. Actual verification follows in the delivery record.

## Ordered workstreams

1. Freeze the coverage matrix and capability/interaction/continuation contracts. Read
   current assistant/backend/frontend/tenancy specs and the three research documents.
   Add real curated spec/research context before dispatching implementation workers.
2. Backend worker: persisted typed selections, workflow/approval continuation and safe
   draft revision. Keep existing domain adapters, bounds, tenant and action idempotency.
   Add runtime capability metadata/trusted native actions and any genuinely missing daily
   read adapter. Fix trace metadata disclosure and support bounded live observation.
3. iOS conversation worker: readable domain/result cards, real paged resource selection,
   date/range input, editable/repreview flow, confirmation/result/continue states and live
   execution activity. Replace organization prompt bridges with structured operations.
4. Native workspace worker(s): trusted routing, password form, generic CSV imports,
   merged-file review, actual export sharing and photo/cutout review. Reuse provider/
   invitation/single-file import views; do not replace working financial editors.
5. Reminder worker: injectable local scheduler/preferences/permission UI, owned app intent
   routing, 20:00/21:00 defaults and stable daily review outbox. Integrate recording sheet
   and single tap-authorized daily review with the assistant owner.
6. Root integration/review: check every active capability row and every acceptance ID,
   remove truthful-but-obsolete availability messages, update specs and Android inventory.
   Independently review actual composed workflows and notification ownership.

Workstreams 2/3 share a frozen protocol; app routing ownership must be coordinated with
4/5. Parallel workers own disjoint files, exchange typed handoffs and stop changing product
code before the full final gate. Existing 11-06 trace/envelope changes are retained.

## Required regression scenarios

- Every active capability has a real tool or native action path; unavailable/retired/
  operator states are explicit and no permission is invented by the model.
- More-than-six/equal-name/hierarchical/paged selections preserve actual IDs and scope;
  forged/stale/foreign-owner answers cannot consume or modify the wrong interaction.
- New expense, linked refund, plan/fund revision, recurring/item/tag changes through real
  generation routes: no writes until consent, superseded preview rejected, confirmation
  retried once, original task reread/report continuation preserved across reopening.
- Organization selection across pages fits typed limits without a composer-text bridge;
  notes remain reference and totals/cursors are exact.
- Streaming/Stop/deadline/disconnect/cancel/archive and A -> B -> A retain existing fences;
  live activity never persists note text, credentials, provider bodies or internal reasoning.
  Preseed old trace argument summaries and prove they are redacted on read/migration too.
- Generic CSV/platform multi-file imports: actual preview/conflicts/digest/revision and
  selected confirmation; export yields actual same-origin CSV; photo/cutout requires
  explicit apply and owner checks. No file or network side effects inside rollback previews.
- Permission denied/granted, time edit, independent disable, logout/account/server switch,
  foreground notification, deferred login and wrong-owner tap: truthful scheduling and UI.
- Duplicate/late daily-review taps and ambiguous POST reuse one request; day boundaries,
  empty days, salary/refund and category totals are authoritative; ledger remains unchanged.

## Quality and delivery gates

Pinned Windows tools: Node 22.23.4, pnpm 10.12.2. Repository gate:

```text
pnpm --filter @jizhang/shared build
pnpm -r run lint
pnpm -r run typecheck
pnpm -r run test
pnpm build
```

Generate/check the Xcode project after Swift membership changes. GitHub macOS native
tests, compact/large-text screenshots and Release iPhone arm64 packaging must pass.
Backend/Android/container workflow validates shared contract compatibility and actual
image lifecycle. Record exact commits, counts, run IDs, artifact metadata and checksums.

Inspect new selection/revision/task and permission/reminder/native-workspace screenshots.
Download only the successful identified native run, verify SHA/source/ZIP/iPhoneOS/arm64,
then copy to a unique delivery IPA. Do not overwrite earlier verified artifacts.

Physical notification delivery/tap routing, Keychain/login, Sideloadly signing and real
provider conversations require separate device evidence. User still deferred connecting
the phone. No production deployment or hidden paid inference during automated checks.

## Integration risks to resolve in code

- Immutable action/request identity across a correction, two confirmations or a continuation.
- Result pagination and interaction size limits on native 64 KiB event lines and replay.
- Old-client decoding when richer interactions become available; no silent protocol rewrite.
- File/network/worker side effects cannot be simulated safely by rolling back SQLite.
- Notifications are local OS scheduling; user permission is required and delivery is not
  proved by a scheduler mock. A pending reminder is never permission for background inference.

## Final planning review

Independent read-only review found no remaining product decision after the user's time/
tap-only answers. Its concrete legacy-trace disclosure finding is incorporated above and
in the design. This review does not replace the required user final-scope approval.
