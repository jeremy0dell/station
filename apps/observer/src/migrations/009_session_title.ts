import type { ObserverSqliteMigration } from "./index.js";

export const sessionTitleMigration: ObserverSqliteMigration = {
  version: 9,
  name: "session_title",
  sql: `
    ALTER TABLE sessions ADD COLUMN title TEXT;
  `,
};
