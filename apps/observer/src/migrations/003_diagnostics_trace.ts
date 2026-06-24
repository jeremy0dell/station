import type { ObserverSqliteMigration } from "./index.js";

export const diagnosticsTraceMigration: ObserverSqliteMigration = {
  version: 3,
  name: "diagnostics_trace",
  sql: `
    ALTER TABLE commands ADD COLUMN trace_id TEXT;
    ALTER TABLE commands ADD COLUMN span_id TEXT;
    ALTER TABLE events ADD COLUMN trace_id TEXT;
    ALTER TABLE events ADD COLUMN span_id TEXT;

    CREATE INDEX IF NOT EXISTS idx_commands_trace_id
      ON commands (trace_id);

    CREATE INDEX IF NOT EXISTS idx_events_trace_id
      ON events (trace_id);
  `,
};
