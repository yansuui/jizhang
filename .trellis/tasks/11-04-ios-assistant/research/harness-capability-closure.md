# Active capability closure — conversational iOS workspace

## Scope and evidence status

This closes the route-family inventory in `harness-capability-audit.md` against the
implemented workspace, rather than treating the executable catalog as acceptance.
Backend source is `d32b0442e63fe05972bdf116f4e6eab9435c3520`, including the H5
native-completion follow-up below.
Native source is the
corresponding main-line workspace implementation plus the root-owned presentation fixes
under final verification. This audit changes this document only.

The catalog now contains92 tools:88 retained domain tools and four additions. That
number is discovery metadata, not proof that92 natural-language conversations were run.
Coverage below relies on actual adapters, trusted native routes, effect previews,
confirmation/continuation handlers and relevant tests.

Root reports the final local repository build/lint/typecheck gate and **405 shared +1380
server tests in69 suites** passing after the H5 follow-up. Logs are under
`clients/ios/build/harness-quality/final-{build,lint,typecheck,test}.log`.
The focused39 workspace +26 DB cases also passed. Final exact-source run42229314232
passed all four backend/Android/container/cutout jobs;
final native run42233753337 atb5d9013 passed214 XCTest cases with0failures and Release
device packaging. Root's `../harness-verification.md` owns the exact screenshots and
IPA provenance. Native test names below identify the source behind that automation;
they do not establish real-provider or physical-device acceptance.
No live provider, production deployment, signed installation or physical notification
delivery was performed for this closure audit.

## Shared implementation and proof references

All server paths below are relative to `packages/server/src/` and all native feature
paths are relative to `clients/ios/Jizhang/`. Test paths are relative to the repository.

- **W** — `services/assistant-workspace-service.ts:44` typed answer, `:86` draft schema,
  `:94` immutable replacement, `:155` confirmed continuation, `:188` original-query paging,
  `:205` historical card reads, `:210` selected organization preparation. Actual endpoint
  registration is `routes/assistant-workspace.ts:28–50`.
- **S** — `services/assistant-workspace-store.ts`: private task/selection history, actual
  candidate readers, snapshot/expiry state and lifecycle reconciliation. The resource
  types are account/category/tag/transaction/salary/date-range/item/recurring/
  recurring-occurrence/goal/fund-source/transfer/trash.
- **B** — `services/assistant-business-tools.ts`; **R** —
  `services/assistant-tool-registry.ts`. These call existing tenant/actor-owned services,
  rather than invoking model-selected URLs or implementing a second financial engine.
- **UI** — `Features/Assistant/AssistantWorkspaceViews.swift:98` renders typed results,
  selections, background tasks, organization choices and native actions;
  `AssistantWorkspaceModels.swift:51` owns selection paging/frozen submission.
  `AssistantDraftRevisionView.swift:3` loads editable schema/full frozen arguments;
  `AssistantStore.swift:435/442/476/506` owns revise/prepare/continue/confirm.
- **P** — `packages/server/test/assistant-workspace-routes.test.ts`:39 composed route
  tests. In particular: paged account/category ->28-to35 replacement -> original-card
  rejection -> exact-once confirm/continuation; seven additional resource kinds;
  a10,002-record filtered scope; same-kind transfer choices; date-selected refunds;
  eight revised mutation families and a second write requiring a new approval;
  structural selected preparation; daily205-salary totals/read-only continuations;
  canonical replay, CSV receipt identity, trace privacy and restart/archive/cancel.
- **D** — `packages/server/test/assistant-business-tools.test.ts`:19 real-service
  confirmation cases, including canonical funds/salary, plans/goals, recurring, items,
  tags/transfers/trash, legacy execution/refunds, source-hash review, both organization
  domains, undo and cross-ledger/stale-preview rejection.
- **Q** — `packages/server/test/assistant-tool-reliability.test.ts`:50 populated read
  cases; `assistant-stream-routes.test.ts`:53 real generation/SSE/provider-loop cases.
  These cover complete scopes, projection, cursors, deadline/cancel/replay and original
  financial/import guards; they do not establish a real provider's tool-selection quality.
- **N** — native test source `clients/ios/JizhangTests/AssistantWorkspaceTests.swift`:
  authoritative IDs across pages, uncertain/frozen choices, foreign owner rejection,
  exact-cents revisions, replacement cards, deterministic organization, daily outbox,
  continuation identity and bounded read-only live trace.
- **F** — native test source `clients/ios/JizhangTests/NativeWorkspaceTests.swift`:
  enum/origin/ownership validation, binary transport, original CSV/frozen confirm,
  per-conversation import sessions, selected merged rows, export cleanup, transparent
  photo staging and late-read/cutout-cancel fences.
- **M** — native test source `clients/ios/JizhangTests/DailyReminderTests.swift`:17
  reminder/outbox cases covering actual scheduling state, permission, independent edits,
  logout/replacement, cold/foreign/duplicate/cross-day taps, persisted requests and storage
  failure. `NativePresentationGateTests.swift` adds10 gate/receipt-relay cases; the final
  serial handoff regressions are in AssistantWorkspaceTests.

The shared confirmation boundary is still `/assistant/actions/:id/confirm`; new
selection/revision/continuation routes cannot silently confirm. Only the human-reviewed
action executes. A later write emits another pending card. New-client negotiation is
checked at both catalog and execution boundaries; old requests retain their v1 behavior.

## Active business route-family matrix

“Implemented” means the callable source path exists and the specified automated layer
has evidence. Every row still needs the relevant real-provider/signed-device interaction
when reporting production/device acceptance; the final native automated gate passed.

| ID / active family from the source audit | Actual conversational/native implementation | Concrete proof and remaining acceptance |
| --- | --- | --- |
| C01 Bills, income, expense, linked refunds; `/transactions`, details, daily summary | B:195/197/212 plus R create/update/delete/restore. S selects actual bills/account/category/date scope; UI renders resource choices and review. W revises/continues the same action. Existing entry/detail sheets remain available. | P:87 paged28-to35 workflow; P:281 date-selected linked refund; P:267 filtered10,002-bill scope. D:74 preserves income refunds/gross expense. N exact cents/ownership/replacement; signed entry, refund selection and live-model intent verification pending. |
| C02 Accounts, balances, usage and order | `accounts.balances`, `master-data.read`, account CRUD and `master-data.move`; B:213/224, R account adapters. Actual account IDs support selections, not display indices. | P account paging/search and account.create revision/approval; D/Q account/cross-ledger/read coverage. Native source uses the shared selection/review path; live selection and reorder acceptance pending. |
| C03 Category hierarchy, usage and order | Same master-data reads; category CRUD/move; category choices show actual parent names so equal child labels remain distinguishable. | B:213/224; S category reader; P category selection/category.create; D structural merge and stale guards; Q category reads. Signed hierarchy/large-choice interaction pending. |
| C04 Hierarchical tags and legacy tag names | B:226–228 tag create/update/remove plus R tag rename/delete, through actual ID/name contracts. Readable choices and generic revision use the corresponding service. | P tag.create revision; D:215 tag lifecycle and transaction tag semantics; Q hierarchy/name reads. Removal of a node and removal of a bill tag remain distinct actions; live wording/device review pending. |
| C05 Account transfers | B:229–231 and R transfer.create. S supplies actual transfers or sequential from/to accounts; ordered workflow history retains both account choices. | P:320 two same-kind account choices; P additional transfer selection; D:215 confirmed update/delete. Transfer remains outside ordinary income/expense; signed transfer workflow pending. |
| C06 Trash, single/all restore and permanent deletion | B:232–235 plus R transaction.restore. S trash selection; approval cards explicitly name permanent/all scope. | D:215 restore/purge actual counts; D:241 stale/foreign guards; P trash selection and shared repeated-confirm protection. Device destructive-scope review pending; no general future approval is inherited. |
| C07 Recurring rules, occurrences and pending bills | B:239–248 plus R occurrence confirm/ignore. S separately selects rules and pending occurrences. Generate prepares pending occurrences; confirming one books money once. | D:117 create/update/generate/confirm; D:177 day-boundary rejection; P recurring/occurrence choices and rule revision. Native/model flow pending; no generation-on-read behavior was introduced. |
| C08 Four-purpose config, balances, issues and source review | B:250/253/254. S fund-source choices retain current source hashes and grant facts; existing Plan editing/review surfaces are retained. | D:89 canonical ratios and frozen salary grants; D:206 unclaimed source review; P revised funds.configure and actual source choice. Source/revision conflicts remain authoritative; physical ratio/source review pending. |
| C09 Salary/allocated-income records | B:255/258/260/262. Distinct salary/fund-source selectors and existing salary/Plan history; ordinary income remains a separate tool. | D:89 canonical create/update/delete with no new legacy allocations; Q full salary pages; P complete daily salary window. Device confirmation and model distinction between ordinary/allocated income pending. |
| C10 Independent/monthly plans | B:266–268 and monthly view of planning.read. Editable schema/full arguments produce a replacement preview; saving does not book money. | P plan.save revise/confirm/next-write pause; D:103 plan and manual-goal invariants; prior PlanEditingTests source. Signed plan editor/provider workflow pending. |
| C11 Manual reserve/investment progress | B:270/275/277–279, S goal choices using the domain cursor internally. Opening/entry edits retain operation/revision identity. | D:103 create/update/delete/negative-history rules; P real goal choices and revised opening; Q cursor coverage. It remains distinct from transaction balances; physical goal-history acceptance pending. |
| C12 Budget overview, budget periods, cycle start | `budget.overview`, B:294/295 settings read/cycle. Existing service totals and periods feed the shared result/review path. | D/Q real budget/settings reads and shared action guards; native generic field/schema source. Cycle changes are reviewed writes, not a new budgeting engine; live-provider/device acceptance pending. |
| C13 Existing execution configuration, mappings, sources, periods/revisions/facts, purpose/refund splits and operation lookup | B:312–341 explicit planning views/previews/writes, preserving original capabilities/revisions/source hashes. Oversized whole mapping replacement is refused rather than dropping unseen rules. | D:190 actual source/preview/confirm/refund-split contracts; D:177 purpose CAS; Q read variants. This retains compatibility behavior and does not revive removed template/module product UI; physical legacy-history review pending. |
| C14 Statistics windows, category share, trends and available range | B:297 stats.query and R stats.monthly; UI readable rows/summary coverage, original scoped result pagination when supported, existing native statistics page. | D:140 query/date/statistics scope; Q month/default/gross/refund behavior. Server totals own all arithmetic; no claim of a newly implemented chart engine. Live/device date/filter/drilldown acceptance pending. |
| C15 Item catalogue, summary, purchase/sale links and lifecycle | B:284–289; S item selection; editable new/updated item previews. Photo/cutout are handled by C23/C24 rather than putting image bytes in a tool argument. | D:130 lifecycle without auto-booking money; P item choices/revision/approval; F image-related state. Physical lifecycle and linked-bill review pending. |
| C16 Deterministic structural category/tag organization | R organization.preview/apply/undo; `assistant-organization-page.ts` and W:188/210 direct paging/selected prepare preserve full preview hash and link the original task. UI `AssistantOrganizationCard` selects actual action IDs. | P:333 pages40 duplicate-name groups, prepares two explicit actions with no model call, confirms exactly those two and continues original request; D:400 legacy stored args/undo. Physical multi-page selection and conflict/undo acceptance pending. |
| C17 Historical bill organization, progress, evidence and undo | B:416–447; W:205 ready card and W:210 selected prepare. Existing bounded run observer remains; no composer JSON bridge is needed. Action selection persists across card pages and excludes note-only suggestions. | D:296 apply explicit choices/conditional undo; D:316 background handoff; D:384 evidence over100 categories; P/N typed preparation and callback ownership; AssistantSpendingRunTests source. Real provider batching/weak network/device recovery pending. |
| C18 Monthly evaluation and conversational transaction draft | R monthly.evaluate; transaction.create preview provides the conversational equivalent of direct transaction-draft behavior. Daily review is distinct (C25), not a renamed monthly report. | Existing assistant/domain/provider tests and Q generation loop; N/AssistantStateTests preview/confirm sources. Actual provider report quality, evidence comprehension and device flow pending. |
| C19 Backup listing/creation and export discovery | R backups.list/backup.create plus existing confirm; native `NativeBackupView` lists actual filenames and explicitly confirms POST/backups. Export completion uses C22, not merely the old export-links text result. | Actual prepare/confirm service path, authenticated portability routes and container backup lifecycle; NativeWorkspaceView.swift:87/112/122 source. Native backup button has source/transport/backend evidence, not a dedicated new native end-to-end UI test. Device/file existence acceptance pending. |
| C20 Existing single-file platform import | Original attachment/digest/selection flow retained in AssistantAttachments/Actions/Store; new platform-import action also reaches the fuller C21 workspace. | AssistantStateTests original-file, explicit eligible rows and frozen retry cases; D/Q existing import guards; server import suites in the1380-test gate. Real export samples and signed file-picker interaction pending. |

## Protected and newly completed native capability matrix

| ID / capability | Actual native/conversation route | Proof and remaining acceptance |
| --- | --- | --- |
| C21 Multi-file platform import, live rows and conflicts | `workspace.open(destination=platform-import)` or an importBatch result enters `NativeBatchImportView`. NativeBatchImportStore:42/59 creates or resumes the owning batch; :110/140 pages rows; :145/163/175 records explicit selection/category/note edits; :200 reviews; :221 confirms frozen originals; :239 analyses only explicitly; :252 compares duplicates; :257/275 replaces/removes with frozen mutation IDs; :297 cancels. | F testMergedBatchUsesExplicitSelectionAndFrozenOriginalsAfterUncertainConfirm and session-owner tests; existing server batch/review/identity/regression suites. Source includes actual staged categories/conflict review and original reattachment after reopen, not a placeholder. Signed multi-file chooser and real export conflict review pending. |
| C22 Generic transactions/transfers CSV review, authenticated exports/share | `workspace.open(data-import/data-export)`; NativeCSVImportStore.prepare/confirm calls new native-only server preview/receipt routes; NativeExportStore.download allowlists four actual CSV types and uses APIClient.binary plus ShareLink. My also has direct entries. | P:397 importer rollback/file digest/once-only confirm; F CSV uncertainty, origin/size/CSRF and export-close cleanup; server portability tests. NativeCSVImportView displays counts/coverage before consent. Real file encoding/Share sheet/device retention behavior pending. The old backup.export-links alone is explicitly not closure proof. |
| C23 Item photo view/pick/compress/save/remove | `workspace.open(item-photo,itemId)` or real item chooser -> NativeItemPhotoView/Store. `stage` prepares local data; `load` GETs actual photo; save PUT and remove DELETE occur only through explicit native consent. | F transparency/no-upload-before-save and stale missing-photo read fences; server item photo route tests. PhotosPicker/file permissions, compression/orientation and signed-device appearance pending. |
| C24 Cutout create/status/cancel/candidate preview/image/apply | `workspace.open(item-cutout,itemId)` -> same owned photo workspace. NativeItemPhotoStore:105/118/132/140/151 calls the real worker proxy; candidate image becomes a local draft and still needs confirmed save. Root added bounded PNG/JPEG/WebP input support for the native encoder and worker signature validation. | F stale-ready/cancel fence; packages/server/test/item-cutouts.test.ts:148–354 and Python worker MIME/bounds tests. Disabled/failed/empty worker states differ from valid candidates. Real inference service and physical candidate preview/application pending. |
| C25 Daily review and two local reminders | `workspace.open(reminders)` and My -> DailyReminderSettingsView. DailyReminderStore/NativeNotificationDelegate schedule independent20:00 recording/21:00 review clocks and route owner-matching taps; recording enters the existing sheet; review persists one outbox then starts `/workspace/daily-review` for the delivery day in Asia/Shanghai. | P:185 complete205-salary/gross/refund facts, P:216 read-only selection/clarification continuations; M16 permission/schedule/ownership/outbox cases; N daily launch/checkpoint/no-start-on-reopen tests. Local notifications are not APNs and never authorize an unattended daily model call. Root presentation-gate fixes and final native tests remain pending here; actual OS delivery/login/cold tap require signed-device checks. |
| C26 Password change | `workspace.open(password)` -> NativePasswordView:42/69. Secure fields send currentPassword/newPassword only to /auth/password; successful reauthentication response clears/invalidate session and returns to login. No secret goes to chat. | Exact form/API field matching checked against routes/auth.ts:169; existing server auth/session/password tests and CoreAPIClient contract sources. Native form source/compile and shared transport evidence exist; no new dedicated password-button UI test is claimed. Signed password-change/reauthentication acceptance pending. |
| C27 Provider configuration, model choice/discovery/test | `workspace.open(provider-settings)` reuses ProviderSettingsView/Store, saved-secret/hidden-field preservation and explicit save/discovery/test controls. | ProviderSettingsTests and AssistantStateTests bootstrap/discovery failure sources; server provider/config tests. Saved/tested status is distinct; physical keyboard/secret preservation and a real provider test remain separate. |
| C28 Invitation administration | `workspace.open(invitations)` is marked requiresCapability=manageInvitations. NativeWorkspaceView:18 checks actual authenticated user before reusing InvitationManagementView; backend invitation routes retain authoritative admin enforcement. | MultiuserContractTests creation/revoke/expiry/member/403 sources plus existing server identity/invitation/isolation suites. Invitation plaintext stays in its dedicated view. Physical copy/revoke workflow pending. |
| C29 Logout, server/account switch and native ownership | Enum-only native routes -> explicit logout/switch confirmation in NativeWorkspaceView:30; app session replacement invalidates old API ownership and clears native import/photo sessions and reminder schedules. No model URL/account credential switching. | NativeWorkspaceTests route/owner/session cases; CoreAPIClient/Multiuser/AssistantStateTests ownership sources; M replacement/logout/cold-tap cases. Root native presentation queue retains deferred intents rather than assuming a fixed delay. Final queue tests and signed sheet/logout/login transitions pending. |

## H1/A1 closure assessment and boundaries

The individual active route families have implemented conversational/native entry paths.
The audit found an **H5 native-outcome continuation gap**, then implementation added
`POST /conversations/:cid/workspace/native-completions`. The endpoint validates the
originating `workspace.open` message, conversation, destination/item and completed source
generation before binding a verified receipt back to that original workflow. CSV and
batch receipts must be confirmed at or after the source message. Photo viewed/saved
references verify the exact current SHA256; removal verifies current absence, with no
inferred client causation. Export re-reads the actual allowlisted CSV and claims only
server generation, never device save or OS Share completion.

Ordinary ledger edits intentionally share the tested
typed selection/revision/approval engine; they do not all require separate standalone
native editors. Credential/image/file functions intentionally use real trusted native
forms/workspaces, reachable from dialogue or the capability launcher. Actual writes
continue to use the original service's permission/revision/operation checks.

Nine new real-route cases in P cover CSV import then ledger query/summary, reordered-key
and duplicate-request replay, missing/old/null receipts, foreign source/conversation,
wrong native destination/item, changed photo, actual merged review/confirm, photo viewing,
all four exports, subsequent new approval and inherited daily read-only authority.
A forced receipt INSERT failure verifies atomic rollback of outcome message, workflow
facts and continuation generation. The source/reference receipt dedupe and canonical
request IDs persist exactly one continuation even after reopening. Additive migration025
preserves old CSV confirmation results without inventing timestamps. Dedicated native
collector/App dismissal/client-adoption integration and final native tests are root-owned;
the automated214-case gate passed, with signed-device behavior still separate.
Password/logout/server-switch do not continue an
invalidated authentication scope; no client prose/secrets/file bytes are accepted as proof.

This is a **source/automated-layer closure**, not a blanket physical/live-provider pass.
The final native gate, rendered selection/organization/reminder/native-workspace images,
presentation-owner tests, source/checksum-verified device IPA and final CI totals remain
root-owned final acceptance entries. A successful app compilation alone does not close
those checks. The new runtime routes and the matching iOS app must both be deployed/installed
before the full feature set can be used; this document is not deployment evidence.

Explicit accepted boundaries are retained, not marked as missing active implementation:

- **Backup restore/download:** existing service exposes backup list/create only. Live
  restore remains a stopped-server operator operation; NativeBackupView says so. No
  workspace/native URL pretends to restore a running ledger or download a nonexistent
  backup endpoint. The four actual CSV exports are implemented separately.
- **Retired templates/legacy module UI:** template writes return410 and historical tool
  names decode old history without executable registration. Older salary-allocation
  compatibility remains bounded by the original service; canonical funded income uses
  the current four-purpose contract. This continuation does not revive removed surfaces.
- **System administration and inference:** no generic SQL, shell, HTTP endpoint, credential
  access, paid unattended review job, APNs deployment or identity escalation is added.
- **Android:** existing v1 clients retain behavior; shared API catalog/contract inventory
  is maintained separately. Native workspace/reminder UI implementation targets iOS.

Root may append final run IDs, native test results, screenshots, IPA metadata and physical
verification to the final verification record without changing this route-family mapping.
