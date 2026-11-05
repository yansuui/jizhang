# Independent assistant business review — 2026-11-05

Reviewer: `ios_bills_completion`, requested by the root agent after Bills delivery.
Scope: read-only review of `assistant-business-tools.ts`, tool registry/orchestrator/
types diffs, and directly implicated service/lifecycle boundaries. The reviewer did
not edit server implementations or tests. Findings were sent to both the root and
`assistant_business_completion`, which implemented the fixes below.

Reproductions/rechecks used temporary **in-memory SQLite** databases with current
TypeScript loaded by Node 22 + tsx. Provider transport was a throwing stub; no live
ledger, server or external provider was contacted. No on-disk database was created.
Full lint/typecheck/Vitest/build and tenant HTTP integration remain the root's gate.

## Findings and resolution

| ID | Defect and concrete reproduction | Relevant current source | Notification / recheck |
| --- | --- | --- | --- |
| R1 | `transaction.update` accepted `changes:{fundPurpose:"growth"}` and prepared a usable card, but confirmation failed because the domain writer requires operation UUID, canonical purpose revision and transaction token. The old preview used `prepareUpdate`, which never exercised those write guards. | `assistant-tool-registry.ts:599–612` | Notified both agents. Worker now generates/freezes omitted server guards and executes the real writer inside rollback for validation. Independent runtime recheck: three guard fields present, serialized DB unchanged after preview, confirmation changed purpose to growth successfully. **Verified fixed.** |
| R2 | `planning.purpose` advertised growth/reserve on legacy `financialPurpose`, while `putBillPurpose` only permits essentials/joy/null. Those advertised calls necessarily failed. | `assistant-business-tools.ts:284`; `financial-planning-refunds.ts:1292` | Notified both agents. Enum now matches the legacy contract; canonical four-purpose changes remain available through transaction update. Independently re-read runtime tool definition: `["essentials","joy",null]`. **Verified fixed.** |
| R3 | First construction of Spending service inside rollback set the static initialized-work map, but its interrupted-run recovery/expired-checkpoint DB changes rolled back. Future constructors then skipped recovery because the process-level marker remained. A first `spending.undo` preview—even one failing for an unknown operation—could strand previously running work. | `assistant-business-tools.ts:135–140`; `ai-spending-organization-service.ts:366–380` | Notified both agents. Worker initializes shared Spending ownership before entering simulation. Independent runtime recheck seeded a persisted running analysis, attempted invalid undo preview, and observed its recovery status **failed** remaining outside rollback. **Verified fixed.** |
| R4 | New read tools silently lost records: with 206 accounts, 205 salaries and 205 recurring rules, `master-data.read` returned 200, `salaries.read` 100, `recurring.rules` 200, with no total/continuation metadata. Array normalization silently sliced the first/third; salary imposed a limit. | `assistant-business-tools.ts:163–168,189–193,205–207`; original `normalizeAssistantJson` array cap | Reproduced in memory and notified both agents. Worker added explicit paging and totals, including underlying salary offset support. Independent recheck at offset 200 returned **6 / 5 / 5** records respectively, totals **206 / 205 / 205**, correct offset and `hasMore:false`. **Verified fixed for reproduced endpoints.** |
| R5 | A permanent `closedDbs` WeakSet broke owner-ledger reuse: LRU eviction drains services but intentionally retains the owner's DB handle; a later context reuses that handle, yet Spending constructors/analysis remained permanently closed (503) until process restart. | `ai-spending-organization-service.ts:358–415`; `tenancy/context.ts:45–49,92–109`; assistant route shutdown hook | Notified both agents. Worker now retires/drains a work-generation map and removes it from the DB map after draining; old service generations remain fenced. Independent recheck closed a service, constructed another over the same DB, and its startAnalysis returned normally rather than the shutdown rejection. Full LRU HTTP test remains part of root/worker suite. **Verified fixed at service boundary; integration gate pending.** |
| R6 | `recurring.generate` preview was not bound to its time scope. Reproduction: daily rule, day D preview `{created:1}`, advance injected clock by one day, refreshed preview `{created:2}` with the **same fingerprint**, then old-card confirmation created 2 records. The database/argument fingerprint omitted the clock-derived generation boundary. | `assistant-business-tools.ts:96–100,198`; `assistant-orchestrator.ts:308`; confirmation adapter fingerprint check | Reproduced in memory and notified both agents. Worker adds the server calendar day only for this tool's fingerprint, at both prepare and commit. Independent recheck: cross-day fingerprints differ and old confirmation raises `ASSISTANT_ACTION_STALE`. **Verified fixed.** |
| R7 | Spending suggestion pagination still copied the unbounded `evidenceByCategory` object. A valid ready analysis covering 101 categories (within the 500-bill scope) caused even `spending.card(limit:1)` to fail with “助手结果字段过多” due to the 100-key JSON bound. | `assistant-business-tools.ts:289–310` | Reproduced in memory and notified worker/root. Worker replaces the card's full evidence map with explicit count/tool continuation and adds paged evidence retrieval. Independent recheck with 101 evidence keys and limit 1 returned the card, `evidenceCategoryCount` and `evidenceTool` normally. **Verified fixed.** |

## Other inspected boundaries

- The added business adapters use an explicit fixed registry; they do not accept
  arbitrary URLs, SQL, service names, credentials or signing actions from the model.
- Reviewed registered synchronous write paths did not introduce filesystem/provider
  actions inside the rollback simulation. The nontransactional Spending initialization
  issue is covered by R3. `spending.preview` is separately an analysis operation that
  may call the configured provider; it is not represented as a ledger write.
- Actor-aware financial/goal/item services receive the context actor; route service
  graphs remain tied to private tenant DBs. Operation lookup is actor-scoped. No new
  cross-tenant disclosure was found in these reviewed paths.
- Ordinary expense/refund semantics still use existing domain services: refund is
  income and gross expense remains unchanged. Canonical four-purpose grants continue
  to use server revisions and idempotent operation IDs, independently of ordinary
  transaction accounting.
- The business fingerprint is conservative over ledger facts and is checked inside
  confirmation's transaction. Consecutive confirmations use persisted action status
  for deduplication. The clock-sensitive exception found during review is R6.
- The concurrency-token allowlist only permits the named business hash fields when
  their value is 64 hexadecimal characters. General credential/token protection was
  not disabled by the diff.

No unaddressed blocker from these seven findings remained at the final local recheck.
This record is source/isolated-runtime evidence, not full-suite, production, iOS CI
or device acceptance evidence. Line references may shift with final integration.
