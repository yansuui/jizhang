# Conversational capability coverage audit — 2026-11-06

## Evidence and meaning of coverage

Read-only audit at `e666591` on original `main`. No product code, live provider,
production data or device was changed. The executable allowlist currently contains
**88 names**: 28 original registry tools plus 60 explicit business tools. This is
source registration, not proof of 88 reliable end-to-end conversations.

Source anchors used below:

- **B** = `packages/server/src/services/assistant-business-tools.ts`.
- **R** = `packages/server/src/services/assistant-tool-registry.ts`.
- **T** = `packages/server/src/services/assistant-types.ts`.
- **UI** = `clients/ios/Jizhang/Features/Assistant/AssistantView.swift`.
- **A** = `clients/ios/Jizhang/Features/Assistant/AssistantActions.swift`.

`T:23` is the current executable allowlist; `R:387` requires every advertised name
to be registered. `T:67` separately accepts historical template names in decoders
only. The earlier `research/assistant-business-matrix.md` is historical: it still
describes template tools that have since been removed and must not be copied as
current implementation evidence.

## Existing business coverage

Each row distinguishes model adapters from what the iPhone can actually select or
review. All financial writes below must remain pending until explicit human
confirmation; catalog presence does not grant model authority to call HTTP paths.

| User capability / route family | Existing read / analysis adapters | Existing confirmed mutation adapters | Source anchors / material gap |
| --- | --- | --- | --- |
| Bills, income, expense, linked refunds: `/transactions`, detail, daily totals | `transactions.recent`, `transactions.query`, `transaction.details`, `transactions.daily` | `transaction.create/update/delete/restore`; create includes refunds and canonical fund purpose | `routes/transactions.ts:140/149/160/170/179/191`; B:201/203/218; R:476/548/581/637/653. Generic result details are inspectable, but bill result rows do not offer typed select/edit/refund actions. |
| Account list, balances, historical references | `accounts.balances`; `master-data.read` kinds `accounts`, `account-usage` | `account.create/update/delete`, `master-data.move(kind=accounts)` | `routes/master-data.ts:125/138/143/149/158/164/226`; B:219/230; R:497/751/765/782. Need account choice bound to actual IDs, display names and original scope. |
| Categories, hierarchy, usage and order | `master-data.read` kinds `categories`, `category-usage` | `category.create/update/delete`, `master-data.move(kind=categories)` | `routes/master-data.ts:90/97/103/112/118/219`; B:219/230; R:688/709/736. Category lookup plus selected bill/category changes is a composed flow. |
| Hierarchical tags and legacy name tags | `master-data.read` kinds `tags`, `tag-names` | `tag.create/update/remove`, `tag.rename/delete` | `routes/master-data.ts:171/175/180/184/191/196/208`; B:219/232/233/234; R:930. Do not confuse deleting a hierarchy node with removing a name from bills. |
| Account-to-account transfers | `transfers.query` (list/detail/account filter) | `transfer.create/update/delete` | `routes/transfers.ts:82/88/94/99/108`; B:235/236/237; R:670. Transfers retain their non-income/non-expense meaning. |
| Trash browse, single/all restore, single/all permanent purge | `trash.list` | `transaction.restore`, `trash.restore-all/purge/purge-all` | `routes/trash.ts:68/77/86/94/100`; B:238–241; R:653. Permanent/all-scope effects must be named in the consent card; no generic future authorization. |
| Recurring rules, occurrences, pending bills | `recurring.rules(view=rules/occurrences/pending)`, `recurring.pending` | `recurring.create/update/toggle/delete/generate/confirm/ignore` | `routes/recurring.ts:68/73/79/91/102/120/127/135/141/151`; B:245–254; R:525/896/913. Generation creates pending occurrences; only occurrence confirmation books money. |
| Four-purpose configuration, balances, migration issues, income review | `funds.read(view=summary/config/capabilities/issues)` | `funds.configure`, `funds.review` | `routes/financial-funds.ts:25/29/33/39/43/48`; B:256/259/260. Require actual revisions, source tokens and selected sources; prospective ratio changes do not rebalance history. |
| Allocated income/salary list/detail and edits | `salaries.read` | `salary.create/update/delete` | `routes/budget.ts:120/125/130/136/155`; B:261/264/266/268. Canonical `contractVersion=1` only; avoid recording the same receipt as ordinary income again. |
| Independent plan and monthly plan | `plan.read`, `plan.preview`; `planning.read(view=monthly)` | `plan.save` | `routes/budget.ts:225/232/241`; `routes/financial-planning.ts:79`; B:272–274/318. Plan save changes plan settings, not ledger balances. |
| Manual reserve/investment openings and progress | `goals.read(view=summary/entries/operation)` | `goals.opening/create/update/delete` | `routes/financial-goals.ts:54/60/67/72/78/87/97`; B:276/281/283–285. Existing cursor contract must survive selectable result pages. |
| Budget overview, periods, cycle start day | `budget.overview`, `settings.read` | `settings.cycle` | `routes/budget.ts:104/114/192/203`; B:300/301; R:508. Read tools already cover these routes; no separate generic settings writer is required. |
| Existing financial execution config/category mappings/salary sources/period revisions/execution facts/purpose/refund splits/operation lookup | `planning.read` explicit views; `planning.preview` | `planning.configure/mapping/confirm/reconcile/purpose/refund-splits` | `routes/financial-planning.ts:91–244`; B:318/338/339/343–347. Keep service capabilities and revision/hash guards; whole mapping replacement refuses >100 existing rules rather than losing them. This audit did not establish live usability of legacy execution flows. |
| Statistics windows/category share/trends/range | `stats.query`, `stats.monthly` | Read-only domain | `routes/stats.ts:78/105/148/169/174/180`; B:303; R:517. Gross expenses/refund income remain authoritative; typed chart/filter/drilldown cards are still missing in chat. |
| Item catalogue, summary, purchase/sale links and lifecycle | `items.read` | `item.create/update/sell/retire/delete` | `routes/items.ts:40/47/54/61/68/75/84/93`; B:290–295. Existing tool coverage does not include item-photo bytes or cutout lifecycle. |
| Deterministic category/tag structural organization | `organization.preview` | `organization.apply/undo` | `routes/ai.ts:108/113/118`; R:536/856/882. Generic read-card rendering is not an interactive action-ID picker for this organization type. |
| Historical bill organization, task progress, paged suggestions and evidence | `spending.preview/status/card/evidence/resume` | `spending.apply/undo` | `routes/ai.ts:124/129/136/145/154/163`; B:422–453. iOS has dedicated run/suggestion selection; its next-page/apply controls currently build text for the composer, not typed server-owned continuation. |
| Monthly evaluation and transaction draft | `monthly.evaluate`; normal `transaction.create` preview supersedes direct free-form draft for conversational entry | Draft/confirm only | `routes/ai.ts:94/103`; R:529/548. `monthly.evaluate` has no date argument: it is not a daily-review capability. |
| Backup list/create and CSV export discovery | `backups.list`, `backup.export-links` | `backup.create` | `routes/portability.ts:71/80/89/98/251/256`; R:540/544/792. Export tool returns relative URLs only; current generic Swift value view shows text, not authenticated download/share actions. Backup API exposes names/create, no backup download route. |
| Single-file WeChat/Alipay import | Attachment flow and `platform-import.prepare`; preview/reanalysis/duplicates APIs | Existing durable import card with original-file SHA/size and 1–100 explicitly selected rows | `routes/portability.ts:148`; `routes/assistant.ts:461/503/512/542`; R:801; `AssistantAttachments.swift:5/48/84`. Existing iOS single-file CSV/XLSX flow is real; it does not cover generic ledger CSV imports or multi-file merged workspace. |

Route anchors in the table are relative to `packages/server/src/`. Ranges identify
the group, while the first line after the colon is a concrete lookup anchor.

## Actual capability gaps and safe invocation routes

| Capability not currently provided as a complete conversational function | Existing endpoint/native evidence | Required product behavior / boundary |
| --- | --- | --- |
| Native navigation to all business workspaces, with selected IDs/query scope | `UI:400–430` only special-cases spending results; `MyView.swift:26–67` has fixed navigation | Add a typed server-owned capability/action registry and client router. Existing result data must yield validated detail/select/edit actions; do not make model-supplied arbitrary URLs executable. |
| Password change, logout/server or account switch | `routes/auth.ts:85/97/129/160/170`; `MyView.swift:73`; login/session code owns credentials | Use trusted native forms/actions. Passwords, cookies and alternate account credentials never enter model arguments/history. Logging out or switching must clear old workflow ownership and notifications. Password-change UI is currently absent from My. |
| Invitation administration | `routes/invitations.ts:10/13/30`; `routes/auth.ts:73`; `MyView.swift:31`, `InvitationManagementView.swift` | Provide an admin-capability-aware native action card/route. Reuse existing form/list/create/revoke UI; never infer admin authority from a prompt. One-time invitation plaintext stays only in the dedicated native presentation. |
| AI connection configuration, model discovery/manual choice and connection test | `routes/ai.ts:72/77/82/88`; `MyView.swift:26`; `ProviderSettingsStore.swift:89/109` | Reuse dedicated settings view with secret preservation. A conversational action may open it or propose non-secret edits for review, but the model must not receive the stored key or arbitrary provider/network authority. |
| Transactions CSV and transfers CSV import | `routes/portability.ts:108/122` accept raw CSV; iOS `AssistantBillFile` restricts files to platform CSV/XLSX (`AssistantAttachments.swift:13`) | Add trusted file-picker/review/confirm flow for each supported import format. Do not feed raw file text into the model or call a direct import mutation before explicit review consent. |
| Multi-file merged platform import and detailed conflict decisions | `routes/import-batches.ts:169/199/211/228/246/255/281/299/322/344/362`; `UI:426` displays importBatch metadata only | Native workspace is missing: upload several files, live-view rows, duplicate comparison, staged categories, review revision, replace/remove/reanalysis and explicit atomic confirmation. These are existing backend capabilities, not missing generic business tools. |
| Authenticated export/download/share | Four CSV download routes at `routes/portability.ts:71/80/89/98`; R:544; A:78 | Add a trusted same-origin authenticated file transport/share sheet and allowlisted export-kind card. Neither generic JSON decoding nor rendering a URL string downloads a file. |
| Item photo display, upload/change/remove | `routes/items.ts:102/121/135`; `LedgerItemsView.swift:104` explicitly says preview is deferred | Add secure native photo picker/preview/apply action (bytes stay outside prompt). Reusing `item.update` does not cover image operations. |
| Cutout upload/job progress/cancel/candidate preview/candidate image/apply | `routes/item-cutouts.ts:36/63/72/82/102` | Needs dedicated native job and candidate-selection flow; then photo upload of the chosen result. No existing model adapter covers this. Worker-enabled/unavailable states must come from actual API status. |
| Daily review generation/history and scheduled review/recording reminders | No `UserNotifications`, remote registration, reminder scheduler or daily-review symbol found in current iOS/server source; R:529 only current-month evaluation | New capability. Reuse authoritative daily/query/statistics facts; do not relabel a monthly report as daily. Schedule/account/time-zone/push behavior is a separate product and platform decision owned by parent research. |
| Backup restore | `routes/portability.ts:28` documents why no HTTP restore exists; only list/create routes at 251/256 | This is an offline operator process requiring stopped writers. Do not promise an in-chat live restore through existing API. A truthful operator instruction/export card is possible; adding online restore would be a separate system capability and risk decision. |
| Retired allocation templates and legacy salary module-allocation compatibility | `routes/budget.ts:146/163/181–189`; T:67; B:297; `salary-service.ts:577` | Templates return 410; historical template names only decode prior conversations. The old allocation-replacement HTTP route still delegates to the legacy service, which rejects funded canonical salaries and can retain historical compatibility for older ones. The current assistant deliberately excludes module-allocation arguments in favour of canonical four-purpose funds; do not silently revive that product surface to meet an ambiguous "all" claim. |

## Composed-workflow gaps versus another tool list

1. **Selection is mostly prose, not a durable domain selection.** Current clarification
   is a server-owned single question/options flow (`UI:441`), but a generic result only
   opens nested JSON (`UI:419`). Add typed selection of actual returned bill/account/
   category/tag/source IDs and query/revision identity, with explicit pagination and
   human-readable names. Never interpret a displayed row index as a stable business ID.
2. **One write stops the model turn.** `assistant-generation-runner.ts:518` prepares
   a single write then returns. `AssistantStore.swift:319–339` confirms and refreshes
   history; it does not resume a server-owned workflow to verify results or continue
   a declared multi-step task. A harness needs persisted status/next-step, pause for
   approval and continuation against the same confirmed action identity. New actions
   outside the displayed consent scope need their own review.
3. **Existing cards are generic data, not editable field plans.** A:131–168 reviews
   values/full preview, with specialized import row editing only. Typical examples
   requiring real workflows are: find matching bills -> choose -> propose changed
   category/tag/account/date/amount -> show before/after -> confirm -> reread/result.
   Do not let a model bypass this by calling the original mutation endpoint directly.
4. **Long tasks need durable facts rather than unlimited steps.** Current bounded
   eight-decision/180-second policy and background run handoff are intentional. The
   context service retains 20 recent messages (`assistant-conversation-service.ts:25/384`),
   with structured result facts retained (`:172`); a new multi-turn task must persist
   selected IDs/query coverage/confirmed action references separately rather than
   silently relying on old chat text still being in the prompt. Keep size/cursor/UTF-8
   bounds and cancellation/replay semantics.
5. **Execution trace is useful but is not a workflow engine.** The newly pulled
   `AssistantTraceView` and `assistant-trace-service.ts` store/display step metadata.
   They do not own capability routing, human consent or safe continuation state.
   Preserve metadata-only trace; no internal chain-of-thought or credentials.
6. **Empty or generic availability screens must not count as implementation.**
   `MyView.swift:62–67` still labels import/export/backup as future; its footer says
   edits use the old client even though many assistant mutation adapters exist.
   The new capability inventory and native router should make these statuses truthful.

## Verification implications for the parent plan

- Track each active route/user capability as one of: typed conversational read/write,
  trusted native action/workspace, offline operator flow, or retired feature. Only call
  coverage complete when its actual route and client affordance have evidence.
- Test realistic composed requests through actual generation routes, not only registry
  invocation: read/select/edit/confirm/resume, multi-page selection, stale and cancelled
  scopes, wrong account/actor and repeated confirmation. Add representative per-domain
  tests and ensure every registration has a functional read or prepare/confirm contract.
- Consent must cover non-ledger changes too: reminder preferences, provider/settings,
  invitation creation/revocation, item-photo application, imports and destructive purge.
- Persisted capability/selection/card versions require backwards-compatible decoding;
  Android shared API changes must update stable inventory IDs while Android source stays
  out of the iOS implementation scope.

Android contract evidence read for this audit: `clients/android/README.md:589`,
`:642–694`, `:704`, `:717–737`, `:886`, `:940`. These explicitly distinguish server
tool availability from Android generic card and complex-workspace gaps. No Android
inventory/global dates or code were changed by this research.
