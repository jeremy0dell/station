import type { SafeError } from "@station/contracts";
import {
  Effect,
  type RuntimeClock,
  type RuntimeSafeError,
  safeErrorFromUnknown,
  systemClock,
  toIsoTimestamp,
} from "@station/runtime";
import { latestSchemaVersion, migrations } from "./migrations/index.js";
import { openSqlDatabase, type SqlDatabase } from "./sqlite/driver.js";

export type ObserverSqliteHealthStatus = "healthy" | "unavailable" | "closed";

export type AppliedObserverSqliteMigration = {
  version: number;
  name: string;
  appliedAt: string;
};

export type ObserverSqliteHealth = {
  path: string;
  open: boolean;
  status: ObserverSqliteHealthStatus;
  schemaVersion: number;
  migrations: AppliedObserverSqliteMigration[];
  lastCheckedAt: string;
  lastError?: SafeError;
};

export type ObserverSqliteHandle = {
  database: SqlDatabase;
  health(): ObserverSqliteHealth;
  recordFailure(error: SafeError): void;
  close(): void;
};

export type OpenObserverSqliteOptions = {
  path?: string;
  clock?: RuntimeClock;
};

export function openObserverSqlite(options: OpenObserverSqliteOptions = {}): ObserverSqliteHandle {
  const path = options.path ?? ":memory:";
  const clock = options.clock ?? systemClock;
  const database = openSqlDatabase(path);
  // WAL + synchronous=NORMAL keeps an unclean exit (SIGKILL of a wedged observer)
  // from corrupting the DB or losing committed rows; :memory: ignores WAL.
  if (path !== ":memory:") {
    database.exec("PRAGMA journal_mode = WAL");
  }
  database.exec("PRAGMA synchronous = NORMAL");
  let open = true;
  let lastError: SafeError | undefined;
  let appliedMigrations: AppliedObserverSqliteMigration[] = [];

  try {
    applyMigrations(database, clock);
    appliedMigrations = readAppliedMigrations(database);
  } catch (error) {
    lastError = safeErrorFromUnknown(error, {
      tag: "PersistenceError",
      code: "PERSISTENCE_MIGRATION_FAILED",
      message: "Observer SQLite migrations failed.",
    });
    throw error;
  }

  return {
    database,
    recordFailure: (error) => {
      lastError = error;
    },
    health: () => ({
      path,
      open,
      status: open ? (lastError === undefined ? "healthy" : "unavailable") : "closed",
      schemaVersion: readSchemaVersion(database, open),
      // Keep the last migration list available after close(), when SQLite can no longer be queried.
      migrations: open ? readAppliedMigrations(database) : appliedMigrations,
      lastCheckedAt: toIsoTimestamp(clock.now()),
      ...(lastError === undefined ? {} : { lastError }),
    }),
    close: () => {
      if (open) {
        database.close();
        open = false;
      }
    },
  };
}

export function runSqliteTransactionEffect<T>(
  sqlite: ObserverSqliteHandle,
  task: (database: SqlDatabase) => T,
): Effect.Effect<T, RuntimeSafeError> {
  return Effect.try({
    try: () => {
      sqlite.database.exec("BEGIN IMMEDIATE");
      try {
        const value = task(sqlite.database);
        sqlite.database.exec("COMMIT");
        return value;
      } catch (error) {
        sqlite.database.exec("ROLLBACK");
        throw error;
      }
    },
    catch: (error) => {
      const safeError = safeErrorFromUnknown(error, {
        tag: "PersistenceError",
        code: "PERSISTENCE_TRANSACTION_FAILED",
        message: "Observer SQLite transaction failed.",
      });
      sqlite.recordFailure(safeError);
      return safeError;
    },
  });
}

type MigrationRow = {
  version: number;
  name: string;
  applied_at: string;
};

type SchemaVersionRow = {
  value: string;
};

function applyMigrations(database: SqlDatabase, clock: RuntimeClock): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS observer_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS observer_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  // Requeue the two unpublished migration numbers after main assigned version 12 elsewhere.
  database
    .prepare(`
      DELETE FROM observer_migrations
      WHERE (version = 12 AND name = 'session_harness_executions')
         OR (version = 13 AND name = 'native_binding_ingress_claims')
    `)
    .run();

  const appliedVersions = new Set(
    readAppliedMigrations(database).map((migration) => migration.version),
  );

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      // Store both an audit trail and a fast schema_version lookup for health reporting.
      database
        .prepare(
          "INSERT OR REPLACE INTO observer_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        )
        .run(migration.version, migration.name, toIsoTimestamp(clock.now()));
      database
        .prepare("INSERT OR REPLACE INTO observer_meta (key, value) VALUES ('schema_version', ?)")
        .run(String(migration.version));
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  database
    .prepare("INSERT OR REPLACE INTO observer_meta (key, value) VALUES ('schema_version', ?)")
    .run(String(latestSchemaVersion));
}

function readSchemaVersion(database: SqlDatabase, open: boolean): number {
  if (!open) {
    return latestSchemaVersion;
  }

  const row = database
    .prepare("SELECT value FROM observer_meta WHERE key = 'schema_version'")
    .get() as SchemaVersionRow | undefined;
  const version = Number(row?.value);
  return Number.isFinite(version) ? version : 0;
}

function readAppliedMigrations(database: SqlDatabase): AppliedObserverSqliteMigration[] {
  return (
    database
      .prepare("SELECT version, name, applied_at FROM observer_migrations ORDER BY version")
      .all() as MigrationRow[]
  ).map((row) => ({
    version: row.version,
    name: row.name,
    appliedAt: row.applied_at,
  }));
}
