import type { ObserverSqliteMigration } from "./migration.js";

export const commandRecoveryLookupMigration: ObserverSqliteMigration = {
  version: 18,
  name: "command_recovery_lookup",
  sql: `
    CREATE INDEX IF NOT EXISTS idx_events_command_type
      ON events (command_id, type);

    CREATE INDEX IF NOT EXISTS idx_command_errors_command
      ON command_errors (command_id);
  `,
};
