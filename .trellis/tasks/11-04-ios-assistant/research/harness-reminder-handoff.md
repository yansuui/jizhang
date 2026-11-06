# Reminder implementation handoff — 2026-11-06

This is the implementation companion to `daily-reminder-design.md`. Root owns final
repository/native checks, Xcode project generation, screen captures and delivery.

## Owned files

- `Core/DailyReminderModels.swift`: clocks/preferences, hashed server/account owner,
  strict delivered-notification decoding and frozen daily-review launch/outbox models.
- `Core/DailyNotificationCenter.swift`: injectable notification boundary and real
  UserNotifications adapter; two stable repeating calendar requests without a fixed zone.
- `Core/DailyReminderStore.swift`: owner-scoped preferences, permission and serialized
  reconciliation, tap routing and durable request checkpoints.
- `Core/DailyReviewOutboxStorage.swift`: synchronous protected atomic file persistence;
  this deliberately differs from ordinary UserDefaults preferences so a checkpoint
  completes its write before inference POST. Corrupt/unreadable records fail safely.
- `Core/NativeNotificationDelegate.swift`: early app delegate registration, default-tap
  decoding and foreground presentation. Neither delivery nor foreground presentation
  starts a model request.
- `Core/NativePresentationGate.swift`: injectable bounded presenter observation and
  owner-scoped FIFO route queue; destination appearance acknowledges presentation.
- `Core/NativeWorkspaceCompletionRelay.swift`: one-shot native success receipts kept
  local until actual root workspace dismissal, fenced by the active API owner.
- `Features/My/DailyReminderSettingsView.swift`: compact permission/two-clock/two-toggle
  settings, actual scheduled status and denied-permission Settings entry.
- `App/JizhangApp.swift`: injected shared store, authenticated API identity lifecycle,
  early delegate, real tab tags/selection, recording/workspace sheets and queued routes.
- `JizhangTests/DailyReminderTests.swift`: 17 native tests plus reusable test-only center/
  outbox fixtures.
- `JizhangTests/NativePresentationGateTests.swift`: ten native gate/queue/receipt test sources.

No changes were made to AppSession, MyView, Assistant files, APIClient, project membership,
Android source, production settings or live provider configuration by this worker.

## Behavior and boundaries

Defaults are 20:00 recording and 21:00 review, each independently editable/disabled.
Times follow the device clock. Permission is requested from the explicit enable/Allow
action, never automatically from startup. Denied status retains preferences but arms
no request. Refresh and scene activation reread actual permissions. Generic notification
payloads contain a schema, hashed owner and kind only, with no amounts or ledger text.

Only the current normalized-server/immutable-account identity arms reminders. Replaced
API UUIDs fence callbacks. A legacy authenticated user without immutable ID gets generic
recording reminders but no automatic review recovery; the UI explains availability.
Logout/401/account replacement drives pending/delivered cleanup. The single reconcile
runner drains a newer desired state after an awaited old add, so late completion cannot
recreate the logged-out owner's schedule. Unrelated app notifications remain untouched.

A notification received before login waits in memory for verified account restoration;
it never silently runs against a different account. Recording opens the existing editor
once. Review freezes the delivered occurrence's Gregorian Asia/Shanghai day and starts
only from the tap-authorized assistant launch. Opening the app normally does not load or
execute persisted outboxes. A date is not taken from the later app-open clock.

## Assistant integration contract

Agreed with the Assistant owner:

```swift
AssistantView(api: api, launch: AssistantLaunchIntent?,
              onLaunchCheckpoint: ((AssistantLaunchIntent, DailyReviewCheckpoint) -> Bool)?)
```

`AssistantLaunchIntent` carries stable logical `id` (owner/day), API UUID, date/zone,
`clientRequestID`, optional conversation, `mayStart`, and a `presentationID` nonce.
Each actual tap changes presentation ID so an old conversation can reopen; checkpoints
preserve the latest nonce. Concurrent reroutes share the assistant's in-flight task by
logical ID and do not create another conversation/model call.

Checkpoint events are `conversation(conversationID)` before inference,
`submitting(conversationID)` immediately before POST, `accepted(generationID)` or
`uncertain(conversationID)` after it. They synchronously validate/persist owner, API,
conversation and request identity and return false if the next step cannot proceed.
Repeats reopen the same stored conversation/request; accepted requests cannot resubmit.
An uncertain request exposes explicit same-ID Retry, never an automatic POST on reopen.
The assistant owner uses the new typed daily-review workspace endpoint; this store makes
no HTTP requests and cannot write bookkeeping data itself.

MainTabView queues native routes and notifications until the active UIKit presenter and
its child controllers have no presented modal or active transition. This includes assistant
capability/confirmation/revision sheets and full-screen bill cards. The observer is bounded
and cancellable; an unavailable presenter leaves the owner-bound request pending with a
visible retry control. Changing a sheet binding does not consume the request: recording
and native workspace destinations acknowledge their actual `onAppear`. Review starts only
after the Assistant tab is visible and the presenter is free. Already-opened notification
delivery IDs are ignored when a covered tab reappears; a new actual review tap can reopen
the same logical request with its new presentation nonce.

Each tapped review day has an independent in-memory authorization receipt. Checkpoints
validate this receipt plus the owner/API/date/zone/frozen request against the durable
outbox. An earlier queued day can finish after a newer-day tap without replacing the newer
route. Ordinary startup restores no receipts and cannot checkpoint or infer from an old
outbox. The active Assistant launch reads its own authorized day, not whichever notification
was tapped most recently.

MainTabView injects the root's `openJizhangWorkspace` closure and
`jizhangCanManageInvitations` capability, and calls
`NativeWorkspaceSessions.clear(apiIdentity:)` only on actual API-owner replacement and
explicit logout. It is deliberately not attached to MainTabView disappearance, which
can occur for presentation and must retain frozen uncertain receipts.

## Verification state

Source review, owned-file whitespace checks and the Chinese-placeholder search passed.
This Windows workstation has no Swift/Xcode command. Root reported that the original
16 reminder tests passed in native Build 19; the new cross-day receipt test and ten
presentation tests require the next macOS CI run. Source counts alone do not prove execution.

The tests exercise authorized default clocks, stable replacement/independent disable,
denial and explicit permission, delayed-add logout cleanup, separate same-name accounts,
pre-login recording tap, wrong-owner review rejection, frozen day/checkpoints, duplicate
review recovery after restart/uncertainty, old API fences, legacy-ID availability, malformed
notification identity, schedule failure, outbox write failure and real atomic file storage.
All fixture API clients use host `example.com` with CoreMockURLProtocol; no live HTTP or
system permission prompt is necessary for these state tests.

The gate tests cover actual availability observation, no consumption before appearance,
bounded timeout and retry, cancellation and owner replacement, FIFO/deduplication, stale
appearance callbacks, covered-tab notification replay, repeated review taps, and a nested
UIKit child presenter. No notification or provider request is needed by those tests.

Native workspace completion callbacks are stored without emitting an event or HTTP call.
Only the root workspace sheet's actual `onDismiss` takes the receipt once and posts
`.jizhangNativeWorkspaceCompleted`, with the current API owner checked again. A replaced
owner or explicit logout clears it; repeated Done callbacks cannot emit a second event.
Within one workspace, a later successful result replaces the pending receipt only for
the same owner, conversation and source message. For example, saving a cutout after the
original photo keeps the final photo hash for server verification. Another source cannot
overwrite that receipt. The App callback also verifies its captured route's source.
Assistant UI owns the existing-conversation listener and verified continuation call.

For a deterministic reminder screenshot, root can use test-only `ReminderCenterFixture`
(authorized by default), `ReminderOutboxFixture(preferences:)` and an isolated UserDefaults
suite, activate an example.com API/decoded user, await `waitForScheduling()`, then host
`DailyReminderSettingsView().environmentObject(store)` in its capture helper. Also capture
denied permission/large text if useful. Real permission, closed-app delivery, tap routing
and Sideloadly signing still require the signed physical iPhone build.

## Preview and integration follow-up

Root delegated `ScreenPreviewTests.swift` additions to this worker. Four simulator-render
test sources now cover authorized compact reminders, denied/large-text/dark reminders,
the actual read-only CSV import review, and a paged account-selection card with equal names.
They retain the existing visible synthetic-data banner and use only isolated stores and
mock HTTP. The reminder permission fixtures never invoke the real OS authorization prompt.
Root reported all four new previews passed in Build 19. The older conversation-list preview
needed a bounded empty workspace-capability mock after the additive catalog read; that
fixture was corrected and final CI/capture evidence remains root-owned.

Read-only cross-review of root's Native workspace files reported concrete asynchronous
state issues for root to resolve: photo load or old cutout-status reads overwriting a
later save/cancel/new job, and a CSV export finishing after disappearance leaving a private
temporary file without cleanup. No root product file was edited for those findings.
Root also identified the feature-disappearance cache cleanup issue above; the App owner
applied the narrower actual-owner/logout hook. Final integrated evidence belongs to root.

## Final independent source audit

The final audit rechecked notification delivery/delegate, scheduling/permissions, account
replacement and 401 cleanup, protected outboxes, cross-day tap receipts, nested modal
presentation, and native completion delivery through the Assistant listener. No unresolved
source blocker remains in those paths after the fixes below. Signed-phone permission,
Focus/delivery behavior, actual closed-app taps, modal gestures and Sideloadly installation
remain physical-device acceptance; mocks and source review do not establish them.

The audit found that presentation acknowledgment alone could release two different daily
launches concurrently, letting the shared conversation-create guard drop one day. The
Assistant owner fixed this with same-day task coalescing followed by a serial launch tail,
defer-resumed waiters for an existing manual create, and a conversation-scoped reconciliation
read with a read-ticket fence. It does not call global `open()` or steal the current chat.
Each Store-owned launch survives cancellation of an older view task and completes its own
create/read/submit handoff before the next day begins. Owner-bound durable checkpoints
remain required before the model POST; logout clears the in-memory tap receipt.

Read-only review also checked the three held-transport regressions in
`AssistantWorkspaceTests.swift`: queued A/B days with same-A coalescing, an already-running
manual conversation create, and a failed/cancelled first create releasing the next day.
The final tree contains 214 test methods, including 21 Assistant workspace tests and the
17 reminder plus 10 presentation/relay tests above. These are source counts; the final
macOS CI result and artifact verification are recorded by root separately.

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
