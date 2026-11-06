/**
 * Migration 023 — durable per-step execution trace for assistant generations.
 *
 * Why a separate table instead of reusing `assistant_messages`
 * -----------------------------------------------------------
 * `assistant_messages` rows are part of the user-visible conversation transcript: they are
 * read back by every client, participate in `contextMessage()` projections and drive the
 * unread/new-message UI. A trace is *diagnostic*: it explains which step failed without
 * being part of the dialogue, and an older client must keep rendering exactly as before.
 * Keeping it in its own table makes that guarantee structural rather than a rendering
 * convention, and lets a future retention job drop old traces without touching a message.
 *
 * What is stored
 * --------------
 * Only bounded, non-sensitive metadata: step ordinal, kind, tool name, an argument summary,
 * a status and a duration. Never the model's raw reasoning, the provider request body, the
 * prompt, SQL, a credential or a raw bill note — those must not become queryable history.
 *
 * `generation_id` deliberately has no cascade: the owning generation row is the authority on
 * whether the turn still exists, and a trace surviving an archival keeps the forensic record
 * consistent with `assistant_generation_events`, which behaves the same way.
 */
export const MIGRATION_023_ASSISTANT_TRACE = `
CREATE TABLE IF NOT EXISTS assistant_generation_trace (
  id                 TEXT PRIMARY KEY,
  generation_id      TEXT NOT NULL,
  conversation_id    TEXT NOT NULL,
  step               INTEGER NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('thinking','tool','result','error')),
  tool_name          TEXT,
  argument_summary   TEXT,
  status             TEXT NOT NULL CHECK (status IN ('running','ok','failed')),
  started_at         INTEGER NOT NULL,
  finished_at        INTEGER,
  created_at         INTEGER NOT NULL
);

-- The native client and any forensic query read one generation's trace in step order.
CREATE INDEX IF NOT EXISTS idx_assistant_generation_trace_generation
  ON assistant_generation_trace (generation_id, step, created_at);

-- Conversation-level retention/cleanup walks by conversation, not by generation.
CREATE INDEX IF NOT EXISTS idx_assistant_generation_trace_conversation
  ON assistant_generation_trace (conversation_id, created_at);
`;
