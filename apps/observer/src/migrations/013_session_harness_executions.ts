import type { ObserverSqliteMigration } from "./index.js";

export const sessionHarnessExecutionsMigration: ObserverSqliteMigration = {
  version: 13,
  name: "session_harness_executions",
  // Hook ingress can bind before reconcile reconstructs the session row, so this
  // table deliberately has no sessions foreign key.
  sql: `
    CREATE TABLE IF NOT EXISTS session_harness_executions (
      provider TEXT NOT NULL,
      session_id TEXT NOT NULL,
      native_session_id TEXT NOT NULL,
      state TEXT NOT NULL,
      status_updated_at TEXT NOT NULL,
      PRIMARY KEY (provider, session_id)
    );
  `,
};
