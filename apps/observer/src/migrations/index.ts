import { observerMetaMigration } from "./001_observer_meta.js";
import { persistenceHistoryMigration } from "./002_persistence_history.js";
import { diagnosticsTraceMigration } from "./003_diagnostics_trace.js";
import { providerObservationLookupIndexesMigration } from "./004_provider_observation_lookup_indexes.js";
import { providerObservationLatestLookupMigration } from "./005_provider_observation_latest_lookup.js";
import { providerObservationKindLatestLookupMigration } from "./006_provider_observation_kind_latest_lookup.js";
import { worktreeMetadataCurrentMigration } from "./007_worktree_metadata_current.js";
import { hookIngressDedupeMigration } from "./008_hook_ingress_dedupe.js";
import { sessionTitleMigration } from "./009_session_title.js";
import { sessionRecoveryHandlesMigration } from "./010_session_recovery_handles.js";
import { sessionTurnReadinessMigration } from "./011_session_turn_readiness.js";
import { sessionLifecycleMigration } from "./012_session_lifecycle.js";
import { sessionHarnessExecutionsMigration } from "./013_session_harness_executions.js";
import { nativeBindingIngressClaimsMigration } from "./014_native_binding_ingress_claims.js";

export type ObserverSqliteMigration = {
  version: number;
  name: string;
  sql: string;
};

export const migrations = [
  observerMetaMigration,
  persistenceHistoryMigration,
  diagnosticsTraceMigration,
  providerObservationLookupIndexesMigration,
  providerObservationLatestLookupMigration,
  providerObservationKindLatestLookupMigration,
  worktreeMetadataCurrentMigration,
  hookIngressDedupeMigration,
  sessionTitleMigration,
  sessionRecoveryHandlesMigration,
  sessionTurnReadinessMigration,
  sessionLifecycleMigration,
  sessionHarnessExecutionsMigration,
  nativeBindingIngressClaimsMigration,
] as const;

export const latestSchemaVersion = migrations[migrations.length - 1]?.version ?? 0;
