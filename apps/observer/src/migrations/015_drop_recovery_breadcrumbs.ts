import type { ObserverSqliteMigration } from "./index.js";

export const dropRecoveryBreadcrumbsMigration: ObserverSqliteMigration = {
  version: 15,
  name: "drop_recovery_breadcrumbs",
  sql: `
    DROP TABLE IF EXISTS recovery_breadcrumbs;
  `,
};
