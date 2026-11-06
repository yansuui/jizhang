# Assistant tool adapter audit — 2026-11-06

This is the adapter/normalization portion of `../assistant-reliability.md`. Generation
budget, background turn handoff and prompt orchestration are owned by the runner work;
the native status-card observer is owned by the iOS work. No production data or live
provider was accessed and no commits were made by this worker.

## Confirmed adapter failures

1. **Four-purpose balance lookup failed on every normal summary.** Calling the real
   `registry.read(context, 'funds.read', {view:'summary'})` against an initialized private
   ledger threw `AssistantValidationError: 助手结果包含受保护字段。` The domain's
   `FundSummaryView.snapshotToken` is an authoritative SHA-256 snapshot digest, but
   `normalizeAssistantJson`'s exact business-hash allowlist omitted that field. Added
   `snapshotToken` to the exact list; its value must still be a 64-hex string. Generic
   token/accessToken/sessionToken/apiToken, cookie and secret fields remain rejected.
2. **An explicit requested month could silently turn into a rolling window.**
   `stats.query` permits optional `kind` and `month`. `{view:'window',month:'2026-11'}`
   previously selected `last30`, ignoring the explicitly supplied month. The adapter now
   infers `month` only when kind is absent and month is supplied. Explicit `kind` remains
   authoritative. The shared/server window calculation itself is unchanged; the regression
   verifies exact Asia/Shanghai boundaries and explicit last30 priority.

## Background handoff alignment

The previous background tool result instructed the model to repeatedly query
`spending.status`, despite the three-step turn ceiling. This contributed to the reported
start -> poll -> unfinished-turn loop. In coordination with the runner worker:

- Preview/status/resume catalogue descriptions now explicitly end the current turn and
  hand the result to the client's task card; they prohibit same-turn progress polling.
- `run` and existing `nextStep` values are retained. The informational `step` for running
  work is `background`, and notes explain ongoing work without asking the model to loop.
- Public result summaries are concise human-facing running/ready/failed/cancelled statuses,
  rather than a copy of the model's full tool instructions.
- The runner must enforce this structurally; descriptions alone are not the root fix.
- An early `spending.card` request now catches the exact domain
  `AiSpendingCardNotReadyError` and returns that run's true state. No suggestions are
  invented and no provider request is started; the runner hands the run to the same card.

## Large read-result transport failure

The independent reviewer reproduced valid 200-transaction history, each note containing
4,000 Chinese characters. Two original 100-row results could overflow the replay budget,
and a single event could exceed both the native SSE 64 KiB line limit and frame limit.
Increasing protective limits would leave the native parser broken. The central
`Registry.read` boundary now projects the entire ToolResult to at most **40 KiB UTF-8 JSON**:

- Known human text fields are clearly marked summaries of at most 200 UTF-16 units.
  Per-field `noteTruncated`/`noteOriginalUnits` and Chinese result summary/notice make
  the omission visible. IDs, amounts, tags, digests, revisions and complete counts are
  never shortened. `transaction.details` preserves the main note within the existing
  4,000 UTF-16-unit protected JSON limit. Legal longer notes retain explicit
  `noteTruncated`/`noteOriginalUnits`/`noteDisplayedUnits` plus `fullNoteOmitted`,
  and both summary and notice direct the user to the native bill detail for the full text.
- Numeric-offset `items` pages may return fewer complete rows to fit, with actual
  reduced `limit`, `nextOffset`, `hasMore`, unchanged `total` and a visible page notice.
  Continuation uses actual returned rows, including the final short page. Legacy recent
  history directs continuation to `transactions.query`.
- Single-transaction refund relationships are now explicitly paged with independent
  totals/offsets/next offsets. Exact original refund-summary amounts remain unchanged;
  a refund's note is available through its own transaction ID under that same display limit.
- Opaque cursor pages are never sliced. A review caught the risk of keeping the old
  cursor after returning fewer entries; that would skip unseen entries. Oversized cursor
  or otherwise non-pageable results instead return `requiresNarrowerQuery`,
  `financialFactsOmitted`, preserved total where known, and a concrete smaller limit.
  They never pretend to be an empty or complete financial result, and must not supply
  facts for writes. A smaller cursor page keeps the domain's exact original cursor.
- This is **read-only** projection. Registry.prepare has no universal 40 KiB guard:
  legacy single-file imports need their existing JSON review entrance. The runner owns
  the separate bounded SSE confirmation-preview guard, with no action cropping.

## Verification and coverage

Added `test/assistant-tool-reliability.test.ts` with **50 passing tests**:

- **44 real read branches** across transactions/detail/daily, legacy recent/balances/budget/
  trend/pending, categories/accounts/tags and usage, funds, salaries, independent plan,
  goals, items, settings, transfers, trash, recurring, statistics and historical planning.
- Each fixture contains a real expense, canonical allocated income/frozen grant, and a
  saved independent plan in a migrated in-memory database with an immutable member actor.
- Every result is checked both as direct normalized JSON and through the actual persisted
  `normalizeAssistantContent('result', {version:1,result:{version:1,...result}})` boundary.
  Complete serialized database images remain equal before/after every read. Provider calls
  throw if unexpectedly attempted.
- One regression checks allowed summary digest and invalid/credential-token rejection;
  one checks natural-month inference and explicit-kind precedence.
- The three size regressions use real services: 200 long-note bills with twenty tags
  each, 80 linked refund records with long notes, and 120 manual goal entries. They check
  full paginated ID coverage without duplicates, exact money/tags/revisions/refund totals,
  complete 4,000-unit single-note retrieval, safe cursor fallback, exact smaller-page cursor, both
  persisted-result normalization and actual message SSE lines below 64 KiB.
- A fourth realistic note case exceeds 4,500 units and contains a unique final marker.
  It verifies the protected result is still 4,000 units, the original domain note and tail
  remain intact, and result content explicitly discloses omission with original/displayed
  lengths and native-detail direction. No global sanitizer limit was changed.

Existing business integration tests also assert the new background handoff note/step,
human-facing summary, and true early-card state while the provider remains gated.
Focused business/contracts/read runs passed **82/82**. Changed-source ESLint,
server typecheck and `git diff --check` passed.
The root owns the final integrated typecheck/full test gates, native build and deployment
evidence.

This is explicit read-branch and adapter coverage, not a claim that every write or every
real provider conversation was verified. The generation-route integration cases and
full quality gate are necessary to establish the complete user's workflow.

## Prevention

The failures are cross-layer contract and coverage gaps: valid domain DTO fields were not
exercised through the assistant's sanitizer/persisted content boundary, while direct write
tests did not establish realistic multi-step conversation viability. Keep digest exceptions
exact and shape-checked, and retain populated-domain read-to-content tests beside route-level
conversation tests. Do not resolve this by disabling secret checks or removing turn bounds.
