import type { ObserverSqliteMigration } from "./index.js";

export const observerMetaMigration: ObserverSqliteMigration = {
  version: 1,
  name: "observer_meta",
  sql: `
    CREATE TABLE IF NOT EXISTS observer_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS observer_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `,
};
