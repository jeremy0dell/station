import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFakeHarnessRun,
  createFakeTerminalTarget,
  createFakeWorktree,
} from "@station/testing";
import { describe, expect, it } from "vitest";
import { latestSchemaVersion, migrations } from "../../src/migrations";
import { createSqliteObserverPersistence, type IngressJournal } from "../../src/persistence";
import { openObserverSqlite } from "../../src/sqlite";
import { openSqlDatabase } from "../../src/sqlite/driver";
import { observerPersistenceContract } from "../support/observerPersistenceContract";

const now = "2026-05-20T12:00:00.000Z";

observerPersistenceContract("SQLite", ({ clock, idFactory }) => {
  const sqlite = openObserverSqlite({ clock });
  return {
    persistence: createSqliteObserverPersistence({ sqlite, clock, idFactory }),
    close: () => sqlite.close(),
  };
});

describe("SQLite-only Observer persistence behavior", () => {
  it("migrates historical session lifecycle without treating legacy NULL as open", async () => {
    const directory = await mkdtemp(join(tmpdir(), "station-session-lifecycle-"));
    const path = join(directory, "observer.sqlite");
    const legacyDatabase = openSqlDatabase(path);
    try {
      for (const migration of migrations.filter(({ version }) => version < 12)) {
        legacyDatabase.exec(migration.sql);
        legacyDatabase
          .prepare("INSERT INTO observer_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, now);
      }
      const insert = legacyDatabase.prepare(`
        INSERT INTO sessions
          (id, project_id, worktree_id, harness, created_at, ended_at, last_seen_at)
        VALUES (?, 'web', 'wt_legacy', 'codex', ?, ?, ?)
      `);
      insert.run("ses_legacy_unknown", now, null, now);
      insert.run("ses_legacy_close", now, null, now);
      insert.run("ses_legacy_conflict", now, null, now);
      insert.run("ses_legacy_ended", now, now, now);
    } finally {
      legacyDatabase.close();
    }

    const sqlite = openObserverSqlite({ path, clock: { now: () => new Date(now) } });
    try {
      const persistence = createSqliteObserverPersistence({
        sqlite,
        clock: { now: () => new Date(now) },
      });
      expect(sqlite.health().schemaVersion).toBe(latestSchemaVersion);
      await expect(persistence.listSessions()).resolves.toEqual([
        expect.objectContaining({ id: "ses_legacy_close", lifecycle: "legacy" }),
        expect.objectContaining({ id: "ses_legacy_conflict", lifecycle: "legacy" }),
        expect.objectContaining({
          id: "ses_legacy_ended",
          lifecycle: "ended",
          endedAt: now,
        }),
        expect.objectContaining({ id: "ses_legacy_unknown", lifecycle: "legacy" }),
      ]);
      await expect(
        persistence.markSessionsEnded({
          subject: { kind: "session", sessionId: "ses_legacy_close" },
          endedAt: now,
        }),
      ).resolves.toBe(1);
      const worktree = createFakeWorktree({
        id: "wt_legacy",
        projectId: "web",
        branch: "legacy",
        now,
      });
      await persistence.persistReconcileResult({
        projects: [
          {
            id: "web",
            label: "web",
            root: "/tmp/station/web",
            defaults: {
              harness: "codex",
              terminal: "tmux",
              layout: "agent-shell",
            },
            worktrunk: { enabled: true },
          },
        ],
        worktrees: [worktree],
        terminalTargets: [
          createFakeTerminalTarget({
            id: "term_legacy_stale",
            projectId: "web",
            worktreeId: worktree.id,
            sessionId: "ses_legacy_unknown",
            state: "stale",
            now,
          }),
          createFakeTerminalTarget({
            id: "term_legacy_conflict",
            projectId: "web",
            worktreeId: worktree.id,
            sessionId: "ses_legacy_conflict",
            harnessRunId: "run_legacy_external",
            state: "open",
            now,
          }),
        ],
        harnessRuns: [
          createFakeHarnessRun({
            id: "run_legacy_bound_idle",
            provider: "codex",
            projectId: "web",
            worktreeId: worktree.id,
            sessionId: "ses_legacy_unknown",
            state: "idle",
            now,
          }),
          createFakeHarnessRun({
            id: "run_legacy_closed_stale",
            provider: "codex",
            projectId: "web",
            worktreeId: worktree.id,
            sessionId: "ses_legacy_close",
            now,
          }),
          createFakeHarnessRun({
            id: "run_legacy_external",
            provider: "codex",
            projectId: "web",
            worktreeId: worktree.id,
            state: "working",
            now,
          }),
        ],
        observedAt: now,
      });
      await expect(persistence.listSessions()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "ses_legacy_unknown", lifecycle: "legacy" }),
          expect.objectContaining({ id: "ses_legacy_conflict", lifecycle: "legacy" }),
          expect.objectContaining({
            id: "ses_legacy_close",
            lifecycle: "ended",
            endedAt: now,
          }),
        ]),
      );
      await persistence.persistReconcileResult({
        projects: [],
        worktrees: [worktree],
        terminalTargets: [],
        harnessRuns: [
          createFakeHarnessRun({
            id: "run_legacy_current",
            provider: "codex",
            projectId: "web",
            worktreeId: worktree.id,
            sessionId: "ses_legacy_unknown",
            state: "working",
            now,
          }),
        ],
        observedAt: now,
      });
      await expect(persistence.listSessions()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "ses_legacy_unknown", lifecycle: "open" }),
        ]),
      );
    } finally {
      sqlite.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("repairs the pre-merge native binding migration collision without losing bindings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "station-native-binding-migration-"));
    const path = join(directory, "observer.sqlite");
    const legacyDatabase = openSqlDatabase(path);
    try {
      for (const migration of migrations.filter(({ version }) => version < 12)) {
        legacyDatabase.exec(migration.sql);
        legacyDatabase
          .prepare("INSERT INTO observer_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, now);
      }
      legacyDatabase.exec(`
        CREATE TABLE session_harness_executions (
          provider TEXT NOT NULL,
          session_id TEXT NOT NULL,
          native_session_id TEXT NOT NULL,
          state TEXT NOT NULL,
          status_updated_at TEXT NOT NULL,
          PRIMARY KEY (provider, session_id)
        );
        INSERT INTO sessions
          (id, project_id, worktree_id, harness, created_at, ended_at, last_seen_at)
        VALUES
          ('ses_collision', 'web', 'wt_collision', 'codex',
           '2026-07-14T00:00:00.000Z', '2026-07-14T01:00:00.000Z',
           '2026-07-14T01:00:00.000Z');
        INSERT INTO session_harness_executions
          (provider, session_id, native_session_id, state, status_updated_at)
        VALUES
          ('codex', 'ses_collision', 'native_collision', 'idle',
           '2026-07-14T01:00:00.000Z');
        INSERT INTO observer_migrations (version, name, applied_at) VALUES
          (12, 'session_harness_executions', '2026-07-14T00:00:00.000Z'),
          (13, 'native_binding_ingress_claims', '2026-07-14T00:01:00.000Z');
        INSERT OR REPLACE INTO observer_meta (key, value)
          VALUES ('schema_version', '13');
      `);
    } finally {
      legacyDatabase.close();
    }

    const sqlite = openObserverSqlite({ path, clock: { now: () => new Date(now) } });
    try {
      const persistence = createSqliteObserverPersistence({
        sqlite,
        clock: { now: () => new Date(now) },
      });
      expect(
        sqlite
          .health()
          .migrations.filter(({ version }) => version >= 12)
          .map(({ version, name }) => [version, name]),
      ).toEqual([
        [12, "session_lifecycle"],
        [13, "session_harness_executions"],
        [14, "native_binding_ingress_claims"],
      ]);
      await expect(persistence.listSessions()).resolves.toEqual([
        expect.objectContaining({
          id: "ses_collision",
          lifecycle: "ended",
          endedAt: "2026-07-14T01:00:00.000Z",
        }),
      ]);
      await expect(
        persistence.getSessionHarnessExecution({
          provider: "codex",
          sessionId: "ses_collision",
        }),
      ).resolves.toMatchObject({
        nativeSessionId: "native_collision",
        state: "idle",
      });
    } finally {
      sqlite.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("exposes healthy SQLite status in addition to the seven application ports", () => {
    const sqlite = openObserverSqlite({ clock: { now: () => new Date(now) } });
    try {
      const persistence = createSqliteObserverPersistence({
        sqlite,
        clock: { now: () => new Date(now) },
      });

      expect(persistence.health()).toMatchObject({
        open: true,
        status: "healthy",
        lastCheckedAt: now,
      });
    } finally {
      sqlite.close();
    }
  });

  it("rolls back a trigger-rejected ingress write before permitting the same key to retry", async () => {
    const sqlite = openObserverSqlite({ clock: { now: () => new Date(now) } });
    try {
      const persistence = createSqliteObserverPersistence({
        sqlite,
        clock: { now: () => new Date(now) },
        idFactory: ids(),
      });
      const input: Parameters<
        IngressJournal["recordEventAndProviderObservationWithIngressDedupe"]
      >[0] = {
        event: {
          type: "providerHook.ingested",
          at: now,
          hookId: "hook_atomic",
          provider: "fake-harness",
          event: "run.updated",
        },
        eventOptions: { createdAt: now, source: "hook" },
        observation: {
          provider: "fake-harness",
          providerType: "harness",
          entityKind: "provider_health",
          entityKey: "reject-once",
          payload: {
            providerId: "fake-harness",
            providerType: "harness",
            status: "healthy",
            lastCheckedAt: now,
          },
          observedAt: now,
        },
        dedupe: { kind: "hook", id: "hook_atomic" },
      };

      sqlite.database.exec(`
        CREATE TRIGGER reject_atomic_observation
        BEFORE INSERT ON provider_observations
        WHEN NEW.entity_key = 'reject-once'
        BEGIN
          SELECT RAISE(ABORT, 'forced observation failure');
        END;
      `);

      await expect(
        persistence.recordEventAndProviderObservationWithIngressDedupe(input),
      ).rejects.toThrow("PERSISTENCE_TRANSACTION_FAILED");
      await expect(persistence.listEvents()).resolves.toEqual([]);
      await expect(
        persistence.listProviderObservations({ includeExpired: true, now }),
      ).resolves.toEqual([]);
      expect(
        sqlite.database.prepare("SELECT COUNT(*) AS count FROM hook_ingress_dedupe").get(),
      ).toMatchObject({ count: 0 });
      expect(sqlite.database.prepare("SELECT COUNT(*) AS count FROM events").get()).toMatchObject({
        count: 0,
      });
      expect(
        sqlite.database.prepare("SELECT COUNT(*) AS count FROM provider_observations").get(),
      ).toMatchObject({ count: 0 });

      sqlite.database.exec("DROP TRIGGER reject_atomic_observation");

      await expect(
        persistence.recordEventAndProviderObservationWithIngressDedupe(input),
      ).resolves.toMatchObject({
        deduped: false,
        event: { id: "atomic_evt_2" },
        observation: { id: "atomic_obs_2", entityKey: "reject-once" },
      });
      await expect(
        persistence.recordEventAndProviderObservationWithIngressDedupe(input),
      ).resolves.toEqual({ deduped: true });
    } finally {
      sqlite.close();
    }
  });

  it("rolls back a trigger-rejected processing batch before permitting the same key to retry", async () => {
    const sqlite = openObserverSqlite({ clock: { now: () => new Date(now) } });
    try {
      const persistence = createSqliteObserverPersistence({
        sqlite,
        clock: { now: () => new Date(now) },
        idFactory: ids(),
      });
      const observation = {
        provider: "fake-harness",
        providerType: "harness" as const,
        entityKind: "provider_health" as const,
        entityKey: "reject-processing-once",
        payload: {
          providerId: "fake-harness",
          providerType: "harness" as const,
          status: "healthy" as const,
          lastCheckedAt: now,
        },
        observedAt: now,
      };
      const input: Parameters<IngressJournal["recordProviderObservationsWithIngressDedupe"]>[0] = {
        observations: [observation],
        dedupe: { kind: "hook_processing", id: "hook_processing_atomic" },
        createdAt: now,
      };
      sqlite.database.exec(`
        CREATE TRIGGER reject_processing_observation
        BEFORE INSERT ON provider_observations
        WHEN NEW.entity_key = 'reject-processing-once'
        BEGIN
          SELECT RAISE(ABORT, 'forced processing failure');
        END;
      `);

      await expect(persistence.recordProviderObservationsWithIngressDedupe(input)).rejects.toThrow(
        "PERSISTENCE_TRANSACTION_FAILED",
      );
      expect(
        sqlite.database
          .prepare("SELECT COUNT(*) AS count FROM hook_ingress_dedupe WHERE kind = ?")
          .get("hook_processing"),
      ).toMatchObject({ count: 0 });
      sqlite.database.exec("DROP TRIGGER reject_processing_observation");

      await expect(
        persistence.recordProviderObservationsWithIngressDedupe(input),
      ).resolves.toMatchObject({
        deduped: false,
        observations: [{ entityKey: "reject-processing-once" }],
      });
      await expect(persistence.recordProviderObservationsWithIngressDedupe(input)).resolves.toEqual(
        { deduped: true },
      );
    } finally {
      sqlite.close();
    }
  });
});

function ids() {
  let event = 0;
  let observation = 0;
  return {
    eventId: () => `atomic_evt_${++event}`,
    observationId: () => `atomic_obs_${++observation}`,
  };
}
