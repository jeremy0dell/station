import type { ObserverSqliteMigration } from "./migration.js";

export const eventRetentionIndexesMigration: ObserverSqliteMigration = {
  version: 21,
  name: "event_retention_indexes",
  sql: `
    CREATE INDEX IF NOT EXISTS idx_events_created_at
      ON events (created_at);
    CREATE INDEX IF NOT EXISTS idx_hook_ingress_dedupe_created_at
      ON hook_ingress_dedupe (created_at);
  `,
};
