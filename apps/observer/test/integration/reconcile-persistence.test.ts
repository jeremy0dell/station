import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StationConfig } from "@station/config";
import { ProviderHealthSchema, StationSnapshotSchema } from "@station/contracts";
import {
  createFakeHarnessRun,
  createFakeTerminalTarget,
  createFakeWorktree,
  FakeHarnessProvider,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "@station/testing";
import { describe, expect, it } from "vitest";
import { createObserverCore, ProviderRegistry } from "../../src/internal";
import { createObserverPersistence } from "../../src/persistence";
import { openObserverSqlite } from "../../src/sqlite";
import { createTestObserverCore } from "../support/testObserver";

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
    const reloaded = createObserverPersistence({ sqlite: reopened, idFactory: ids() });
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
    expect(healthRows.map((row) => ProviderHealthSchema.parse(row.payload).status)).toEqual([
      "unknown",
      "unknown",
      "unknown",
    ]);
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
      sqlite,
      clock: { now: () => new Date(now) },
    });
    const snapshot = await secondCore.reconcile("providers-empty");

    expect(await persistence.listWorktrees()).toEqual([
      expect.objectContaining({ id: "wt_web_main" }),
    ]);
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
    expect(await persistence.listHarnessRuns()).toEqual([
      expect.objectContaining({
        id: "run_web_main",
        state: "needs_attention",
        confidence: "high",
        lastSeenAt: now,
      }),
    ]);
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
