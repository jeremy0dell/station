import type { ObserverSqliteMigration } from "./index.js";

export const worktreeMetadataCurrentMigration: ObserverSqliteMigration = {
  version: 7,
  name: "worktree_metadata_current",
  sql: `
    CREATE TABLE IF NOT EXISTS worktree_metadata_current (
      worktree_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('change_summary', 'pull_request', 'checks')),
      payload_json TEXT NOT NULL,
      cache_key TEXT,
      updated_at TEXT NOT NULL,
      expires_at TEXT,
      stale INTEGER NOT NULL DEFAULT 0,
      last_error_json TEXT,
      PRIMARY KEY (worktree_id, kind)
    );

    CREATE INDEX IF NOT EXISTS idx_worktree_metadata_current_kind_expiry
      ON worktree_metadata_current (kind, expires_at);

    CREATE INDEX IF NOT EXISTS idx_worktree_metadata_current_expiry
      ON worktree_metadata_current (expires_at);
  `,
};
