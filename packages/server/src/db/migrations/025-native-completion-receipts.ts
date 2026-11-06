/** A legacy confirmed CSV remains replayable, but has no proof of a new completion time. */
export const MIGRATION_025_NATIVE_COMPLETION_RECEIPTS = `
ALTER TABLE assistant_csv_previews ADD COLUMN confirmed_at INTEGER;
`;
