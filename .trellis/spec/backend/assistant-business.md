# Confirmed assistant business tools

## Scope

Applies to `assistant-tool-registry.ts`, `assistant-business-tools.ts`, the orchestrator,
provider catalogue and their native confirmation clients. Tools reuse authenticated
private-ledger services; they do not introduce model-controlled routes, SQL or service names.
The route-family inventory belongs in the task's `research/assistant-business-matrix.md`.

## Execution contract

- Read tools return authoritative service facts and explicit pagination/coverage when bounded.
  A result limit must never silently turn the first page into a claimed full account/history.
  The model must follow subsequent pages when the user's question requires complete history.
- Financial writes prepare a durable action/card and return `pending-confirmation`. The same
  authenticated human confirms through `/assistant/actions/:id/confirm`; generation completion
  or selecting a clarification is never confirmation. Cancellation changes draft metadata only.
- A persisted action ID is the idempotency identity. Repeated confirmation returns its existing
  result rather than repeating the business mutation. Status, result and assistant history commit
  atomically with the domain mutation. Expired actions must also update their history cards.
- Explicit adapters validate arguments and invoke existing domain services with the current
  tenant database and actor ID. Never resolve an invited user's actor from legacy `ledger.users`.
  Preserve existing service revision, transaction-token, operation-ID and ownership checks.
- The business snapshot fingerprint conservatively rejects a stale preview after relevant ledger
  facts change. Revalidation must cover time-dependent scope too: crossing a day boundary cannot
  expand a confirmed batch beyond the displayed preview.
- Domain preview simulation is restricted to synchronous SQLite-only writers in a rollback
  transaction. File writes, exports, backups, provider requests, background jobs and memory-only
  lifecycle mutations are not made safe by SQL rollback. Initialize/recover stateful services
  outside simulation, and prove previews leave business data unchanged.
- Assistant cancellation/deadline and private-ledger close/reopen must propagate to any analysis
  lifecycle. A recovered or reopened owner ledger must not retain a permanent closed marker.

## Financial meaning

Money is integer cents. Ordinary refunds remain linked income; expense totals remain gross.
Separate confirmed refund splits affect only the existing financial execution net view.
Four-purpose allocations use fixed purposes and exact 10000-bps ratios; configuration changes
do not rebalance previously frozen grants. Historical `financialPurpose` overrides use their
own narrower domain and must not be confused with four-purpose `fundPurpose`.

Historical spending organization and structural category/tag organization are distinct tools.
Read the actual suggested actions, require explicit nonempty selected IDs and show only the
selected effect in a write preview. Note suggestions are reference only. Conditional undo must
reject conflicting subsequent changes; it must not partially restore or silently overwrite them.
Reviewing, preparing or confirming an existing organization draft must not trigger an extra
provider inference merely to validate its fingerprint.

## Verification

Use isolated in-memory/file fixtures and actual domain services. Cover expense/income/refund,
fund configuration and income allocation, plans/goals, recurring, items/templates, filtered and
paginated reads, both organization workflows and their conditional undo. Test stale previews,
invalid arguments, replay, cross-ledger IDs, actor isolation, cancellation and lifecycle reopen.
Compare complete database snapshots with `Buffer.equals` for rollback assertions.

Run repository lint, typecheck, tests and build after integration; native confirmation clients
need their own compile/state tests. CI, live-provider interaction, production deployment and
physical installation are different evidence levels.
