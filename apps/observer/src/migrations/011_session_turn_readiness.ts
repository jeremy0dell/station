import type { ObserverSqliteMigration } from "./index.js";

export const sessionTurnReadinessMigration: ObserverSqliteMigration = {
  version: 11,
  name: "session_turn_readiness",
  sql: `
    CREATE TABLE IF NOT EXISTS session_turn_readiness (
      session_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      worktree_id TEXT NOT NULL,
      token TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_turn_readiness_worktree
      ON session_turn_readiness (project_id, worktree_id, completed_at);
  `,
};
