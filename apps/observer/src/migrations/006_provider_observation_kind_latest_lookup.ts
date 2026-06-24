import type { ObserverSqliteMigration } from "./index.js";

export const providerObservationKindLatestLookupMigration: ObserverSqliteMigration = {
  version: 6,
  name: "provider_observation_kind_latest_lookup",
  sql: `
    CREATE INDEX IF NOT EXISTS idx_provider_observations_kind_entity_latest
      ON provider_observations (entity_kind, provider, provider_type, entity_key, observed_at DESC, id DESC);
  `,
};
