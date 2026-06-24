import type { ObserverSqliteMigration } from "./index.js";

export const sessionRecoveryHandlesMigration: ObserverSqliteMigration = {
  version: 10,
  name: "session_recovery_handles",
  // Store the minimum durable resume target and correlation needed to restart
  // safely. Provider payloads, prompts, transcripts, and diagnostics stay out
  // of this table by design.
  sql: `
    CREATE TABLE IF NOT EXISTS session_recovery_handles (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      project_id TEXT NOT NULL,
      worktree_id TEXT NOT NULL,
      session_id TEXT,
      target_kind TEXT NOT NULL,
      target_value TEXT NOT NULL,
      cwd TEXT,
      terminal_target_id TEXT,
      harness_run_id TEXT,
      observed_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      UNIQUE(provider, target_kind, target_value)
    );

    CREATE INDEX IF NOT EXISTS idx_session_recovery_handles_worktree
      ON session_recovery_handles (project_id, worktree_id, last_seen_at);
  `,
};
