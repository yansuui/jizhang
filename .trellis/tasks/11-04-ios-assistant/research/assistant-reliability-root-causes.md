# Assistant unfinished-turn root causes

This applies the Trellis break-loop analysis to the user's 2026-11-06 report.
Source-level capability coverage and isolated tool tests did not establish usable
multi-tool conversations; the screenshot exposed the missing composed-workflow checks.

## Confirmed categories and evidence

- **Cross-layer contract / implicit assumption:** a turn allowed only three provider
  decisions, including its final answer. Three legitimate resource reads could therefore
  never reach a fourth summarization or financial preview decision.
- **Change propagation / coverage gap:** successful tool facts lived only in `lastResult`.
  Another tool replaced them, and generation failure discarded their visible result cards.
  A marker in a real Runner reproduction appeared in prompt presence `[false,true,false]`.
- **Background lifecycle contract:** `spending.preview` scheduled a durable job, while the
  prompt told the model to poll it inside the short conversation turn. The step limit
  converted valid pending work into failure before persisting the task-card handoff.
- **Normalizer contract:** the legitimate 64-hex `snapshotToken` was missing from the exact
  business-hash allowlist, causing ordinary four-purpose summary reads to fail.
- **Adapter interpretation:** a valid stats query containing an explicit month but no kind
  silently used the rolling-window default instead of that month.
- **Transport coverage gap:** long legitimate query results can exceed a single mobile SSE
  line and the replay budget. Increasing decision count alone would expose more failures;
  bounded projections must label omissions and preserve finance IDs/values/paging facts.
- **Client state / diagnostics:** one failed progress GET permanently stopped observation,
  even after a successful manual refresh. The native fault mapper also collapsed different
  fixed safe causes into one generic unfinished-turn hint.

## Why earlier validation missed it

The previous domain audit exercised one registry adapter or one confirmation at a time.
It did not combine lookup -> lookup -> query -> answer/preview through the actual provider
loop, persisted messages, SSE serialization and phone reducer. Empty/small fixtures also
missed legal long notes and populated fund snapshots. Background scheduling was tested,
but not the subsequent turn termination and appearance of its durable client task card.

## Prevention contracts

1. New assistant business capabilities need both isolated domain tests and at least one
   representative composed generation through real routes, for stream and buffered modes.
2. Background start/status/resume is a deterministic handoff, not model polling. Native
   progress reads are cancellable, bounded and restartable without paid inference.
3. Successful reads enter durable history immediately and remain in subsequent bounded
   fact context. Budget exhaustion must not erase verified results or imply all pages were read.
4. Serialized result/card/event UTF-8 size must fit the smallest client/server transport
   boundary. Projection/paging preserves financial meaning and labels omitted text/scope;
   oversized financial confirmations ask for a smaller review instead of hiding effects.
5. Step, partial-snapshot and deadline checks share one contract across generation/legacy
   paths; increasing a constant requires checking all consumers rather than one loop.
6. Credentials stay forbidden; exact concurrency digest exceptions remain exact 64-hex.
   Safe human error explanations come only from an explicit finite server-owned vocabulary.

Implementation handoffs, actual command results and remaining live-provider/deployment
boundaries are recorded in the final reliability verification, not inferred from source.
