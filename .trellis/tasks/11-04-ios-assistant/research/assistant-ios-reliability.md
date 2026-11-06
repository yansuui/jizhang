# Assistant client reliability continuation — 2026-11-06

The screenshot's missing background result originates in server orchestration, not the
status view. Keep the existing `{result:{data:{run:{runId,...}}}}` handoff contract so a
durable job can be observed with GETs rather than additional model turns.

The native observer previously stopped permanently on one failed GET: clearing its error
through the refresh button did not restart `.task(id:runID)`. It now has a dedicated
API/run-owned state store, cancellable observation tickets, bounded read polling and up
to three consecutive transient failures. Manual refresh starts observation again. Known
missing/forbidden/expired-session responses stop observation; invalid owner/count payloads
cannot replace a valid snapshot. Jobs are keyed by API identity and run ID in chat.

The UI differentiates running, ready, failed and cancelled jobs. It keeps analysis distinct
from financial confirmation, disables duplicate card loads and explains expired/oversized
selections. Unknown/incomplete counts are not invented as zero.

Stream faults now distinguish fixed server-owned timeout, connection, configuration,
format and execution-bound sentences. A strict exact-sentence allowlist selects the
explanation; arbitrary provider/internal exception text still uses the generic safe hint.

Native regressions cover read-only completion, transient recovery, explicit restart,
missing and wrong-owner run responses, impossible counts, cancellation on leaving and
safe error explanations. A compact task-card fixture exports a real simulator render.
Windows source checks do not establish native compilation; CI evidence follows separately.
