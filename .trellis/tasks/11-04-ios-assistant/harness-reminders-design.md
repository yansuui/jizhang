# Conversational workspace design

## Change boundary

The gap lives between existing typed domain adapters and the native conversation UI:
resource results are generic JSON, ordinary drafts cannot be revised, confirmation ends
the task, and native-only features have no trusted conversational entry. Notifications
have no implementation. Reuse the current generation/confirmation infrastructure.

Expected areas are server assistant types/registry/conversation/generation orchestration,
new bounded interaction/workflow adapters, iOS Assistant/App/My/Core surfaces and their
tests. Missing file/photo workspaces use existing service routes. Shared accounting maths
stay unchanged. A reminder does not introduce server cron or background model inference.

## Capability ownership

Use the current executable registry plus one curated native-action catalog as the source
for discoverable capabilities. Each entry has a stable identity, readable purpose, actual
availability, permission and supported interaction. Runtime catalog/UI must agree with
the capability audit; never advertise a placeholder as executable.

Typed conversational reads/writes use current domain services and immutable tenant/actor.
Credential forms, invite plaintext, file/photo pickers, export sharing and notification
permission use enum-based trusted client actions. A model-provided URL/tool name is never
an executable native route. Native forms retain their real save/confirmation and ownership
behavior; a chat summary cannot claim completion without an authoritative result.

Backup creation already has prepare/confirm; exports need actual same-origin file
transport. The server offers backup listing/creation, not backup download/live restore.
Cover the active route families without fabricating those missing server capabilities.

## Interaction and workflow state

Add small, versioned, bounded structures for resource/date/range/multiple-record choices.
The server owns interaction ID, conversation/generation, filter/snapshot, allowed IDs,
continuation cursor, expiry and consumption. The model asks for a kind and scope; adapters
read actual candidates. Large/hierarchical/equal-name resources use real paging/search.

A choice submits server-owned identity plus selected values and a stable request ID,
not a composer string containing JSON or display labels. Validate membership, tenant,
scope/freshness and bounds before consuming it and creating the continuation atomically.
Repeated identical answers return the existing continuation; changed answers conflict.
Existing single-choice/text inputs remain the negotiated compatibility path for old clients.

Persist the minimal original task intent, selected facts, action references and phase:
reading -> awaiting selection -> preparing -> awaiting confirmation -> executing ->
reporting -> completed/failed/cancelled. This is not an unbounded second agent runtime.
Retain the existing eight-decision/180-second generation policy, history/result/replay
bounds and background job handoff. Cross-turn state does not depend on twenty recent
messages still containing every earlier selection.

Successful human confirmation resumes only the original requested task using the same
action identity and an idempotent continuation identity. Reread authoritative results
before reporting. A later proposed write pauses again for its own visible confirmation.
Uncertain confirmation first reconciles the original action, never creates a new write.

## Result cards, draft revision and organization

Render domain rows/summary facts with readable names, amounts/dates, coverage, next-page
controls and allowed select/view/prepare actions. Actions are validated against the
persisted result and trusted descriptors. Query pages never silently become full history.

Revision means cancel/supersede the old pending action and prepare a replacement using
current domain revisions/tokens, with a stable new request identity and explicit relation
to its predecessor. Do not mutate an already approved payload in place. A confirmed old
action cannot be revised as an unexecuted preview. Failure/uncertainty leaves a truthful
state and never re-enables a superseded card. Show before/after and exact selected scope.

Historical and structural organization use structured selections and direct typed paging/
prepare operations. Remove the 2000-character composer-prompt bridge and unnecessary model
inference for deterministic actions. The existing apply/undo validation and selected-ID
confirmation remain authoritative, including reference-only note suggestions.

## Streaming and live activity

Keep the current SSE framing, sequence/replay/UTF-16 reducer, snapshot recovery and stable
provisional IDs. Stream actual validated prose for eligible provider modes; label buffered
delivery. Financial fields remain non-actionable until the whole card validates.

Own live activity once per generation/task and update it while work is active, through
bounded trace refresh or explicitly negotiated additive events. The existing trace is
one-shot and cannot simply be relabelled live. Use fixed operation metadata/title/status;
fix current arbitrary string-prefix/numeric argument persistence before promoting it.
Do not expose hidden model reasoning, raw bill notes, provider bodies or secrets. Trace
failure remains best-effort and cannot fail a financial operation or the conversation.
Historical trace rows may already contain old string/numeric argument summaries. Do not
publish those legacy values into the new activity view: discard/redact them at the read
boundary and safely clear obsolete content where appropriate, preserving step identity,
status and timestamps. Seed old rows in a regression; fixing only new writes is insufficient.

## Native workspaces

- Reuse provider and invitation screens behind permission-aware trusted cards; add password
  change and safe logout/server-switch routing without model credential access.
- Implement reviewed generic transaction/transfer CSV import using isolated preview plus
  explicit consent before original mutation; raw file bytes stay outside model context.
- Implement existing merged platform import routes: upload/replace/remove, paged rows,
  conflicts/comparison, staged edits, reanalysis, revision/live view and frozen confirmation.
- Add authenticated allowlisted CSV download/share transport with cookie/origin/cancellation
  rules, appropriate filenames and cleanup. Do not send private cookies to redirects.
- Add native item-photo picking/display/apply/remove and cutout status/cancel/candidate
  review through existing owned routes; worker unavailable differs from an empty result.

These workspaces are real scope, not links to future-availability pages. Reuse existing
import original-file/digest/idempotency guards and expose native outcomes to the owning
workflow only after actual success. Logout invalidates all old work and local files.

## Daily reminders and review

Schedule two independent local calendar notifications through a small injectable
UserNotifications boundary. Defaults are 20:00 recording and 21:00 review; settings
allow independent enable/disable/time changes and show actual authorization state.
Request OS permission from an explicit enable action. No APNs entitlement or remote
notification/model scheduler is assumed.

Preferences are scoped by normalized server and immutable authenticated user ID. Only
the active account has armed schedules; logout/server/account replacement removes owned
pending and delivered notifications. Payloads use a minimal owner/action identity, no
ledger amounts, provider secrets or account descriptions. Delegate callbacks enter the
main actor; stale notification owners cannot open/generate against a new account.

Use TabView selection and a small owned intent router. Recording opens the existing entry
sheet. A review tap supplies its delivery date to an explicit daily-review intent; login
restoration may defer it until the matching account is verified. Do not automatically
authenticate a different account or reuse an earlier server's prompt.

Persist a small owner/delivery/day review outbox before generation: intended date/scope,
conversation reference when known, stable generation client request ID and submission
state. Duplicate taps reopen/reconcile the same job. Ambiguous POST preserves identity;
there is no automatic second model request. Only the tap explicitly starts generation,
not opening settings, receiving a foreground notification or ordinary startup.

Daily facts use existing server services for a precisely bounded day: income/expense,
salary/refund distinction, categories/accounts and bounded candidate issues. Add a typed
daily read adapter if existing combinations cannot provide complete exact scope within
the generation budget. Explain potential anomalies as suggestions, not proved duplicates.
No report writes bills or applies organization suggestions. A delivered old notification
must display which day it will review before/while generation, not silently switch days.
The ledger currently displays Gregorian days in Asia/Shanghai. Derive the review day from
the notification's delivered occurrence in that ledger zone; freeze/show its date and zone.
Reminder clocks remain device-local. Daily transaction summaries exclude salaries, so
include the complete server salary window separately rather than summing a first page.

## Compatibility, testing and rollout

Negotiate new interactions/client actions, preserve old version-1 conversation/action
decoding and existing Android behavior; update Android's affected stable inventory entries
for shared contracts without claiming Android UI implementation. Persisted migrations,
if needed, are additive and tenant-owned; old actions/history remain readable.

Use isolated real-domain/route/provider fixtures for selection -> revision -> consent ->
continuation and all capability rows. Swift mock transports cover stale owners, uncertain
submissions, duplicate notification taps, permission denial and deterministic schedules.
Actual macOS native tests and simulator screenshots are required for all new card/forms.
Final delivery stays on original main, with a verified unsigned arm64 IPA for Sideloadly.
Deployment/live-provider/signed-device notification acceptance remain distinct checks.
