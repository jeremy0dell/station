import type { ObserverSqliteMigration } from "./index.js";

export const sessionLifecycleMigration: ObserverSqliteMigration = {
  version: 12,
  name: "session_lifecycle",
  // NULL deliberately means legacy/unknown: ended_at had no production writer
  // before this migration, so historical NULL rows are not proof of an open session.
  sql: `
    ALTER TABLE sessions
      ADD COLUMN lifecycle TEXT CHECK (lifecycle IN ('open', 'ended'));

    UPDATE sessions
      SET lifecycle = 'ended'
      WHERE ended_at IS NOT NULL;
  `,
};
