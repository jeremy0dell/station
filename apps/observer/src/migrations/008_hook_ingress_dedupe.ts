import type { ObserverSqliteMigration } from "./index.js";

export const hookIngressDedupeMigration: ObserverSqliteMigration = {
  version: 8,
  name: "hook_ingress_dedupe",
  sql: `
    CREATE TABLE IF NOT EXISTS hook_ingress_dedupe (
      kind TEXT NOT NULL,
      dedupe_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (kind, dedupe_id)
    );

    CREATE INDEX IF NOT EXISTS idx_hook_ingress_dedupe_event
      ON hook_ingress_dedupe (event_id);
  `,
};
