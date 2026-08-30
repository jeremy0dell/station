import type { ObserverSqliteMigration } from "./migration.js";

export const dropLegacyProviderHealthObservationsMigration: ObserverSqliteMigration = {
  version: 19,
  name: "drop_legacy_provider_health_observations",
  sql: `
    DELETE FROM provider_observations
    WHERE entity_kind = 'provider_health';
  `,
};
