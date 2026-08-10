import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StationConfig } from "@station/config";
import { StationSnapshotSchema } from "@station/contracts";
import {
  createFakeHarnessRun,
  createFakeTerminalTarget,
  createFakeWorktree,
  FakeHarnessProvider,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "@station/testing";
import { describe, expect, it, vi } from "vitest";
import { createObserverCore, ProviderRegistry } from "../../src/internal";
import { createSqliteObserverPersistence } from "../../src/persistence";
import { openObserverSqlite } from "../../src/sqlite";
import { createTestObserver, createTestObserverCore } from "../support/testObserver";

const now = "2026-05-20T12:00:00.000Z";

const config: StationConfig = {
  schemaVersion: 1,
  defaults: {
    worktreeProvider: "fake-worktree",
    terminal: "fake-terminal",
    harness: "fake-harness",
    layout: "agent-shell",
  },
  projects: [
    {
      id: "web",
      label: "web",
      root: "/tmp/station/web",
      defaults: {
        harness: "fake-harness",
        terminal: "fake-terminal",
        layout: "agent-shell",
      },
      worktrunk: {
        enabled: true,
      },
    },
  ],
};

function ids() {
  let event = 0;
  let observation = 0;
  return {
    eventId: () => {
      event += 1;
      return `evt_${event}`;
    },
    observationId: () => {
      observation += 1;
      return `obs_${observation}`;
    },
  };
}

async function tempDbPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "station-reconcile-db-")), "observer.sqlite");
}

function providersWithOneSession() {
  return new ProviderRegistry({
    worktree: new FakeWorktreeProvider({
      now,
      worktrees: [createFakeWorktree({ id: "wt_web_main", projectId: "web", now })],
    }),
    terminal: new FakeTerminalProvider({
      now,
      targets: [
        createFakeTerminalTarget({
          id: "term_web_main",
          projectId: "web",
          worktreeId: "wt_web_main",
          sessionId: "ses_web_main",
          harnessRunId: "run_web_main",
          now,
        }),
      ],
    }),
    harnesses: [
      new FakeHarnessProvider({
        now,
        runs: [
          createFakeHarnessRun({
            id: "run_web_main",
            projectId: "web",
            worktreeId: "wt_web_main",
            sessionId: "ses_web_main",
            state: "working",
            now,
          }),
        ],
      }),
    ],
  });
}

describe("observer reconcile persistence", () => {
  it("prunes missing and cross-project Group members once while preserving definitions", async () => {
    const groupConfig: StationConfig = {
      ...config,
      projects: [
        ...config.projects,
        {
          id: "api",
          label: "api",
          root: "/tmp/station/api",
          defaults: {
            harness: "fake-harness",
            terminal: "fake-terminal",
            layout: "agent-shell",
          },
          worktrunk: { enabled: true },
        },
      ],
    };
    const sessions = [
      { projectId: "web", worktreeId: "wt_web_main", sessionId: "ses_web_main" },
      { projectId: "api", worktreeId: "wt_api_main", sessionId: "ses_api_main" },
    ];
    const providers = new ProviderRegistry({
      worktree: new FakeWorktreeProvider({
        now,
        worktrees: sessions.map(({ projectId, worktreeId }) =>
          createFakeWorktree({ id: worktreeId, projectId, now }),
        ),
      }),
      terminal: new FakeTerminalProvider({
        now,
        targets: sessions.map(({ projectId, worktreeId, sessionId }) =>
          createFakeTerminalTarget({
            id: `term_${sessionId}`,
            projectId,
            worktreeId,
            sessionId,
            harnessRunId: `run_${sessionId}`,
            now,
          }),
        ),
      }),
      harnesses: [
        new FakeHarnessProvider({
          now,
          runs: sessions.map(({ projectId, worktreeId, sessionId }) =>
            createFakeHarnessRun({
              id: `run_${sessionId}`,
              projectId,
              worktreeId,
              sessionId,
              state: "idle",
              now,
            }),
          ),
        }),
      ],
    });
    const { sqlite, persistence, core } = createTestObserverCore({
      config: groupConfig,
      providers,
      clock: { now: () => new Date(now) },
    });
    await persistence.createSessionGroup({
      id: "grp_missing_member",
      projectId: "web",
      name: "Missing member",
      initialMembers: [
        { sessionId: "ses_web_main", projectId: "web", expectedGroupId: null },
        { sessionId: "ses_missing", projectId: "web", expectedGroupId: null },
      ],
      createdAt: now,
    });
    await persistence.createSessionGroup({
      id: "grp_cross_project_member",
      projectId: "web",
      name: "Cross project member",
      initialMembers: [{ sessionId: "ses_api_main", projectId: "web", expectedGroupId: null }],
      createdAt: now,
    });

    const snapshot = await core.reconcile("session-group-prune");

    expect(snapshot.sessionGroups).toEqual([
      expect.objectContaining({
        id: "grp_cross_project_member",
        version: 2,
        sessionIds: [],
      }),
      expect.objectContaining({
        id: "grp_missing_member",
        version: 2,
        sessionIds: ["ses_web_main"],
      }),
    ]);
    expect(core.getHealth().lastReconcile?.errors).toEqual([
      expect.objectContaining({
        code: "SESSION_GROUP_MEMBERSHIP_REPAIRED",
        projectId: "web",
      }),
      expect.objectContaining({
        code: "SESSION_GROUP_MEMBERSHIP_REPAIRED",
        projectId: "web",
      }),
    ]);
    await core.reconcile("session-group-prune-repeat");
    expect((await persistence.listSessionGroups()).map((group) => group.version)).toEqual([2, 2]);
    sqlite.close();
  });

  it("repairs missing, cross-project, and cyclic Group parentage deterministically", async () => {
    const groupConfig: StationConfig = {
      ...config,
      projects: [
        ...config.projects,
        {
          id: "api",
          label: "api",
          root: "/tmp/station/api",
          defaults: {
            harness: "fake-harness",
            terminal: "fake-terminal",
            layout: "agent-shell",
          },
          worktrunk: { enabled: true },
        },
      ],
    };
    const { sqlite, persistence, core } = createTestObserverCore({
      config: groupConfig,
      providers: providersWithOneSession(),
      clock: { now: () => new Date(now) },
    });
    await persistence.createSessionGroup({
      id: "grp_a_combined",
      projectId: "web",
      name: "Combined",
      initialMembers: [{ sessionId: "ses_missing", projectId: "web", expectedGroupId: null }],
      createdAt: now,
    });
    for (const [id, projectId] of [
      ["grp_b_cross", "web"],
      ["grp_c_api_parent", "api"],
      ["grp_d_self", "web"],
      ["grp_e_cycle_a", "web"],
      ["grp_e_cycle_b", "web"],
      ["grp_f_descendant", "web"],
    ] as const) {
      await persistence.createSessionGroup({ id, projectId, name: id, createdAt: now });
    }
    const setParent = sqlite.database.prepare(
      "UPDATE session_groups SET parent_group_id = ? WHERE id = ?",
    );
    setParent.run("grp_missing", "grp_a_combined");
    setParent.run("grp_c_api_parent", "grp_b_cross");
    setParent.run("grp_d_self", "grp_d_self");
    setParent.run("grp_e_cycle_b", "grp_e_cycle_a");
    setParent.run("grp_e_cycle_a", "grp_e_cycle_b");
    setParent.run("grp_e_cycle_a", "grp_f_descendant");

    const snapshot = await core.reconcile("session-group-parent-repair");
    expect(() => StationSnapshotSchema.parse(snapshot)).not.toThrow();
    const groups = new Map(snapshot.sessionGroups.map((group) => [group.id, group]));
    for (const id of [
      "grp_a_combined",
      "grp_b_cross",
      "grp_d_self",
      "grp_e_cycle_a",
      "grp_e_cycle_b",
    ]) {
      expect(groups.get(id)).not.toHaveProperty("parentGroupId");
      expect(groups.get(id)).toMatchObject({ version: 2 });
    }
    expect(groups.get("grp_a_combined")).toMatchObject({ sessionIds: [] });
    expect(groups.get("grp_f_descendant")).toMatchObject({
      parentGroupId: "grp_e_cycle_a",
      version: 1,
    });
    expect(groups.get("grp_c_api_parent")).toMatchObject({ version: 1 });
    expect(core.getHealth().lastReconcile?.errors.map((error) => error.code)).toEqual([
      "SESSION_GROUP_MEMBERSHIP_REPAIRED",
      "SESSION_GROUP_PARENT_MISSING_REPAIRED",
      "SESSION_GROUP_PARENT_PROJECT_REPAIRED",
      "SESSION_GROUP_PARENT_CYCLE_REPAIRED",
      "SESSION_GROUP_PARENT_CYCLE_REPAIRED",
      "SESSION_GROUP_PARENT_CYCLE_REPAIRED",
    ]);

    const repeated = await core.reconcile("session-group-parent-repair-repeat");
    expect(() => StationSnapshotSchema.parse(repeated)).not.toThrow();
    expect((await persistence.listSessionGroups()).map((group) => group.version)).toEqual([
      1, 2, 2, 2, 2, 2, 1,
    ]);
    expect(
      core.getHealth().lastReconcile?.errors.filter((error) => error.code.includes("_REPAIRED")),
    ).toEqual([]);
    sqlite.close();
  });

  it("rolls back the complete Group relationship repair when a later write fails", async () => {
    const { sqlite, persistence } = createTestObserverCore({
      config,
      providers: providersWithOneSession(),
      clock: { now: () => new Date(now) },
    });
    for (const id of ["grp_a", "grp_b"]) {
      await persistence.createSessionGroup({
        id,
        projectId: "web",
        name: id,
        createdAt: now,
      });
    }
    sqlite.database.exec(`
      UPDATE session_groups SET parent_group_id = 'missing' WHERE id IN ('grp_a', 'grp_b');
      CREATE TRIGGER reject_group_b_repair
      BEFORE UPDATE ON session_groups
      WHEN OLD.id = 'grp_b'
      BEGIN
        SELECT RAISE(ABORT, 'forced Group repair failure');
      END;
    `);

    await expect(
      persistence.repairSessionGroups({ sessions: [], updatedAt: "2026-05-20T12:01:00.000Z" }),
    ).rejects.toBeDefined();
    expect(
      sqlite.database
        .prepare("SELECT id, parent_group_id, version FROM session_groups ORDER BY id")
        .all(),
    ).toEqual([
      { id: "grp_a", parent_group_id: "missing", version: 1 },
      { id: "grp_b", parent_group_id: "missing", version: 1 },
    ]);
    sqlite.close();
  });

  it("preserves empty Groups and retains excluded-project definitions outside the snapshot", async () => {
    const { sqlite, persistence, core } = createTestObserverCore({
      config,
      providers: providersWithOneSession(),
      clock: { now: () => new Date(now) },
    });
    await persistence.createSessionGroup({
      id: "grp_web_empty",
      projectId: "web",
      name: "Configured",
      createdAt: now,
    });
    await persistence.createSessionGroup({
      id: "grp_removed_empty",
      projectId: "removed",
      name: "Retained",
      createdAt: now,
    });
    sqlite.database
      .prepare("UPDATE session_groups SET parent_group_id = ? WHERE id = ?")
      .run("grp_missing", "grp_removed_empty");

    const snapshot = await core.reconcile("session-group-excluded-project");

    expect(snapshot.sessionGroups).toEqual([
      expect.objectContaining({ id: "grp_web_empty", sessionIds: [], version: 1 }),
    ]);
    await expect(persistence.listSessionGroups()).resolves.toEqual([
      expect.objectContaining({ id: "grp_removed_empty", projectId: "removed", version: 2 }),
      expect.objectContaining({ id: "grp_web_empty", projectId: "web" }),
    ]);
    expect((await persistence.listSessionGroups())[0]).not.toHaveProperty("parentGroupId");
    expect(core.getHealth().lastReconcile?.errors).toContainEqual(
      expect.objectContaining({
        code: "SESSION_GROUP_PARENT_MISSING_REPAIRED",
        projectId: "removed",
      }),
    );
    expect(core.getHealth().lastReconcile?.errors).toContainEqual(
      expect.objectContaining({
        code: "SESSION_GROUP_PROJECT_EXCLUDED",
        projectId: "removed",
      }),
    );
    sqlite.close();
  });

  it("persists provider observations, session correlations, and reconcile events", async () => {
    const dbPath = await tempDbPath();
    const providers = providersWithOneSession();
    const { sqlite, persistence, core } = createTestObserverCore({
      config,
      providers,
      clock: { now: () => new Date(now) },
      sqlitePath: dbPath,
    });

    // Warm the health cache so both reconciles persist identical health rows.
    await providers.healthCache.refreshAll();
    const snapshot = await core.reconcile("persistence-test");

    expect(snapshot.rows.map((row) => row.id)).toEqual(["wt_web_main"]);
    expect(await persistence.listSessions()).toEqual([
      expect.objectContaining({
        id: "ses_web_main",
        state: "working",
      }),
    ]);
    const observations = await persistence.listProviderObservations();
    expect(observations.map((item) => item.entityKind)).toEqual([
      "worktree",
      "terminal_target",
      "harness_run",
      "provider_health",
      "provider_health",
      "provider_health",
    ]);
    expect(observations.map((item) => item.expiresAt)).toEqual([
      "2026-06-03T12:00:00.000Z",
      "2026-06-03T12:00:00.000Z",
      "2026-06-03T12:00:00.000Z",
      "2026-06-03T12:00:00.000Z",
      "2026-06-03T12:00:00.000Z",
      "2026-06-03T12:00:00.000Z",
    ]);
    await core.reconcile("persistence-test-repeat");
    expect(await persistence.listProviderObservations()).toHaveLength(observations.length);
    const reconcileEvents = await persistence.listEvents({ type: "observer.reconciled" });
    expect(reconcileEvents).toHaveLength(2);
    expect(reconcileEvents[0]).toEqual(
      expect.objectContaining({
        type: "observer.reconciled",
        event: {
          type: "observer.reconciled",
          at: now,
          changed: 0,
        },
      }),
    );
    sqlite.close();

    const reopened = openObserverSqlite({ path: dbPath, clock: { now: () => new Date(now) } });
    const reloaded = createSqliteObserverPersistence({ sqlite: reopened, idFactory: ids() });
    expect(await reloaded.listSessions()).toEqual([
      expect.objectContaining({
        id: "ses_web_main",
        worktreeId: "wt_web_main",
      }),
    ]);
    reopened.close();
  });

  it("persists 'unknown' provider health before the first background probe lands", async () => {
    const { sqlite, persistence, core } = createTestObserverCore({
      config,
      providers: providersWithOneSession(),
      clock: { now: () => new Date(now) },
    });

    const snapshot = await core.reconcile("cold-health-cache");

    expect(StationSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.observer.healthy).toBe(true);
    expect(Object.values(snapshot.providerHealth).map((health) => health.status)).toEqual([
      "unknown",
      "unknown",
      "unknown",
    ]);
    const observations = await persistence.listProviderObservations();
    const healthRows = observations.filter((item) => item.entityKind === "provider_health");
    expect(healthRows.map((row) => row.payload.status)).toEqual(["unknown", "unknown", "unknown"]);
    sqlite.close();
  });

  it("publishes completed provider probes without another reconcile", async () => {
    let currentTime = now;
    let healthStatus: "healthy" | "unavailable" = "unavailable";
    const providers = providersWithOneSession();
    vi.spyOn(providers.worktree, "health").mockImplementation(async () => ({
      providerId: providers.worktree.id,
      providerType: "worktree",
      status: healthStatus,
      lastCheckedAt: currentTime,
      capabilities: providers.worktree.capabilities(),
    }));
    const clock = { now: () => new Date(currentTime) };
    const { sqlite, persistence, eventBus, core, api } = createTestObserver({
      config,
      providers,
      clock,
    });
    const events = eventBus.subscribe({ type: "provider.healthChanged" })[Symbol.asyncIterator]();

    const unavailableEvent = events.next();
    await providers.healthCache.refresh(providers.worktree.id);

    expect(await unavailableEvent).toMatchObject({
      done: false,
      value: {
        type: "provider.healthChanged",
        provider: "fake-worktree",
        health: { status: "unavailable" },
      },
    });
    expect(core.getSnapshot()).toMatchObject({
      observer: { healthy: false },
      providerHealth: { "fake-worktree": { status: "unavailable" } },
      projects: [{ health: { providerId: "fake-worktree", status: "unavailable" } }],
      alerts: [{ provider: "fake-worktree", severity: "error" }],
    });

    currentTime = "2026-05-20T12:01:00.000Z";
    healthStatus = "healthy";
    const healthyEvent = events.next();
    await providers.healthCache.refresh(providers.worktree.id);

    expect(await healthyEvent).toMatchObject({
      done: false,
      value: {
        type: "provider.healthChanged",
        provider: "fake-worktree",
        health: { status: "healthy" },
      },
    });
    expect(core.getSnapshot()).toMatchObject({
      observer: { healthy: true },
      providerHealth: { "fake-worktree": { status: "healthy" } },
      projects: [{ health: { providerId: "fake-worktree", status: "healthy" } }],
      alerts: [],
    });
    expect(core.getHealth().providerHealth["fake-worktree"]?.status).toBe("healthy");

    currentTime = "2026-05-20T12:02:00.000Z";
    const repeatedHealthyEvent = events.next();
    await providers.healthCache.refresh(providers.worktree.id);
    expect(await repeatedHealthyEvent).toMatchObject({
      done: false,
      value: {
        type: "provider.healthChanged",
        provider: "fake-worktree",
        health: { status: "healthy", lastCheckedAt: currentTime },
      },
    });

    await expect(
      core.commitProviderHealthProbe({
        providerId: "fake-worktree",
        providerType: "worktree",
        status: "unavailable",
        lastCheckedAt: now,
      }),
    ).resolves.toBeUndefined();
    expect(core.getSnapshot().providerHealth["fake-worktree"]?.status).toBe("healthy");
    const healthRows = await persistence.listProviderObservations({
      entityKind: "provider_health",
    });
    expect(healthRows.map((row) => row.payload.status)).toEqual(["unavailable", "healthy"]);
    expect(healthRows[1]?.observedAt).toBe(currentTime);

    await events.return?.();
    await api.stop();
    sqlite.close();
  });

  it("publishes once when reconcile consumes the completed cache object first", async () => {
    const providers = providersWithOneSession();
    const project = config.projects[0];
    if (project === undefined) {
      throw new Error("Expected the test project fixture.");
    }
    const worktrees = await providers.worktree.listWorktrees(project);
    let releaseWorktreeRead: () => void = () => undefined;
    const listWorktrees = vi.spyOn(providers.worktree, "listWorktrees").mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseWorktreeRead = () => resolve(worktrees);
        }),
    );
    const clock = { now: () => new Date(now) };
    const { sqlite, persistence, eventBus, core, api } = createTestObserver({
      config,
      providers,
      clock,
    });
    const publish = vi.spyOn(eventBus, "publish");

    const reconcile = core.reconcile("health-publication-race");
    await vi.waitFor(() => expect(listWorktrees).toHaveBeenCalledOnce());
    const refresh = providers.healthCache.refresh("fake-harness");
    await vi.waitFor(() =>
      expect(providers.healthCache.read("fake-harness")?.status).toBe("healthy"),
    );
    releaseWorktreeRead();
    await reconcile;
    await refresh;

    const harnessHealthEvents = publish.mock.calls
      .map(([event]) => event)
      .filter(
        (event) => event.type === "provider.healthChanged" && event.provider === "fake-harness",
      );
    expect(harnessHealthEvents).toHaveLength(1);
    const healthRows = await persistence.listProviderObservations({
      entityKind: "provider_health",
    });
    expect(healthRows.filter((row) => row.provider === "fake-harness")).toHaveLength(1);

    await api.stop();
    sqlite.close();
  });

  it("persists lean provider health when a read failure carries command diagnostics", async () => {
    const terminal = new FakeTerminalProvider({ now });
    terminal.listTargets = async () => {
      throw {
        tag: "TerminalProviderError",
        code: "TERMINAL_LIST_FAILED",
        message: "tmux failed to list terminal targets.",
        provider: "fake-terminal",
        diagnosticDetails: [
          {
            type: "external_command",
            provider: "fake-terminal",
            operation: "provider.fake-terminal.listTargets",
            command: "tmux list-panes -a",
            exitCode: 1,
            stderrSnippet: "tmux list failed",
          },
        ],
      };
    };
    const clock = { now: () => new Date(now) };
    const sqlite = openObserverSqlite({ clock });
    const persistence = createSqliteObserverPersistence({ sqlite, clock, idFactory: ids() });
    const logErrors: Array<{ message: string; attributes?: Record<string, unknown> }> = [];
    const core = createObserverCore({
      config,
      providers: new ProviderRegistry({
        worktree: new FakeWorktreeProvider({ now }),
        terminal,
        harnesses: [new FakeHarnessProvider({ now })],
      }),
      persistence,
      clock,
      logger: {
        info: async () => undefined,
        warn: async () => undefined,
        error: async (message, attributes) => {
          logErrors.push({ message, ...(attributes === undefined ? {} : { attributes }) });
        },
      },
    });

    const snapshot = await core.reconcile("diagnostic-rich-provider-failure");

    expect(StationSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.observer.healthy).toBe(false);
    expect(snapshot.providerHealth["fake-terminal"]).toMatchObject({
      status: "unavailable",
      lastError: {
        code: "TERMINAL_LIST_FAILED",
        provider: "fake-terminal",
      },
    });
    expect(snapshot.providerHealth["fake-terminal"]?.lastError).not.toHaveProperty(
      "diagnosticDetails",
    );
    expect(core.getHealth().lastReconcile?.errors[0]).not.toHaveProperty("diagnosticDetails");
    expect(logErrors).toEqual([
      {
        message: "Terminal provider list failed.",
        attributes: expect.objectContaining({
          error: expect.objectContaining({
            diagnosticDetails: [
              expect.objectContaining({
                type: "external_command",
                command: "tmux list-panes -a",
                stderrSnippet: "tmux list failed",
              }),
            ],
          }),
        }),
      },
    ]);
    const terminalHealth = (await persistence.listProviderObservations()).find(
      (observation) =>
        observation.entityKind === "provider_health" &&
        observation.payload.providerId === "fake-terminal",
    );
    expect(terminalHealth).toMatchObject({
      entityKind: "provider_health",
      payload: {
        status: "unavailable",
        lastError: { code: "TERMINAL_LIST_FAILED" },
      },
    });
    expect(terminalHealth?.payload.lastError).not.toHaveProperty("diagnosticDetails");
    sqlite.close();
  });

  it("does not hydrate the live graph from stale SQLite records", async () => {
    const dbPath = await tempDbPath();
    const {
      sqlite,
      persistence,
      core: firstCore,
    } = createTestObserverCore({
      config,
      providers: providersWithOneSession(),
      clock: { now: () => new Date(now) },
      sqlitePath: dbPath,
    });
    await firstCore.reconcile("initial");

    const secondCore = createObserverCore({
      config,
      providers: new ProviderRegistry({
        worktree: new FakeWorktreeProvider({ now, worktrees: [] }),
        terminal: new FakeTerminalProvider({ now, targets: [] }),
        harnesses: [new FakeHarnessProvider({ now, runs: [] })],
      }),
      persistence,
      clock: { now: () => new Date(now) },
    });
    const snapshot = await secondCore.reconcile("providers-empty");

    expect(
      await persistence.listProviderObservations({
        entityKind: "worktree",
        includeExpired: true,
      }),
    ).toEqual([expect.objectContaining({ entityKey: "wt_web_main" })]);
    expect(snapshot.rows).toEqual([]);
    sqlite.close();
  });

  it("promotes matching harness hook observations during live reconcile", async () => {
    const dbPath = await tempDbPath();
    const { sqlite, persistence, core } = createTestObserverCore({
      config,
      providers: providersWithOneSession(),
      clock: { now: () => new Date(now) },
      sqlitePath: dbPath,
    });
    await persistence.recordProviderObservation({
      provider: "fake-harness",
      providerType: "harness",
      entityKind: "harness_event",
      entityKey: "run_web_main",
      observedAt: "2026-05-20T12:00:01.000Z",
      payload: {
        provider: "fake-harness",
        harnessRunId: "run_web_main",
        worktreeId: "wt_web_main",
        sessionId: "ses_web_main",
        rawEventType: "PermissionRequest",
        status: {
          value: "needs_attention",
          confidence: "high",
          reason: "Codex requested permission for Bash.",
          source: "harness_event",
          updatedAt: "2026-05-20T12:00:01.000Z",
        },
        observedAt: "2026-05-20T12:00:01.000Z",
      },
    });

    const snapshot = await core.reconcile("hook-promoted-status");

    expect(snapshot.rows[0]?.agent).toMatchObject({
      state: "needs_attention",
      confidence: "high",
      reason: "Codex requested permission for Bash.",
      updatedAt: "2026-05-20T12:00:01.000Z",
    });
    expect(snapshot.sessions[0]?.status).toMatchObject({
      value: "needs_attention",
      source: "harness_event",
      updatedAt: "2026-05-20T12:00:01.000Z",
    });
    expect(snapshot.projects[0]?.counts).toMatchObject({
      working: 0,
      attention: 1,
      unknown: 0,
    });
    expect(snapshot.counts).toMatchObject({
      working: 0,
      attention: 1,
      unknown: 0,
    });
    const harnessRuns = await persistence.listProviderObservations({
      entityKind: "harness_run",
      latestOnly: true,
    });
    expect(harnessRuns).toHaveLength(1);
    expect(
      harnessRuns[0]?.entityKind === "harness_run" ? harnessRuns[0].payload : undefined,
    ).toMatchObject({
      id: "run_web_main",
      state: "needs_attention",
      confidence: "high",
      observedAt: now,
    });
    expect(await persistence.listSessions()).toEqual([
      expect.objectContaining({
        id: "ses_web_main",
        state: "needs_attention",
        lastSeenAt: now,
      }),
    ]);
    expect(await persistence.listProviderObservations({ includeExpired: true })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityKind: "harness_event",
          entityKey: "run_web_main",
        }),
      ]),
    );
    sqlite.close();
  });

  it("decays a busy status whose newest signal is older than the decay window", async () => {
    const dbPath = await tempDbPath();
    const lastSignalAt = "2026-05-20T11:00:00.000Z"; // an hour before `now`
    const { sqlite, persistence, core } = createTestObserverCore({
      config,
      providers: providersWithOneSession(),
      clock: { now: () => new Date(now) },
      sqlitePath: dbPath,
    });
    await persistence.recordProviderObservation({
      provider: "fake-harness",
      providerType: "harness",
      entityKind: "harness_event",
      entityKey: "run_web_main",
      observedAt: lastSignalAt,
      payload: {
        provider: "fake-harness",
        harnessRunId: "run_web_main",
        worktreeId: "wt_web_main",
        sessionId: "ses_web_main",
        rawEventType: "UserPromptSubmit",
        status: {
          value: "working",
          confidence: "high",
          reason: "Prompt submitted.",
          source: "harness_event",
          updatedAt: lastSignalAt,
        },
        observedAt: lastSignalAt,
      },
    });

    const snapshot = await core.reconcile("stale-busy-decay");

    expect(snapshot.rows[0]?.agent).toMatchObject({
      state: "unknown",
      confidence: "low",
      updatedAt: lastSignalAt,
    });
    expect(snapshot.sessions[0]?.status).toMatchObject({
      value: "unknown",
      source: "reconcile",
      updatedAt: lastSignalAt,
    });
    expect(snapshot.counts).toMatchObject({
      working: 0,
      attention: 0,
      unknown: 1,
    });
    sqlite.close();
  });

  it("mints a run for an external session and lights its worktree row", async () => {
    const dbPath = await tempDbPath();
    const eventAt = "2026-05-20T12:00:01.000Z";
    const providers = new ProviderRegistry({
      worktree: new FakeWorktreeProvider({
        now,
        worktrees: [createFakeWorktree({ id: "wt_web_main", projectId: "web", now })],
      }),
      terminal: new FakeTerminalProvider({ now, targets: [] }),
      harnesses: [new FakeHarnessProvider({ now, runs: [] })],
    });
    const { sqlite, persistence, core } = createTestObserverCore({
      config,
      providers,
      clock: { now: () => new Date(now) },
      sqlitePath: dbPath,
    });
    await persistence.recordProviderObservation({
      provider: "fake-harness",
      providerType: "harness",
      entityKind: "harness_event",
      entityKey: "native_ext_1",
      observedAt: eventAt,
      payload: {
        provider: "fake-harness",
        worktreeId: "wt_web_main",
        nativeSessionId: "native_ext_1",
        rawEventType: "UserPromptSubmit",
        status: {
          value: "working",
          confidence: "medium",
          reason: "Prompt submitted.",
          source: "harness_event",
          updatedAt: eventAt,
        },
        observedAt: eventAt,
      },
    });

    const snapshot = await core.reconcile("external-session");

    expect(snapshot.rows[0]?.agent).toMatchObject({
      harness: "fake-harness",
      state: "working",
      runId: "fake-harness:external:native_ext_1",
    });
    expect(snapshot.counts).toMatchObject({ working: 1 });
    sqlite.close();
  });

  it("attaches cached current change summaries to hot snapshots", async () => {
    const { sqlite, persistence, core } = createTestObserverCore({
      config,
      providers: providersWithOneSession(),
      clock: { now: () => new Date(now) },
    });
    await persistence.upsertWorktreeMetadataCurrent({
      worktreeId: "wt_web_main",
      kind: "change_summary",
      cacheKey: "cached",
      expiresAt: "2026-05-20T12:05:00.000Z",
      payload: {
        kind: "branch_diff",
        additions: 7,
        deletions: 2,
        filesChanged: 3,
        binaryFiles: 1,
        baseRef: "main",
        baseSha: "1111111111111111111111111111111111111111",
        headRef: "feature",
        headSha: "2222222222222222222222222222222222222222",
        source: "local_git",
        checkedAt: now,
      },
    });

    const snapshot = await core.reconcile("cached-change-summary");

    expect(snapshot.rows[0]?.worktree.changeSummary).toMatchObject({
      additions: 7,
      deletions: 2,
      binaryFiles: 1,
      source: "local_git",
    });
    sqlite.close();
  });

  it("reconciles successfully when the current metadata cache is empty", async () => {
    const { sqlite, core } = createTestObserverCore({
      config,
      providers: providersWithOneSession(),
      clock: { now: () => new Date(now) },
    });

    const snapshot = await core.reconcile("empty-current-metadata");

    expect(snapshot.rows[0]?.worktree).not.toHaveProperty("changeSummary");
    sqlite.close();
  });

  it("does not hydrate change summaries from provider observation history", async () => {
    const { sqlite, persistence, core } = createTestObserverCore({
      config,
      providers: providersWithOneSession(),
      clock: { now: () => new Date(now) },
    });
    await persistence.recordProviderObservation({
      provider: "fake-worktree",
      providerType: "worktree",
      entityKind: "worktree",
      entityKey: "wt_web_main",
      observedAt: now,
      payload: {
        ...createFakeWorktree({ id: "wt_web_main", projectId: "web", now }),
        changeSummary: {
          kind: "branch_diff",
          additions: 99,
          deletions: 99,
          source: "provider_observations",
          checkedAt: now,
        },
      },
    });

    const snapshot = await core.reconcile("ignore-provider-observation-metadata");

    expect(snapshot.rows[0]?.worktree).not.toHaveProperty("changeSummary");
    sqlite.close();
  });

  it("leaves unmatched harness hook observations diagnostic-only during live reconcile", async () => {
    const dbPath = await tempDbPath();
    const { sqlite, persistence, core } = createTestObserverCore({
      config,
      providers: providersWithOneSession(),
      clock: { now: () => new Date(now) },
      sqlitePath: dbPath,
    });
    await persistence.recordProviderObservation({
      provider: "fake-harness",
      providerType: "harness",
      entityKind: "harness_event",
      entityKey: "missing_run",
      observedAt: "2026-05-20T12:00:01.000Z",
      payload: {
        provider: "fake-harness",
        harnessRunId: "missing_run",
        worktreeId: "wt_web_main",
        sessionId: "ses_web_main",
        rawEventType: "PermissionRequest",
        status: {
          value: "needs_attention",
          confidence: "high",
          reason: "Codex requested permission for Bash.",
          source: "harness_event",
          updatedAt: "2026-05-20T12:00:01.000Z",
        },
        observedAt: "2026-05-20T12:00:01.000Z",
      },
    });

    const snapshot = await core.reconcile("hook-unmatched-diagnostic-only");

    expect(snapshot.rows[0]?.agent).toMatchObject({
      state: "working",
      confidence: "high",
      reason: "Fake harness run is working.",
    });
    expect(snapshot.projects[0]?.counts).toMatchObject({
      working: 1,
      attention: 0,
      unknown: 0,
    });
    expect(await persistence.listProviderObservations({ includeExpired: true })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityKind: "harness_event",
          entityKey: "missing_run",
        }),
      ]),
    );
    sqlite.close();
  });
});
