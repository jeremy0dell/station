import type { ObserverSqliteMigration } from "./migration.js";

export const commandResultsMigration: ObserverSqliteMigration = {
  version: 18,
  name: "command_results",
  sql: `
    ALTER TABLE commands ADD COLUMN result_json TEXT;
  `,
};
