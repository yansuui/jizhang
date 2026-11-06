# Assistant generation streaming v1

## 1. Scope / Trigger
Real incremental Android assistant output, single-select clarification and explicit lifecycle. Generation is advisory; ledger writes still require existing human confirmation. `assistant.ts` remains in the authenticated plugin. The precise wire contract is in task `10-15-ai-streaming-interactive-dialogue/research/protocol-v1.md`.

## 2. Signatures
Under `/api/v1/assistant/conversations/:conversationId`:
- `POST /generations`: version1, clientRequestId1..120, input text/choice/choice-text. First202, identical canonical replay200.
- `GET /generations?limit=1`, `GET /generations/:generationId`: durable snapshots, no new provider work.
- `GET /generations/:generationId/events?afterSeq=N`: authenticated UTF8 SSE (explicit exception to JSON-only API responses).
- `POST /generations/:generationId/cancel`: bodiless, CSRF required, ownership-checked idempotent cancellation.
Migration011 adds `assistant_generations` and `assistant_generation_events`; existing migration009 message-kind CHECK is unchanged.

## 3. Contracts
- Snapshot includes version/id/conversationId/userMessageId/userMessage/status/delivery/lastSeq/partialMessages/messageIds/messages/outcome/error/timestamps. Generation IDs opaque server values. Only completed carries outcome answer/awaiting-choice/pending-confirmation; none means booked.
- Events are state, text-delta, message, terminal with version/generationId/seq; text offsets use UTF16 units with complete surrogate pairs. Provisional message ID is reused by the validated final DTO. Clients reject gaps/offset mismatch and reconcile snapshots; old snapshots cannot replace newer seq state.
- True stream eligibility: Chat Completions + POST + `choices[0].message.content`; all other configured modes/paths explicitly buffered. No Chat retry/fake typing or silent fallback after stream failure.
- Provider SSE and JSON message tokenizer enforce UTF8, framing, size/depth/duplicate-key/escape/surrogate limits. Incremental tokenizer accepts valid empty containers (`[]`, `{}` across arbitrary chunk splits) while strictly rejecting illegal trailing commas in both objects and arrays (`{"a":1,}`, `[1,]`, `[,]`, `[1,,2]`). Only decoded top-level message text streams; tools/clarification require whole-envelope validation and stop+[DONE]. Server-local today is captured per generation and serialized in assistant prompt. Provider timeout includes body; nested provider tool calls across both read-tool execution (`readTool`) and write-tool prepare (`finishWriteTurn`) share the generation tool scope (`openToolScope`), binding both to upstream cancellation (`AbortSignal.any`) and remaining generation deadline budget (`remainingMs = max(1, deadline - now())`); timed out or aborted scopes fail fast before atomic transaction commit.
- One active turn across legacy messages/analyse and generations. Always release legacy exclusion on parse/write failure. Final message+pending action+terminal commit in one transaction; publish only after commit. Cancel checks ownership and wins terminal before abort; archival/restart fences late writes, no auto rerun.
- Choice is existing text message content with generationId and clarification: server id, single question1..200, 2..6 unique options(id,label1..100), allowFreeText. Consume choice and create continuation atomically; ordinary input supersedes it. Client labels/actions never authoritative.
- Replay <=2048 events/2MiB UTF8; reserve one terminal event and16KiB terminal space so overflow can still fail explicitly. Subscriber <=128 events/256KiB; close wakes waiters, releases queue and pump, producer continues durable work. Heartbeat15s is a comment, not progress.
- Android blocked reads must be cancelled by a separately cancellable owner, not an invokeOnCompletion handler on the blocked reader itself. `cancellableBlockingFlow` is used by production SSE read; parser handles LF/CRLF/CR without reading past completed frames. EOF without terminal means reconcile, not successful answer.
- UI scroll and new-message indicator: when observing scroll state and pending new-message indicators via `snapshotFlow`, the pending state (`newMessagesAvailable`) must be read directly inside the `snapshotFlow` block—e.g. `Triple(newMessagesAvailable, atBottom, isScrollInProgress)`—rather than outside in `.collect` over `Pair(atBottom, isScrollInProgress)`. Otherwise Compose's internal `distinctUntilChanged` suppresses emission when geometric bottom state remains unchanged during a pending flag transition, causing the pill indicator to linger. Clearing the indicator must strictly require `atBottom && !isScrollInProgress` so manual reading away from bottom preserves the pill until true natural bottom is reached, without stealing focus or forcing unconditional auto-scroll on every text delta.
- Preserve all existing file digest/100-selection/idempotent human confirmation guards. History authoritative action statuses override cached generation pending status.
- A streamed or legacy turn allows eight provider decisions, including the final answer,
  under the same 180-second deadline. Snapshot partial-message validation uses that shared
  decision bound. Successful reads are persisted immediately and retained as bounded facts
  in later decisions, not overwritten by the most recent tool result. Current read facts
  are capped at 64 KiB; recent history at 128 KiB with an explicit omission notice. A budget
  handoff preserves partial facts and completes honestly instead of claiming full coverage.
- `spending.preview/status/resume/card` returning an actual `data.run` completes the chat
  turn deterministically with the durable task result. Background analysis owns its provider
  scope; no model polling or wait-for-analysis loop inside a generation. Ready suggestion
  cards without a run continue through normal read/confirmation handling.
- Read results fit 40 KiB UTF-8 including the tool envelope. Generation message/card
  serialization fits 48 KiB before persistence, leaving room for the native 64 KiB SSE line.
  Reject an oversized financial preview before creating a pending action; never remove
  effects from a write preview to make it fit. This event guard does not change the legacy
  attachment-import path's existing file/selection contract.
- Canonically identical reads execute once per turn. Only known typed business validation
  errors (400/404/409) receive at most two correction opportunities with fixed safe feedback;
  unknown tools, retired allocation arguments, authentication, cancellation and deadlines
  remain hard boundaries. Expected organization capacity/busy/not-ready states use fixed
  actionable replies without another inference or raw error disclosure.
- A reply that is not a bare JSON object is repaired by `assistant-envelope-recovery.ts`
  before it can fail the turn: one surrounding Markdown fence is stripped, then the outermost
  balanced `{...}` is extracted (string literals and escapes respected), and only then is the
  object validated by the usual `normalizeAssistantProviderTurn`. Brace-free prose becomes an
  ordinary answer (`toolCall: null`, never a card or clarification). Text that still contains a
  brace, or that parses as a non-object JSON value (`[1,2]`, `"x"`, `42`), is never shown as
  prose — it keeps the bounded `INVALID_ENVELOPE` failure, so a truncated object can never be
  presented as a finished answer.

## 4. Validation & Error Matrix
| Condition | Behavior |
|---|---|
| Same request ID, changed payload |409 ASSISTANT_REQUEST_CONFLICT |
| Parallel legacy/new turn |409 ASSISTANT_GENERATION_ACTIVE |
| Forged/stale/wrong-conversation choice |409 ASSISTANT_CHOICE_STALE |
| Replay cursor unavailable |409 ASSISTANT_REPLAY_UNAVAILABLE before SSE headers |
| Invalid version/input/bounds |400 ASSISTANT_GENERATION_INVALID |
| Malformed/truncated provider stream or deadline |Safe failed terminal, no unvalidated card |
| Client connection lost |Close subscription; same generation GET/replay, never automatic model POST |
| Explicit Stop/restart/archive |Cancelled/interrupted, no late card or automatic rerun |
| Envelope wrapped in a Markdown fence |Fence stripped, object validated normally (no new card without confirmation) |
| Object surrounded by prose |Outermost balanced object extracted and validated |
| Brace-free prose reply |Ordinary answer with `toolCall: null`; no card, no clarification |
| Truncated object, or non-object JSON (`[1,2]`, `"x"`, `42`) |Bounded `INVALID_ENVELOPE`; never shown as prose |

## 5. Good / Base / Bad Cases
Good: delayed mock upstream has not completed, client already receives prose; validated question later appears, click continues without ledger change. Base: unsupported provider stays buffered and labeled. Bad: generated answer labeled booked, raw JSON streamed, old cancelled request aborts a different conversation, or a parser waits for stream EOF to emit a completed event.

## 6. Tests Required
Server `assistant-stream.test.ts`, `assistant-stream-routes.test.ts`, `assistant-generation-persistence.test.ts`: incremental-before-finish, Unicode/framing/size, auth/CSRF, ownership/dedup/replay/cancel/archive/restart, atomic rollback, terminal reservation, slow subscribers, malformed legacy input recovery, nested read-tool and write-tool prepare cancellation/deadline regressions (verifying scoped abort/deadline cut nested requests before atomic commit), tokenizer regressions for valid empty containers (`[]`/`{}` across chunk splits) and illegal trailing commas (verifying arrays and objects reject trailing commas without fallback), and unchanged ledger. `assistant-envelope-recovery.test.ts` covers fence stripping, balanced-object extraction (braces inside strings, escaped quotes, truncation), prose-only answers, and the refusal of truncated or non-object JSON. Socket-only incremental acceptance uses an ephemeral loopback port with cleanup; ordinary route tests use inject. This is a narrow transport-test exception, never production-provider evidence.
Android SSE controlled-source/socket cancellation, strict DTO/reducer, seq/gap/identity/ABA, stale confirmed card, EOF/choice uncertainty/scroll helpers; full unit/lint/build. Actual New API/Caddy/Huawei timing, large-font/IME/back/reading/reconnect remain device acceptance until tested.

Composed real-route regressions also cover four reads then answer/plan preview, seven
reads then an eighth final answer, preservation after later failure, one-call background
handoff in streamed and buffered modes, typed correction without writes, duplicate-read
termination, 500-record capacity/busy feedback, long populated results with replay limits,
and oversized write-preview rejection before a pending action exists. Isolated tool tests
alone do not establish conversation usability.

## 7. Wrong vs Correct
Wrong: synchronous statements assumed atomic; complete-handler waits for blocked reader; two-pass LF then CR searches; terminal capacity consumed by text; unbounded nested prepare ignoring deadline/abort; tokenizer rejecting empty arrays `[]` or silently tolerating trailing commas; `snapshotFlow` reading `newMessagesAvailable` outside the flow block causing lingering scroll pill. Correct: SQLite transaction then publish; separate owner cancels transport; one-pass/stateful delimiter reader; terminal capacity reserved before emitting nonterminal events; scoped abort/deadline for both nested read-tool execution and write-tool prepare; accept empty containers while strictly rejecting trailing commas; observe `Triple(newMessagesAvailable, atBottom, isScrollInProgress)` inside `snapshotFlow` and clear only when true bottom is reached without scrolling in progress.
