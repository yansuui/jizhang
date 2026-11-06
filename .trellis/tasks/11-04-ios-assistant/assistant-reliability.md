# Assistant workflow reliability — 2026-11-06

The user reports frequent unfinished replies and that nearly all capabilities except
record creation are unusable. The screenshot shows a historical-organization request,
the model announcing background analysis and querying progress, then a failed terminal.
Continue on original repository/main; no branch/fork and no production data changes.

## Boundary and investigation

- Reproduce through the actual conversation/generation -> provider envelope -> tool ->
  persisted result/card -> native state path, not isolated registry calls alone.
- Investigate step/deadline limits, unnecessary model polling, expensive/background tool
  handoff, schema and result normalization, capability discovery and multi-step query/write
  preparation. Exercise reads, plans, refunds and both organization workflows.
- Bound work by deterministic handoff for background jobs rather than raising limits or
  removing cancellation/safety. A valid background start/status must finish the chat turn
  with a visible resumable job, not spend inference steps querying unchanged progress.
- Improve truthful client status/errors where needed; an operational background job is not
  a failed answer. Keep meaningful causes distinguishable without disclosing secrets.
- Preserve tenant/actor ownership, history and immutable request/action identity, explicit
  write confirmation, cancellation/deadline behavior and no automatic inference retries.
- Expected code boundary: generation runner/orchestrator/provider prompt and narrow tool
  adapters as evidence requires; iOS assistant state/result rendering; integration tests
  and maintained client/spec documentation. No unrelated UI or financial math changes.

## Verification

Add actual streamed/buffered scripted-provider conversation regressions for the screenshot
and several non-create business flows. Use isolated databases and synthetic providers;
prove previews are read-only and background status polling does not invoke more inference.
Run applicable repository checks and native CI if Swift changes, then commit/push main
and prepare a verified IPA when required. Live-provider/server deployment and phone
installation remain distinct evidence, not claims inferred from mocks.
