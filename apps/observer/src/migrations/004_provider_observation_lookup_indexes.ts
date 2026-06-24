import type { ObserverSqliteMigration } from "./index.js";

export const providerObservationLookupIndexesMigration: ObserverSqliteMigration = {
  version: 4,
  name: "provider_observation_lookup_indexes",
  sql: `
    CREATE INDEX IF NOT EXISTS idx_provider_observations_kind_observed
      ON provider_observations (entity_kind, observed_at, id);

    CREATE INDEX IF NOT EXISTS idx_provider_observations_kind_expiry
      ON provider_observations (entity_kind, expires_at);
  `,
};
