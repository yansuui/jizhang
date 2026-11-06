/** Tenant-owned workflow metadata; financial approval remains in pending_actions. */
export const MIGRATION_024_ASSISTANT_WORKSPACE = `
CREATE TABLE assistant_workflows (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, original_request TEXT NOT NULL,
 phase TEXT NOT NULL, facts_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_assistant_workflows_conversation ON assistant_workflows(conversation_id,updated_at);
CREATE TABLE assistant_workspace_generations (
 generation_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, daily_json TEXT
);
CREATE TABLE assistant_interactions (
 id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
 generation_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, multiple INTEGER NOT NULL,
 filters_json TEXT NOT NULL, fingerprint TEXT NOT NULL, expires_at INTEGER NOT NULL,
 answer_hash TEXT, answer_generation_id TEXT, status TEXT NOT NULL DEFAULT 'pending'
);
CREATE TABLE assistant_workspace_results (
 message_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, tool_name TEXT NOT NULL, arguments_json TEXT NOT NULL
);
CREATE TABLE assistant_workspace_actions (
 action_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, workflow_id TEXT NOT NULL,
 continuation_generation_id TEXT
);
CREATE TABLE assistant_workspace_requests (
 conversation_id TEXT NOT NULL, kind TEXT NOT NULL, request_id TEXT NOT NULL,
 request_hash TEXT NOT NULL, response_json TEXT NOT NULL,
 PRIMARY KEY(conversation_id,kind,request_id)
);
CREATE TABLE assistant_csv_previews (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
 kind TEXT NOT NULL, file_hash TEXT NOT NULL, fingerprint TEXT NOT NULL,
 preview_json TEXT NOT NULL, result_json TEXT, expires_at INTEGER NOT NULL
);
-- Old diagnostic strings may contain raw arguments. Identity/timing/status stay intact.
UPDATE assistant_generation_trace SET argument_summary = NULL;
`;
