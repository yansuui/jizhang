# Android inventory maintenance for the conversational workspace

2026-11-06 partial source review only. Android implementation was not changed. Root owns
the final integrated CI evidence; this document does not establish device, provider or
production acceptance.

## Maintained scope

Updated existing stable IDs **A020**, **A093** and **A107–A116**, the assistant API matrix,
known gaps, backend route inventory and change log. No stable IDs were added, removed or
recycled. Existing global audit dates, historical capability/API totals and previous test/
device records remain. The new route inventory is explicitly a partial addition rather
than a recalculated global total. The root's existing JPEG/PNG `/items/cutouts` contract
row was preserved, with matching detail added to the full API table.

The inventory now distinguishes existing Android v1/legacy behavior from negotiated
`workspace-v1` server/iOS interactions. Android does not declare this client capability
and has no methods/UI for typed selections, draft revision, post-confirmation continuation,
result-page/native-action routing, trace or notification-launched daily review. Existing
generic confirmation, standalone platform import and historical organization remain their
actual implementations; they are not relabelled as the new iOS workspace.

## Reviewed implementation anchors

| Source | Verified contract |
| --- | --- |
| `clients/android/app/src/main/java/com/yansuu1/jizhang/repo/AssistantRepository.kt:86` | `createGeneration` sends version/clientRequestId/input, without `clientCapabilities`. The existing messages/generation/confirm/cancel methods remain. |
| `clients/android/app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantConversationHelper.kt:280` | The result summary reader still caps depth at two and six values. New server arrays/cards do not imply complete Android rendering. |
| `clients/android/app/src/main/java/com/yansuu1/jizhang/repo/ItemRepository.kt:70` | Android cutout upload still sends `image/webp`. |
| `packages/server/src/routes/assistant.ts:325` | Workspace client capability is explicitly validated and separated from the v1 generation request; new bindings are opt-in. |
| `packages/server/src/routes/assistant-workspace.ts:18` | Reviewed all 13 new workspace/CSV/daily paths and marked each Android-not-consumed in both API inventories. |
| `packages/server/src/routes/assistant.ts:395` | Trace GET is backend/iOS metadata, with no Android route method or new trace view. |
| `packages/server/src/services/assistant-workspace-store.ts:11` | Actual resource/date kinds and native-action destinations are bounded enumerations, not arbitrary model URLs. |
| `packages/server/src/services/assistant-workspace-store.ts:20` | Request identity uses canonical payload hashing; body-key order is not a new request. |
| `packages/server/src/services/assistant-workspace-store.ts:63` | Daily scope is retained in the workflow and inherited through continuations; the inventory describes the dedicated review policy separately from ordinary read tools. |
| `packages/server/src/services/assistant-workspace-store.ts:83` | Lifecycle reconciliation checks current generation, action and archive state rather than leaving an old task phase authoritative. |
| `packages/server/src/services/assistant-workspace-service.ts:94` | Draft revision prepares a replacement, closes the old pending action and still requires confirmation. |
| `packages/server/src/services/assistant-workspace-service.ts:155` | Confirmed continuation references the original action/workflow and does not repeat its financial write. |
| `packages/server/src/services/assistant-workspace-service.ts:242` | Daily review uses explicit date/Asia-Shanghai scope and an idempotent request; iOS notification activation is a client behavior, not Android background inference. |
| `packages/server/src/services/assistant-csv-import-service.ts` | Dedicated CSV preview uses rollback-only import validation; confirmation checks original hash/ledger fingerprint and replays an already-confirmed result. Raw CSV is not supplied to the model. |
| `packages/server/src/services/assistant-trace-service.ts` | Both stored legacy data and new values are filtered to shape metadata; no Android trace presentation was added. |
| `packages/server/src/routes/item-cutouts.ts:40` | JPEG/PNG join WebP as input formats; the worker receives the validated MIME type. Preview remains WebP and final image PNG. |
| `packages/server/src/services/item-cutout-client.ts:105` | New optional MIME parameter defaults to WebP, retaining the previous Android input behavior. |

Exact line anchors describe the reviewed source at this handoff; root may add tests or
local fixes before final commit. Maintained links in the README target the corresponding
source files and do not claim unchanged line numbers after those edits.

## Checks and limits

- README whitespace/diff check passed after the partial update.
- Stable Android assistant IDs and historical audit/count records were preserved.
- The existing root-authored `/items/cutouts` compatibility row was retained verbatim.
- Android Kotlin source was not edited by this documentation worker.
- No Android build/test/device evidence was generated by this doc-only task. Final
  repository/Android/native CI results belong in the main implementation verification.
- The iOS reminder defaults (20:00 recording, 21:00 review), local permission and tap-only
  generation are explicitly iOS behavior; no Android notification or capability parity
  is inferred from it.
