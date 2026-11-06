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
- `Features/My/DailyReminderSettingsView.swift`: compact permission/two-clock/two-toggle
  settings, actual scheduled status and denied-permission Settings entry.
- `App/JizhangApp.swift`: injected shared store, authenticated API identity lifecycle,
  early delegate, real tab tags/selection, recording/workspace sheets and queued routes.
- `JizhangTests/DailyReminderTests.swift`: 16 native tests plus reusable test-only center/
  outbox fixtures.

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

MainTabView holds notification routes behind an already-presented editor/workspace rather
than discarding an unsaved form. It injects the root's `openJizhangWorkspace` closure and
`jizhangCanManageInvitations` capability, and calls
`NativeWorkspaceSessions.clear(apiIdentity:)` only on actual API-owner replacement and
explicit logout. It is deliberately not attached to MainTabView disappearance, which
can occur for presentation and must retain frozen uncertain receipts.

## Verification state

Source review, owned-file whitespace checks and the Chinese-placeholder search passed.
This Windows workstation has no Swift/Xcode command; **the 16 test sources are not a
claim of executed native tests**. Root must run macOS CI after all workers freeze.

The tests exercise authorized default clocks, stable replacement/independent disable,
denial and explicit permission, delayed-add logout cleanup, separate same-name accounts,
pre-login recording tap, wrong-owner review rejection, frozen day/checkpoints, duplicate
review recovery after restart/uncertainty, old API fences, legacy-ID availability, malformed
notification identity, schedule failure, outbox write failure and real atomic file storage.
All fixture API clients use host `example.com` with CoreMockURLProtocol; no live HTTP or
system permission prompt is necessary for these state tests.

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
These are source additions until macOS CI executes them and exports their attachments.

Read-only cross-review of root's Native workspace files reported concrete asynchronous
state issues for root to resolve: photo load or old cutout-status reads overwriting a
later save/cancel/new job, and a CSV export finishing after disappearance leaving a private
temporary file without cleanup. No root product file was edited for those findings.
Root also identified the feature-disappearance cache cleanup issue above; the App owner
applied the narrower actual-owner/logout hook. Final integrated evidence belongs to root.
