import type { ObserverSqliteMigration } from "./migration.js";

export const sessionExecutionMigration: ObserverSqliteMigration = {
  version: 21,
  name: "session_execution",
  sql: "ALTER TABLE sessions ADD COLUMN execution_provider TEXT;",
};
