import type { ObserverSqliteMigration } from "./migration.js";

export const worktreeDisplayTitlesMigration: ObserverSqliteMigration = {
  version: 16,
  name: "worktree_display_titles",
  sql: `
    CREATE TABLE worktree_display_titles (
      project_id TEXT NOT NULL,
      worktree_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, worktree_id)
    );
  `,
};
