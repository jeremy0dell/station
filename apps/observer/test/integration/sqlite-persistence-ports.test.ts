import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StationEventSchema, TerminalTargetObservationSchema } from "@station/contracts";
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
  it("upgrades a version-16 database and preserves Groups across reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "station-session-groups-v16-"));
    const path = join(directory, "observer.sqlite");
    const legacyDatabase = openSqlDatabase(path);
    try {
      for (const migration of migrations.filter(({ version }) => version <= 16)) {
        legacyDatabase.exec(migration.sql);
        legacyDatabase
          .prepare("INSERT INTO observer_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, now);
      }
      legacyDatabase
        .prepare(
          "INSERT OR REPLACE INTO observer_meta (key, value) VALUES ('schema_version', '16')",
        )
        .run();
    } finally {
      legacyDatabase.close();
    }

    const upgraded = openObserverSqlite({ path, clock: { now: () => new Date(now) } });
    try {
      expect(upgraded.health().schemaVersion).toBe(latestSchemaVersion);
      const persistence = createSqliteObserverPersistence({ sqlite: upgraded });
      await persistence.createSessionGroup({
        id: "group_durable",
        projectId: "web",
        name: "Durable",
        initialMembers: [{ sessionId: "ses_durable", projectId: "web", expectedGroupId: null }],
        createdAt: now,
      });
    } finally {
      upgraded.close();
    }

    const reopened = openObserverSqlite({ path });
    try {
      const persistence = createSqliteObserverPersistence({ sqlite: reopened });
      await expect(persistence.listSessionGroups()).resolves.toEqual([
        expect.objectContaining({
          id: "group_durable",
          sessionIds: ["ses_durable"],
          version: 1,
        }),
      ]);
    } finally {
      reopened.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves legacy result-less successes and rejects corrupted command results after v18", async () => {
    const directory = await mkdtemp(join(tmpdir(), "station-command-results-v17-"));
    const path = join(directory, "observer.sqlite");
    const legacyDatabase = openSqlDatabase(path);
    try {
      for (const migration of migrations.filter(({ version }) => version <= 17)) {
        legacyDatabase.exec(migration.sql);
        legacyDatabase
          .prepare("INSERT INTO observer_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, now);
      }
      legacyDatabase
        .prepare(
          `
            INSERT INTO commands
              (id, type, payload_json, status, created_at, started_at, finished_at)
            VALUES (?, ?, ?, 'succeeded', ?, ?, ?)
          `,
        )
        .run(
          "cmd_legacy_resultless",
          "worktree.create",
          JSON.stringify({
            type: "worktree.create",
            payload: { projectId: "web", branch: "legacy-resultless" },
          }),
          now,
          now,
          now,
        );
      legacyDatabase
        .prepare(
          "INSERT OR REPLACE INTO observer_meta (key, value) VALUES ('schema_version', '17')",
        )
        .run();
    } finally {
      legacyDatabase.close();
    }

    const sqlite = openObserverSqlite({ path, clock: { now: () => new Date(now) } });
    try {
      const persistence = createSqliteObserverPersistence({ sqlite });
      expect(sqlite.health().schemaVersion).toBe(latestSchemaVersion);
      const legacyCommand = await persistence.getCommand("cmd_legacy_resultless");
      expect(legacyCommand).toMatchObject({
        id: "cmd_legacy_resultless",
        type: "worktree.create",
        status: "succeeded",
      });
      expect(legacyCommand).not.toHaveProperty("result");

      const expectCorruptRowIsQuarantined = async () => {
        await expect(persistence.getCommand("cmd_legacy_resultless")).rejects.toThrow(
          "PERSISTENCE_TRANSACTION_FAILED",
        );
        await expect(persistence.listCommands()).resolves.toEqual([]);
      };

      sqlite.database
        .prepare("UPDATE commands SET status = 'failed', result_json = ? WHERE id = ?")
        .run(
          JSON.stringify({
            type: "worktree.create",
            projectId: "web",
            worktreeId: "wt_impossible",
          }),
          "cmd_legacy_resultless",
        );
      await expectCorruptRowIsQuarantined();

      sqlite.database
        .prepare("UPDATE commands SET status = 'succeeded', result_json = ? WHERE id = ?")
        .run(
          JSON.stringify({
            type: "sessionGroup.create",
            projectId: "web",
            groupId: "grp_unrelated",
            version: 1,
          }),
          "cmd_legacy_resultless",
        );
      await expectCorruptRowIsQuarantined();

      sqlite.database
        .prepare("UPDATE commands SET result_json = ? WHERE id = ?")
        .run("{malformed", "cmd_legacy_resultless");
      await expectCorruptRowIsQuarantined();

      sqlite.database
        .prepare("UPDATE commands SET type = ?, result_json = NULL WHERE id = ?")
        .run("terminal.focus", "cmd_legacy_resultless");
      await expectCorruptRowIsQuarantined();
    } finally {
      sqlite.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("drops legacy provider health observations when upgrading a version-18 database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "station-provider-health-v18-"));
    const path = join(directory, "observer.sqlite");
    const legacyDatabase = openSqlDatabase(path);
    try {
      for (const migration of migrations.filter(({ version }) => version <= 18)) {
        legacyDatabase.exec(migration.sql);
        legacyDatabase
          .prepare("INSERT INTO observer_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, now);
      }
      const insert = legacyDatabase.prepare(`
        INSERT INTO provider_observations
          (id, provider, provider_type, entity_kind, entity_key, payload_json, observed_at)
        VALUES (?, 'fake-harness', 'observer', ?, ?, ?, ?)
      `);
      insert.run(
        "obs_legacy_health",
        "provider_health",
        "fake-harness",
        JSON.stringify({
          providerId: "fake-harness",
          providerType: "harness",
          status: "healthy",
          lastCheckedAt: now,
        }),
        now,
      );
      insert.run("obs_worktree", "worktree", "wt_web", "{}", now);
    } finally {
      legacyDatabase.close();
    }

    const upgraded = openObserverSqlite({ path, clock: { now: () => new Date(now) } });
    try {
      expect(upgraded.health()).toMatchObject({
        schemaVersion: latestSchemaVersion,
        migrations: expect.arrayContaining([
          expect.objectContaining({
            version: 19,
            name: "drop_legacy_provider_health_observations",
          }),
        ]),
      });
      expect(
        upgraded.database
          .prepare("SELECT entity_kind FROM provider_observations ORDER BY entity_kind")
          .all(),
      ).toEqual([{ entity_kind: "worktree" }]);
    } finally {
      upgraded.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("renames persisted terminal focus evidence when upgrading a version-19 database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "station-terminal-focus-v19-"));
    const path = join(directory, "observer.sqlite");
    const legacyDatabase = openSqlDatabase(path);
    const legacyTerminal = (focusable?: boolean) => ({
      provider: "tmux",
      state: "open",
      ...(focusable === undefined ? {} : { focusable }),
    });
    const legacyRow = (focusable: boolean) => ({
      id: "wt_legacy",
      projectId: "web",
      projectLabel: "Web",
      title: "Legacy",
      branch: "legacy",
      path: "/tmp/legacy",
      worktree: { state: "exists", source: "worktrunk" },
      terminal: legacyTerminal(focusable),
      display: { statusLabel: "idle", sortPriority: 40, alert: false },
    });
    const legacySession = (focusable: boolean) => ({
      id: "ses_legacy",
      origin: "external",
      projectId: "web",
      worktreeId: "wt_legacy",
      createdAt: now,
      updatedAt: now,
      harness: {
        provider: "codex",
        mode: "interactive",
        capabilities: {
          canLaunch: false,
          canDiscoverRuns: false,
          canEmitEvents: false,
          canReceivePrompt: false,
          canResume: false,
          canStop: false,
          canRunNonInteractive: false,
          canExposeApprovalState: false,
          supportsModifiedEnterSoftNewline: false,
        },
      },
      terminal: legacyTerminal(focusable),
      status: {
        value: "idle",
        confidence: "high",
        reason: "Legacy persisted session.",
        source: "harness_process",
        updatedAt: now,
      },
      title: "Legacy",
      tags: [],
    });
    try {
      for (const migration of migrations.filter(({ version }) => version <= 19)) {
        legacyDatabase.exec(migration.sql);
        legacyDatabase
          .prepare("INSERT INTO observer_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, now);
      }
      const insertObservation = legacyDatabase.prepare(`
        INSERT INTO provider_observations
          (id, provider, provider_type, entity_kind, entity_key, payload_json, observed_at)
        VALUES (?, 'tmux', 'terminal', 'terminal_target', ?, ?, ?)
      `);
      for (const [suffix, focusable] of [
        ["true", true],
        ["false", false],
        ["absent", undefined],
      ] as const) {
        insertObservation.run(
          `obs_${suffix}`,
          `term_${suffix}`,
          JSON.stringify({
            id: `term_${suffix}`,
            ...legacyTerminal(focusable),
            confidence: "high",
            reason: "Legacy terminal observation.",
            observedAt: now,
          }),
          now,
        );
      }
      const insertEvent = legacyDatabase.prepare(`
        INSERT INTO events (id, type, source, payload_json, created_at)
        VALUES (?, ?, 'test', ?, ?)
      `);
      const events = [
        ["evt_worktree_added", "worktree.added", { type: "worktree.added", row: legacyRow(true) }],
        [
          "evt_worktree_updated",
          "worktree.updated",
          {
            type: "worktree.updated",
            worktreeId: "wt_legacy",
            patch: { terminal: legacyTerminal(false) },
          },
        ],
        [
          "evt_session_created",
          "session.created",
          { type: "session.created", session: legacySession(true) },
        ],
        [
          "evt_session_updated",
          "session.updated",
          {
            type: "session.updated",
            sessionId: "ses_legacy",
            patch: { terminal: legacyTerminal(false) },
          },
        ],
      ] as const;
      for (const [id, type, event] of events) {
        insertEvent.run(id, type, JSON.stringify(event), now);
      }
      legacyDatabase
        .prepare(
          "INSERT OR REPLACE INTO observer_meta (key, value) VALUES ('schema_version', '19')",
        )
        .run();
    } finally {
      legacyDatabase.close();
    }

    const upgraded = openObserverSqlite({ path, clock: { now: () => new Date(now) } });
    try {
      expect(upgraded.health()).toMatchObject({
        schemaVersion: 20,
        migrations: expect.arrayContaining([
          expect.objectContaining({ version: 20, name: "rename_terminal_external_focus" }),
        ]),
      });
      const observations = upgraded.database
        .prepare("SELECT payload_json FROM provider_observations ORDER BY id")
        .all() as Array<{ payload_json: string }>;
      const parsedObservations = observations.map(({ payload_json }) => {
        const raw = JSON.parse(payload_json) as Record<string, unknown>;
        expect(raw).not.toHaveProperty("focusable");
        return TerminalTargetObservationSchema.parse(raw);
      });
      expect(parsedObservations.map(({ externallyFocusable }) => externallyFocusable)).toEqual([
        undefined,
        false,
        true,
      ]);

      const persistedEvents = upgraded.database
        .prepare("SELECT payload_json FROM events ORDER BY id")
        .all() as Array<{ payload_json: string }>;
      const parsedEvents = persistedEvents.map(({ payload_json }) =>
        StationEventSchema.parse(JSON.parse(payload_json)),
      );
      expect(parsedEvents).toHaveLength(4);
      expect(
        persistedEvents.every(({ payload_json }) => !payload_json.includes('"focusable"')),
      ).toBe(true);
      expect(persistedEvents.map(({ payload_json }) => JSON.parse(payload_json))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "worktree.updated",
            patch: expect.objectContaining({
              terminal: expect.objectContaining({ externallyFocusable: false }),
            }),
          }),
          expect.objectContaining({
            type: "worktree.added",
            row: expect.objectContaining({
              terminal: expect.objectContaining({ externallyFocusable: true }),
            }),
          }),
          expect.objectContaining({
            type: "session.created",
            session: expect.objectContaining({
              terminal: expect.objectContaining({ externallyFocusable: true }),
            }),
          }),
          expect.objectContaining({
            type: "session.updated",
            patch: expect.objectContaining({
              terminal: expect.objectContaining({ externallyFocusable: false }),
            }),
          }),
        ]),
      );
    } finally {
      upgraded.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rolls back a trigger-rejected membership reassignment", async () => {
    const sqlite = openObserverSqlite();
    try {
      const persistence = createSqliteObserverPersistence({ sqlite });
      await persistence.createSessionGroup({
        id: "group_source",
        projectId: "web",
        name: "Source",
        initialMembers: [{ sessionId: "ses_atomic", projectId: "web", expectedGroupId: null }],
        createdAt: now,
      });
      await persistence.createSessionGroup({
        id: "group_target",
        projectId: "web",
        name: "Target",
        createdAt: now,
      });
      sqlite.database.exec(`
        CREATE TRIGGER reject_group_target_membership
        BEFORE INSERT ON session_group_memberships
        WHEN NEW.group_id = 'group_target'
        BEGIN
          SELECT RAISE(ABORT, 'forced Group membership failure');
        END;
      `);

      await expect(
        persistence.updateSessionGroupMembership({
          id: "group_target",
          expectedVersion: 1,
          add: [
            {
              sessionId: "ses_atomic",
              projectId: "web",
              expectedGroupId: "group_source",
            },
          ],
          updatedAt: "2026-05-20T12:01:00.000Z",
        }),
      ).rejects.toBeDefined();
      await expect(persistence.listSessionGroups()).resolves.toEqual([
        expect.objectContaining({
          id: "group_source",
          sessionIds: ["ses_atomic"],
          version: 1,
        }),
        expect.objectContaining({ id: "group_target", sessionIds: [], version: 1 }),
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("serves pure reads while another connection reserves the writer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "station-pure-read-contention-"));
    const path = join(directory, "observer.sqlite");
    const sqlite = openObserverSqlite({ path, clock: { now: () => new Date(now) } });
    const persistence = createSqliteObserverPersistence({
      sqlite,
      clock: { now: () => new Date(now) },
    });
    await persistence.recordCommandAccepted({
      commandId: "cmd_pure_read",
      command: { type: "observer.reconcile", payload: { reason: "pure-read" } },
      createdAt: now,
    });
    const writer = openSqlDatabase(path);
    try {
      const writesBeforeInventory = (
        sqlite.database.prepare("SELECT total_changes() AS value").get() as { value: number }
      ).value;
      writer.exec("BEGIN IMMEDIATE");
      await expect(persistence.readRecoveryInventory()).resolves.toEqual({
        sessions: [],
        recoveryHandles: [],
      });
      expect(
        (sqlite.database.prepare("SELECT total_changes() AS value").get() as { value: number })
          .value,
      ).toBe(writesBeforeInventory);
      await expect(persistence.getCommand("cmd_pure_read")).resolves.toEqual(
        expect.objectContaining({ id: "cmd_pure_read", status: "accepted" }),
      );
      await expect(persistence.listCommands()).resolves.toEqual([
        expect.objectContaining({ id: "cmd_pure_read", status: "accepted" }),
      ]);
      const emptyReads = [
        () => persistence.listCommandErrors("cmd_pure_read"),
        () => persistence.listEvents(),
        () => persistence.listProviderObservations(),
        () => persistence.listWorktreeMetadataCurrent(),
        () => persistence.listSessions(),
        () => persistence.listSessionGroups(),
        () => persistence.listWorktreeDisplayTitles(),
        () => persistence.listSessionHarnessExecutions(),
        () => persistence.listSessionRecoveryHandles(),
        () => persistence.listSessionTurnReadiness(),
      ];
      for (const read of emptyReads) await expect(read()).resolves.toEqual([]);
      await expect(
        persistence.getSessionHarnessExecution({ provider: "codex", sessionId: "ses_missing" }),
      ).resolves.toBeUndefined();
      await expect(persistence.getSession("ses_missing")).resolves.toBeUndefined();
      await expect(
        persistence.findRememberedHarnessProviderForWorktree({
          projectId: "web",
          worktreeId: "wt_missing",
          worktreePath: "/tmp/station/web/missing",
        }),
      ).resolves.toBeUndefined();
      await expect(
        persistence.getSessionRecoveryHandle("recovery_missing"),
      ).resolves.toBeUndefined();
      expect(persistence.health()).toMatchObject({ status: "healthy" });
      await expect(persistence.recordEvent({ type: "observer.started", at: now })).rejects.toThrow(
        "PERSISTENCE_TRANSACTION_FAILED",
      );
      writer.exec("ROLLBACK");
    } finally {
      writer.close();
      sqlite.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

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
          expect.objectContaining({ id: "ses_legacy_unknown", lifecycle: "legacy" }),
        ]),
      );
    } finally {
      sqlite.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("backfills canonical title authority without rewriting historical session rows", async () => {
    const directory = await mkdtemp(join(tmpdir(), "station-worktree-title-migration-"));
    const path = join(directory, "observer.sqlite");
    const legacyDatabase = openSqlDatabase(path);
    try {
      for (const migration of migrations.filter(({ version }) => version < 16)) {
        legacyDatabase.exec(migration.sql);
        legacyDatabase
          .prepare("INSERT INTO observer_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, now);
      }
      const insert = legacyDatabase.prepare(`
        INSERT INTO sessions
          (id, project_id, worktree_id, title, created_at, last_seen_at, lifecycle)
        VALUES (?, 'web', 'wt_title_migration', ?, ?, ?, 'open')
      `);
      insert.run(
        "ses_custom",
        "Readable migration title",
        "2026-05-20T11:58:00.000Z",
        "2026-05-20T11:59:00.000Z",
      );
      insert.run("ses_branch", "feature/current", now, now);
    } finally {
      legacyDatabase.close();
    }

    const sqlite = openObserverSqlite({ path, clock: { now: () => new Date(now) } });
    try {
      const persistence = createSqliteObserverPersistence({
        sqlite,
        clock: { now: () => new Date(now) },
      });
      await expect(persistence.listWorktreeDisplayTitles()).resolves.toEqual([]);
      await persistence.persistReconcileResult({
        worktrees: [
          createFakeWorktree({
            id: "wt_title_migration",
            projectId: "web",
            branch: "feature/current",
            now,
          }),
        ],
        terminalTargets: [],
        harnessRuns: [],
        observedAt: now,
      });

      await expect(persistence.listWorktreeDisplayTitles()).resolves.toEqual([
        {
          projectId: "web",
          worktreeId: "wt_title_migration",
          title: "Readable migration title",
          createdAt: now,
          updatedAt: now,
        },
      ]);
      expect((await persistence.listSessions()).map((session) => session.title)).toEqual([
        "feature/current",
        "Readable migration title",
      ]);
    } finally {
      sqlite.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("drops obsolete recovery breadcrumb storage from fresh and version-14 databases", async () => {
    const directory = await mkdtemp(join(tmpdir(), "station-recovery-breadcrumb-migration-"));
    const path = join(directory, "observer.sqlite");
    const legacyDatabase = openSqlDatabase(path);
    try {
      for (const migration of migrations.filter(({ version }) => version < 15)) {
        legacyDatabase.exec(migration.sql);
        legacyDatabase
          .prepare("INSERT INTO observer_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, now);
      }
      legacyDatabase
        .prepare(`
          INSERT INTO recovery_breadcrumbs
            (id, project_id, worktree_id, session_id, location, path, payload_json,
             created_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          "breadcrumb_legacy",
          "web",
          "wt_web_main",
          "ses_web_main",
          "external",
          "/tmp/recovery.json",
          "{}",
          now,
          now,
        );
    } finally {
      legacyDatabase.close();
    }

    const upgraded = openObserverSqlite({ path, clock: { now: () => new Date(now) } });
    try {
      expect(upgraded.health().schemaVersion).toBe(latestSchemaVersion);
      expect(
        upgraded.database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get("recovery_breadcrumbs"),
      ).toBeUndefined();
    } finally {
      upgraded.close();
      await rm(directory, { recursive: true, force: true });
    }

    const fresh = openObserverSqlite({ clock: { now: () => new Date(now) } });
    try {
      expect(fresh.health().schemaVersion).toBe(latestSchemaVersion);
      expect(
        fresh.database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get("recovery_breadcrumbs"),
      ).toBeUndefined();
    } finally {
      fresh.close();
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
        [15, "drop_recovery_breadcrumbs"],
        [16, "worktree_display_titles"],
        [17, "session_groups"],
        [18, "command_results"],
        [19, "drop_legacy_provider_health_observations"],
        [20, "rename_terminal_external_focus"],
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

  it("exposes healthy SQLite status in addition to the nine application ports", () => {
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
            provider: "fake-harness",
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
          provider: "fake-harness",
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
