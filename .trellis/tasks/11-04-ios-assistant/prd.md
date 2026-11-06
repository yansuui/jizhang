# Native iOS client and simplified AI assistant

## Goal and status

**Expanded-scope planning (2026-11-06):** a conversational project workspace with
selections, revisable/confirmed mutations, task continuation and daily reminders.
The user confirmed 20:00 recording / 21:00 review (editable), with review generated
only after a notification tap. See [current PRD](harness-reminders-prd.md),
[design](harness-reminders-design.md) and [execution plan](harness-reminders-implement.md).
The user approved this expanded scope with “实施”; implementation is active and earlier
delivered fixes below remain.

**Latest follow-up (2026-11-06, assistant):** repair frequent unfinished turns and the
historical-organization workflow shown in the user's screenshot. The authoritative scope
is [`assistant-reliability.md`](assistant-reliability.md); server deployment, live provider
and physical-device results remain separate evidence. Continue directly on original main.

**Earlier follow-up (2026-11-06, bills):** fix centred bill modal/background/tab interaction,
improve daily-statistics layout and make the type/account/date filters scroll with bills.
See [`bill-ui-polish.md`](bill-ui-polish.md) and its verification record.

**Current continuation:** the user's six-item request on 2026-11-05 authorizes
bill sheets, linked refunds, expense/income entry, account/date filters, existing
four-purpose allocation editing and full business-tool assistant execution.
The user confirmed existing four-purpose allocation (not custom plan categories).
[`functional-parity.md`](functional-parity.md) is the authoritative current scope;
it supersedes the first-delivery read-only and preview-only restrictions below.
All further work stays directly on original-repository `main`, per user instruction.

Deliver a native iPhone client for the existing accounting service, prioritizing readable AI conversations and short provider setup. The user requested iOS, conversation-list improvements, simpler configuration and presentation of the remaining features on 2026-11-04.

The user accepted proceeding on 2026-11-04 and directed GitHub compilation followed by installation using the already-open local Sideloadly. This authorizes implementation, a personal GitHub build fork/branch, Actions execution, artifact download and local sideload preparation. Apple ID authentication remains local to Sideloadly.

On 2026-11-05 the user explicitly directed all further code submissions to the original `yansuui/jizhang` repository instead of a fork. This supersedes the earlier build-fork route. Preserve historical artifact provenance, but use the original repository for subsequent source pushes and new builds.

## Confirmed background

- The maintained client is Android Kotlin/Compose. There is no Swift/iOS project. The old 09-12-iphone-delivery task describes the retired Web client and explicitly excluded native iOS.
- The backend already supports cookie authentication, conversations, streaming generations, configuration and model discovery. Financial calculations belong to server/shared.
- History is full-screen, but its row still has a 148–240 dp width constraint and one-line title: clients/android/app/src/main/java/com/yansuu1/jizhang/ui/AssistantTab.kt:1068 and :1872. This is source evidence, not an iPhone reproduction.
- Discovery requires saved credentials. Initial setup currently requires disabled-AI connection saving, model selection and another save: clients/android/app/src/main/java/com/yansuu1/jizhang/ui/ProviderSettings.kt:636 and :705; packages/server/src/routes/ai.ts:68.
- This workstation is Windows with no swift or xcodebuild. Apple build/device evidence cannot be inferred from Windows source checks.

## Confirmed requirements

| ID | Requirement |
|---|---|
| R1 | Native SwiftUI iPhone app, iOS 17 minimum, Chinese interface, Xcode project and existing backend login/server configuration. |
| R2 | Home, Bills, Plan, Assistant and My navigation; native back, safe areas, Dynamic Type, dark mode and keyboard-aware layout. |
| R3 | Full-width conversation rows, two-line titles, update time, selection, title search, date grouping, refresh, new conversation and explicit archive; distinct loading/empty/error states. |
| R4 | Functional text chat: history, real incremental replies where supported, Stop, clarification choices, per-conversation drafts, snapshot recovery and history-friendly scrolling. |
| R5 | Three primary provider inputs: service address, API key, model. Advanced holds protocol/auth/timeout/custom settings. Searchable model picker/manual input, explicit save/test and guided connection-save/discovery. |
| R6 | Preserve existing secret and hidden settings during basic edits. Distinguish saved/enabled/tested states. Failures retain drafts; server/session changes invalidate requests. |
| R7 | Native read-only presentation of balances/recent bills, bills/details, plans/budgets, statistics, accounts/categories/tags, salaries/templates, recurring/pending, transfers/trash, items and data/settings catalogue. Use real read APIs and honest availability states. |
| R8 | Build/test instructions and feature/verification inventory; accurately separate source, compilation, simulator, device and live-provider evidence. |

R7 interprets “其他功能就先展示” as read-only presentation, not complete Android editing parity. R4 displays readable pending accounting previews; ledger confirmation, file import and AI old-bill organization execution are deferred. These are the reviewed first-delivery boundaries; the subsequent user instruction adds the GitHub/Sideloadly delivery route.

## Acceptance criteria

- [x] A1 (R1–R2): Runnable Xcode scheme, login/server configuration and five native destinations; actual build status reported separately.
- [x] A2 (R3): Readable long-title/list/error layouts and working create/select/refresh/archive API calls.
- [x] A3 (R4): A → B → A rejects stale/cross-conversation results; final messages replace provisional messages; reconnect never automatically sends another prompt.
- [ ] A4 (R4): Reading history does not force scrolling; keyboard leaves composer usable; Stop/clarification cannot double-submit.
- [x] A5 (R5): First setup supports manual model input or explicit connection-save/discovery. Only three primary fields; selecting a model edits the draft only.
- [x] A6 (R6): Blank key preserves secret; hidden custom fields survive edits; failed discovery preserves model; enabled is never mislabelled tested.
- [x] A7 (R7): Other pages display server values without alternate accounting arithmetic or simulated writes. AI drafts do not silently confirm transactions.
- [x] A8 (R8): Meaningful transport/state/decoding tests and honest build/device evidence.

The checked items have source and native fixture-test evidence, reconfirmed in successful run `41819877293` (77 passing tests), plus simulator/device compilation and inspected exported screenshots. A4's interactive keyboard/scroll behavior remains device acceptance. These checks do not claim a live-provider test or physical installation. The user subsequently requested the IPA first and will connect the iPhone later. See [delivery.md](delivery.md) for exact artifact and remaining checks.

## Deferred scope

Full editing/confirmation parity, merged import, AI organization execution, backups/restore, cutout, App Store/TestFlight, App Store release signing, push notifications, offline sync and dedicated iPad layout. No Android redesign, schema change, production deployment or live-provider configuration changes during development.

## Review

The review gate is satisfied by the subsequent user instruction to use GitHub compilation and local Sideloadly deployment. Native checks will run on a GitHub-hosted macOS runner. Produce an unsigned device IPA and sign/install locally; no Apple credentials or signing certificates go to GitHub. Current gh account has READ access to the source repository, so use a personal build fork rather than requiring upstream write access. Device inspection found D:/Sideloadly/Sideloadly.exe v0.72 open, currently with no devices detected.
