import type { ObserverSqliteMigration } from "./index.js";

export const providerObservationLatestLookupMigration: ObserverSqliteMigration = {
  version: 5,
  name: "provider_observation_latest_lookup",
  sql: `
    CREATE INDEX IF NOT EXISTS idx_provider_observations_entity_latest
      ON provider_observations (provider, provider_type, entity_kind, entity_key, observed_at DESC, id DESC);
  `,
};
