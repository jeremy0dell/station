import type { ObserverSqliteMigration } from "./migration.js";

export const sessionGroupsMigration: ObserverSqliteMigration = {
  version: 17,
  name: "session_groups",
  sql: `
    CREATE TABLE session_groups (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      parent_group_id TEXT,
      version INTEGER NOT NULL CHECK (version > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX session_groups_project_idx
      ON session_groups (project_id, id);
    CREATE INDEX session_groups_parent_idx
      ON session_groups (project_id, parent_group_id);

    CREATE TABLE session_group_memberships (
      session_id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      project_id TEXT NOT NULL
    );

    CREATE INDEX session_group_memberships_group_idx
      ON session_group_memberships (group_id, session_id);
    CREATE INDEX session_group_memberships_project_idx
      ON session_group_memberships (project_id, group_id, session_id);
  `,
};
