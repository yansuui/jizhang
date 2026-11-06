# Daily recording and review reminders — source and platform research

Research only, 2026-11-06. No product code, production configuration, device permission,
scheduled notification or live inference was changed during this research.

## Confirmed user choices

- Recording reminder: **20:00**, review reminder: **21:00**, both editable.
- Use the device's local clock for the reminder time.
- Generate the review only after the user taps its notification. Do not invoke a model
  automatically at the scheduled time. The tap is the explicit request for that review;
  do not introduce another mandatory Generate confirmation in the ordinary success path.
- Financial changes proposed by a review still need their normal separate approval.

## Repository evidence

| Boundary | Current source evidence | Consequence |
|---|---|---|
| App lifecycle | `clients/ios/Jizhang/App/JizhangApp.swift:13` declares the app; `:20` remounts the authenticated feature tree by `api.identity`; `:35` restores authentication. | Install the notification delegate before launch completes, but defer authenticated routing until this session has validated its user. |
| Tab and recording route | `JizhangApp.swift:41` declares private `MainTabView`; `:48` has a `TabView` without a selection binding or tags; `:45` owns recording state and `:60` presents the transaction editor. | Add an explicit tab/destination route owner; a notification cannot currently open this sheet or select Assistant. |
| Settings entry | `clients/ios/Jizhang/Features/My/MyView.swift:25` starts the AI settings section; no reminder section or notification permission status exists. | Add a compact daily-reminder page here, backed by one shared reminder store. |
| Session replacement | `clients/ios/Jizhang/App/AppSession.swift:117` signs out, `:131` clears the active API, `:157` activates a validated client, and `:163` handles owner-scoped 401. | Reminder requests and pending notification routes need explicit login/logout/401 ownership reconciliation. |
| Stable account identity | `clients/ios/Jizhang/Core/AuthenticationModels.swift:4` has optional immutable `id` for legacy login; `:5` also exposes username. `APIClient.swift:36` has a fresh UUID per client and `:38` its immutable base URL. | Persist settings under canonical server + authenticated immutable user ID. Use the API UUID only for in-flight callback fences, not durable reminder identity. Legacy accounts without ID can keep generic reminders but must not silently inherit identity-bound automatic review recovery. |
| Conversation creation | `clients/ios/Jizhang/Features/Assistant/AssistantStore.swift:111` creates a conversation; `:155` opens/reconciles history and latest generation. | Reuse this path for the review thread rather than opening an unrelated browser/deep-link client. Creation currently has no client idempotency key. |
| Generation identity | `AssistantStore.swift:4` models `AssistantSubmission`; `:15` holds a draft request ID; `:199` sends text; `:225` retries the same pending submission; `:239` preserves submission identity before network work. | A notification-launched review should use the same generation protocol, stream reducer and uncertain-submission behavior. Its durable launch intent needs a stable conversation/request pair before inference begins. |
| Existing date convention | `clients/ios/Jizhang/Features/Bills/LedgerBillDates.swift:5` fixes the displayed ledger calendar to Gregorian/Asia-Shanghai; `:20` produces exclusive end-of-day ranges. | Distinguish device-local notification time from the ledger day being reviewed; include the actual date and IANA zone in the request and heading. |
| Authoritative daily facts | `packages/server/src/routes/transactions.ts:150` serves daily summary; `transaction-service.ts:1283` explicitly excludes salary and transfer tables, while `:1325` uses shared expense/income contributions. | Do not call that result total income including salaries. Ordinary refunds remain income and gross expense remains unchanged. |
| Other review facts | `assistant-business-tools.ts:218` exposes `transactions.daily`; `:303` exposes `stats.query`; `stats-service.ts:80` explains salary exclusion from category-window summaries; `salary-service.ts:271` offers a complete `listInWindow`. | A truthful full-day review needs complete server-owned salary and ordinary-ledger facts, not summing a bounded salary/list page on the phone. |

A repository search found no current `UNUserNotificationCenter`, APNs registration,
notification delegate, daily reminder scheduler or notification tap routing implementation.
Existing periodic/recurring bills are financial recurrence, not OS notifications.

## Platform decision

Use **two local repeating calendar notifications** with hour/minute components and
`UNCalendarNotificationTrigger(..., repeats: true)`. The system can deliver a scheduled
notification when the app is closed or in the background; the foreground callback chooses
presentation. This matches the confirmed tap-to-generate behavior without a server cron,
background model execution or an APNs provider. Delivery remains subject to the user's
notification settings and system presentation policies; do not describe it as an alarm
with guaranteed exact-time delivery. [Apple local scheduling](https://developer.apple.com/documentation/usernotifications/scheduling-a-notification-locally-from-your-app)

Remote APNs is a separate delivery system requiring the push entitlement, registration,
device token and provider-server handling. Apple's current supported-capabilities table
marks Push notifications available to ADP/ADEP, with the no-cost Apple Developer column
empty; this was checked in the page's raw HTML because the text renderer omitted icons.
The current unsigned-IPA/Sideloadly workflow must not assume those entitlements or APNs
configuration. The accepted local reminder design avoids that dependency.
[Apple APNs registration](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns),
[Apple supported iOS capabilities](https://developer.apple.com/help/account/reference/supported-capabilities-ios)

## Permission and settings behavior

- A reminder page has two enabled switches, two time controls and current permission
  status. Defaults are 20:00 and 21:00. Preference enabled and OS authorized are separate
  states; a denied permission must never display an effective scheduled state.
- Explain the two reminders, then request `.alert`/`.sound` from an explicit enable action.
  Do not automatically request permission on initial launch. The first authorization
  request prompts; later requests do not prompt again. Read current settings before
  scheduling and on scene activation. [Apple permission guidance](https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications)
- When denied, retain the chosen times, show that notifications are off at system level,
  and provide an Open Notification Settings action. Use
  `UIApplication.openNotificationSettingsURLString`; do not repeatedly re-request.
  [Apple settings URL](https://developer.apple.com/documentation/uikit/uiapplication/opennotificationsettingsurlstring)
- Keep the lock-screen title/body generic, with no amounts, account names, usernames,
  bill notes, provider details or generated review text. Do not set an unread badge until
  a real unread-count contract exists. Permission refusal does not block normal accounting.

## Scheduling ownership and race handling

1. Derive a non-secret namespace from normalized server plus authenticated immutable user
   ID. Store per-owner times and switches in local preferences; do not use an API UUID as
   the persistent key. Only the active validated owner has scheduled requests.
2. Each owner has stable identifiers for recording/review. Reuse identifiers when changing
   time; Apple replaces an existing pending request with that identifier. Disable removes
   that request. Reconciliation removes obsolete app-owned reminder IDs and delivered
   reminders without touching unrelated future notification features.
   [Apple request identity](https://developer.apple.com/documentation/usernotifications/unnotificationrequest/identifier)
3. A single scheduler reconciliation runner drains desired state. Settings/logout events
   update the desired owner/configuration and revision; no second apply loop may overlap.
   After an awaited add/settings read, a stale revision must reconcile to the newest
   desired state. A late scheduling completion must not recreate an old user's reminder
   after logout. Test this with a deliberately delayed add callback.
4. Sign-out/401/server or account replacement clears active pending/delivered reminders and
   any pending route for that owner. The per-owner time preference can remain for a future
   login. A cold-start tap can wait for restore; it must never send an old owner's prompt
   using a newly logged-in account with the same display name.
5. The app delegate is installed before launch completion using the SwiftUI app-delegate
   adapter. It queues a small typed route from the notification response, completes the
   system callback promptly and lets authenticated UI handle later network work. A
   foreground delivery only presents a notification; it does not start inference.
   [Apple notification delegate](https://developer.apple.com/documentation/usernotifications/unusernotificationcenterdelegate)

## Tap routing and one explicit review request

**Recording:** after a matching owner is authenticated, select the accounting/Home tab
and present the existing transaction editor once. The user fills and saves it normally;
notification handling never books a transaction itself.

**Review:** create or reopen that owner's review conversation for the notification's ledger
date, select Assistant, show the request and start one normal streaming generation. The
tap supplies the user intent; an extra Generate tap is unnecessary. The generated review
is read-only. It may offer further selected changes through ordinary approval cards.

Use `UNNotification.date` (the delivered occurrence) rather than app-open time for a late
tap. Convert it to the existing displayed ledger zone, show that exact date, and freeze
the resulting day/zone in the input before generation. A repeating request's static
payload cannot safely hard-code the day when it was first scheduled.
[Apple delivery date](https://developer.apple.com/documentation/usernotifications/unnotification/date)

The coordinator should persist a minimal launch intent keyed by owner/review/day, then
the conversation ID, request ID and frozen generic input before the inference POST.
Repeated taps of the same occurrence reopen/reconcile that same request and do not allocate
a new request ID. Reconciliation/history reads never start inference. An ambiguous
generation response keeps the original request and explicit Retry behavior; a later
ordinary app launch does not automatically submit another model request. A lost response
from conversation creation may leave an empty conversation, but must not produce paid
inference until a real conversation ID is known and persisted. If the root adds a
server-owned daily-review launch endpoint, make its owner/day/request creation atomic and
idempotent rather than adding an independent provider path.

## Review fact boundary

Prefer a small read-only daily review tool/service returning a validated day/zone and exact
ordinary expense/income, refund-income subset, separate allocated/salary income, counts,
category totals and bounded evidence with truthful pagination. Reuse the current domain
services/shared contributions and `SalaryService.listInWindow`; the phone and model must
not rederive total money from the first page. Transfers are not income or expense. Empty
days need an explicit no-record state, not an invented result. Potential duplicate/unusual
records are advisory and carry their actual IDs; the review cannot delete/reclassify them.
This is a recommendation for complete facts, not a claim that such a tool already exists.

## Acceptance and tests

- Authorized settings schedule exactly two app-owned repeating requests at 20:00/21:00;
  changing time replaces rather than duplicates them. Switching either off removes only it.
- Denied/not-determined state, permission request success/failure and Settings return are
  visible and truthful. No permissions test relies on a real system prompt in CI.
- Logout/account/server/401 and delayed scheduler completion leave no old-owner requests
  or auto-routed work; canceled/replaced authentication cannot publish to a new owner.
- A matching cold-start recording tap opens one editor. A mismatched owner sends no POST.
- One review tap starts one request after login, repeated taps recover it, and a failed or
  ambiguous response preserves the same identity. No notification scheduling, foreground
  delivery, normal app reopen or automatic reconnect invokes a model.
- A previous day's notification tapped after midnight still shows/reviews its own explicit
  ledger date. DST/device-zone changes keep the local reminder clock and ledger date
  concepts distinct; exercise calendar components without a 24-hour arithmetic shortcut.
- Review fixtures cover empty days, ordinary refund income, salary-only income, exact cents
  and more rows than one result page. No read/review/notification action changes a ledger.
- Use an injected notification-center adapter and isolated preferences for state tests;
  real authorization, closed-app delivery and tap routing require the final signed iPhone
  build. Simulator/source checks are not physical Sideloadly delivery evidence.

## Expected implementation boundary

New native reminder model/store, notification-center adapter/delegate and settings view;
small hooks in `JizhangApp`/`AppSession`/`MyView`; typed tab and assistant launch routing;
review intent persistence and existing generation recovery. Add a read-only server daily
fact adapter only if the root elects the complete-day tool above. No APNs keys/certificates,
device token registry, server cron, model billing while the app is closed, financial
auto-writes or Android notification implementation is needed for this accepted behavior.
