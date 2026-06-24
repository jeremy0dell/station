import type { ObserverSqliteMigration } from "./index.js";

export const persistenceHistoryMigration: ObserverSqliteMigration = {
  version: 2,
  name: "persistence_history",
  sql: `
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      root TEXT NOT NULL,
      repo TEXT,
      config_hash TEXT,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS worktrees (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      branch TEXT,
      source TEXT,
      state TEXT,
      dirty INTEGER,
      provider TEXT,
      provider_data_json TEXT,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      worktree_id TEXT NOT NULL,
      harness TEXT,
      terminal_provider TEXT,
      state TEXT,
      created_at TEXT NOT NULL,
      ended_at TEXT,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS terminal_targets (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      project_id TEXT,
      worktree_id TEXT,
      provider TEXT NOT NULL,
      state TEXT,
      provider_key TEXT,
      provider_data_json TEXT,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS harness_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      project_id TEXT,
      worktree_id TEXT,
      harness TEXT NOT NULL,
      pid INTEGER,
      external_run_id TEXT,
      state TEXT,
      confidence TEXT,
      reason TEXT,
      provider_data_json TEXT,
      last_event_at TEXT,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS commands (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      error_json TEXT
    );

    CREATE TABLE IF NOT EXISTS command_errors (
      id TEXT PRIMARY KEY,
      command_id TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      command_id TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS provider_observations (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_type TEXT NOT NULL,
      entity_kind TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      expires_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_provider_observations_expiry
      ON provider_observations (expires_at);

    CREATE TABLE IF NOT EXISTS recovery_breadcrumbs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      worktree_id TEXT,
      session_id TEXT,
      location TEXT NOT NULL,
      path TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
  `,
};
