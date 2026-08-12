import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE_CONFIG, type StationConfig } from "@station/config";
import type {
  AgentPrepareExternalLaunchResult,
  BuildHarnessLaunchRequest,
  HarnessHooksStatus,
  HarnessLaunchPlan,
  HarnessRunObservation,
  ProviderProjectConfig,
  WorktreeObservation,
} from "@station/contracts";
import { StationTerminalProvider } from "@station/terminal";
import {
  createFakeHarnessRun,
  createFakeWorktree,
  FakeHarnessProvider,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "@station/testing";
import { describe, expect, it } from "vitest";
import { fileExists, writeHookSpoolRecordFixture } from "../../../../tests/support/spool";
import {
  createCommandQueue,
  createObserverApi,
  createObserverCore,
  createObserverEventBus,
  createSqliteObserverPersistence,
  openObserverSqlite,
  ProviderRegistry,
  providerIngressSpoolDir,
} from "../../src/internal";
import type { StationLogger } from "../../src/stationLogger";
import { FakeDiagnosticEvidenceSource } from "../support/diagnosticEvidenceSources.js";

const now = "2026-05-20T12:00:00.000Z";

const config: StationConfig = {
  schemaVersion: 1,
  workspace: DEFAULT_WORKSPACE_CONFIG,
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
      defaultBranch: "main",
      defaults: { harness: "fake-harness", terminal: "fake-terminal", layout: "agent-shell" },
      worktrunk: { enabled: true },
    },
  ],
};

// A scheduled/api reconcile drains the hook spool; before this fix the
// external-launch reconcile path was wired with a no-op drain, so a hook event
// spooled during an agent launch was never flushed. Prove the launch-triggered
// reconcile drains the spool, the same as api.reconcile does.
describe("observer external-launch reconcile", () => {
  it("publishes the custom title and drains the hook spool after external launch", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-observer-ext-"));
    const spoolDir = providerIngressSpoolDir(stateDir);
    const fixture = createFixture(spoolDir);

    // Seed the snapshot first (no spool record yet) so prepareExternalLaunch can
    // find the worktree without this reconcile draining the record under test.
    await fixture.api.reconcile("seed");

    const spoolPath = await writeHookSpoolRecordFixture({ spoolDir, spoolId: "spool_ext" });
    expect(await fileExists(spoolPath)).toBe(true);

    const result = await fixture.api.prepareExternalLaunch({
      projectId: "web",
      worktreeId: "wt_web_feature",
      title: "Hexagonal PT 12",
    });
    expect(result.kind).toBe("prepared");
    if (result.kind !== "prepared") throw new Error("expected prepared launch");
    fixture.harness.addRun(
      createFakeHarnessRun({
        id: "run_web_feature",
        projectId: "web",
        worktreeId: "wt_web_feature",
        sessionId: result.sessionId,
        state: "working",
        now,
      }),
    );

    // The post-launch reconcile is fire-and-forget; wait for the drain to delete
    // the spooled record.
    await waitFor(async () => !(await fileExists(spoolPath)));
    expect(await fileExists(spoolPath)).toBe(false);
    await fixture.api.reconcile("verify-external-title");
    expect((await fixture.api.getSnapshot()).sessions).toEqual([
      expect.objectContaining({
        worktreeId: "wt_web_feature",
        title: "Hexagonal PT 12",
      }),
    ]);

    fixture.sqlite.close();
  });

  it("does not await health publication queued behind an in-flight reconcile", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-observer-ext-"));
    const worktree = createFakeWorktree({
      id: "wt_web_feature",
      projectId: "web",
      branch: "feature",
      path: "/tmp/station/web/feature",
      now,
    });
    const worktreeProvider = new BlockingListWorktreeProvider({
      now,
      worktrees: [worktree],
    });
    const fixture = createFixture(providerIngressSpoolDir(stateDir), {
      worktree: worktreeProvider,
    });
    await fixture.api.reconcile("seed");

    const blocked = worktreeProvider.blockNextList();
    const reconcile = fixture.api.reconcile("blocked-worktree-list");
    await blocked.started;
    const listCallsBeforeLaunch = worktreeProvider.listCalls;
    let timeout: NodeJS.Timeout | undefined;
    let result: AgentPrepareExternalLaunchResult;
    try {
      result = await Promise.race([
        fixture.api.prepareExternalLaunch({
          projectId: "web",
          worktreeId: "wt_web_feature",
        }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("External launch waited for the in-flight reconcile.")),
            250,
          );
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      blocked.release();
    }

    expect(result.kind).toBe("prepared");
    expect(worktreeProvider.listCalls).toBe(listCallsBeforeLaunch);
    expect(await fixture.station.listTargets()).toHaveLength(1);
    await reconcile;
    await waitForStableCount(() => worktreeProvider.listCalls);
    await fixture.api.reconcile("flush-post-launch-reconcile");
    fixture.sqlite.close();
  });

  it("coalesces a burst of launch-triggered maintenance scans", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-observer-ext-"));
    const worktrees = Array.from({ length: 4 }, (_, index) =>
      createFakeWorktree({
        id: `wt_web_feature_${index}`,
        projectId: "web",
        branch: `feature-${index}`,
        path: `/tmp/station/web/feature-${index}`,
        now,
      }),
    );
    const worktreeProvider = new BlockingListWorktreeProvider({ now, worktrees });
    const fixture = createFixture(providerIngressSpoolDir(stateDir), {
      worktree: worktreeProvider,
    });
    await fixture.api.reconcile("seed-launch-burst");
    const listCallsBeforeLaunch = worktreeProvider.listCalls;

    await Promise.all(
      worktrees.map((worktree) =>
        fixture.api.prepareExternalLaunch({ projectId: "web", worktreeId: worktree.id }),
      ),
    );
    await waitForStableCount(() => worktreeProvider.listCalls);
    await fixture.api.reconcile("launch-burst-barrier");

    const postLaunchScans = worktreeProvider.listCalls - listCallsBeforeLaunch - 1;
    expect(postLaunchScans).toBe(1);
    expect(await fixture.station.listTargets()).toHaveLength(4);
    expect(await fixture.persistence.listSessions()).toHaveLength(4);
    fixture.sqlite.close();
  });

  it("logs hook readiness rejections with their diagnostic code", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-observer-ext-"));
    const records: Array<{ message: string; attributes?: Record<string, unknown> }> = [];
    const logger: StationLogger = {
      info: async () => {},
      warn: async (message, attributes) => {
        records.push({ message, ...(attributes === undefined ? {} : { attributes }) });
      },
      error: async () => {},
    };
    const fixture = createFixture(providerIngressSpoolDir(stateDir), {
      harness: new MissingHooksHarness(),
      logger,
    });
    await fixture.api.reconcile("seed");

    await expect(
      fixture.api.prepareExternalLaunch({ projectId: "web", worktreeId: "wt_web_feature" }),
    ).rejects.toMatchObject({ code: "HARNESS_HOOKS_NOT_INSTALLED" });
    expect(records).toContainEqual({
      message: "External agent launch rejected because harness hooks are unavailable.",
      attributes: {
        error: expect.objectContaining({ code: "HARNESS_HOOKS_NOT_INSTALLED" }),
        projectId: "web",
        worktreeId: "wt_web_feature",
      },
    });

    fixture.sqlite.close();
  });

  it("recovers one canonical session with its title, idle evidence, and readiness", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-observer-ext-"));
    const previousRun = createFakeHarnessRun({
      id: "run_web_recoverable",
      projectId: "web",
      worktreeId: "wt_web_feature",
      sessionId: "ses_web_recoverable",
      state: "idle",
      now,
    });
    const runs: HarnessRunObservation[] = [previousRun];
    const harness = new RecoveringHarness(runs);
    const fixture = createFixture(providerIngressSpoolDir(stateDir), {
      harness,
      config: {
        ...config,
        featureFlags: { sessionResumeAgent: true },
      },
    });
    await fixture.persistence.seedSession({
      sessionId: "ses_web_recoverable",
      projectId: "web",
      worktreeId: "wt_web_feature",
      initialTitle: "feature",
      createdAt: now,
      lastSeenAt: now,
    });
    await fixture.persistence.renameSession({
      sessionId: "ses_web_recoverable",
      title: "Recovered checkout",
      renamedAt: now,
    });
    await fixture.persistence.upsertSessionTurnReadiness({
      sessionId: "ses_web_recoverable",
      projectId: "web",
      worktreeId: "wt_web_feature",
      token: "ready_web_recoverable",
      completedAt: now,
    });
    const handle = await fixture.persistence.upsertSessionRecoveryHandle({
      id: "rec_web_recoverable",
      provider: "fake-harness",
      projectId: "web",
      worktreeId: "wt_web_feature",
      sessionId: "ses_web_recoverable",
      target: { kind: "native-session", id: "native_web_recoverable" },
      cwd: "/tmp/station/web/feature",
      observedAt: now,
      lastSeenAt: now,
    });
    await fixture.api.reconcile("establish-recoverable-session");
    runs.length = 0;
    await fixture.api.reconcile("simulate-host-loss");

    expect((await fixture.api.getSnapshot()).sessions).toEqual([
      expect.objectContaining({
        id: "ses_web_recoverable",
        origin: "station",
        title: "Recovered checkout",
        status: expect.objectContaining({ value: "none" }),
      }),
    ]);

    const result = await fixture.api.prepareExternalLaunch({
      projectId: "web",
      worktreeId: "wt_web_feature",
      title: "Ignored replacement title",
    });
    expect(result).toMatchObject({ kind: "prepared", sessionId: "ses_web_recoverable" });
    expect(harness.requests).toEqual([
      expect.objectContaining({
        sessionId: "ses_web_recoverable",
        resume: {
          target: { kind: "native-session", id: "native_web_recoverable" },
          previousSessionId: "ses_web_recoverable",
          recoveryHandleId: handle.id,
        },
      }),
    ]);
    expect((await fixture.api.getSnapshot()).sessions).toEqual([
      expect.objectContaining({
        id: "ses_web_recoverable",
        status: expect.objectContaining({ value: "none" }),
      }),
    ]);
    harness.addRun(
      createFakeHarnessRun({
        id: "run_web_recovered",
        projectId: "web",
        worktreeId: "wt_web_feature",
        sessionId: "ses_web_recoverable",
        state: "idle",
        now,
      }),
    );

    await fixture.api.reconcile("verify-recovered-session");
    const snapshot = await fixture.api.getSnapshot();
    expect(snapshot.sessions).toEqual([
      expect.objectContaining({
        id: "ses_web_recoverable",
        origin: "station",
        title: "Recovered checkout",
        status: expect.objectContaining({ value: "idle" }),
      }),
    ]);
    expect(snapshot.rows).toEqual([
      expect.objectContaining({
        id: "wt_web_feature",
        title: "Recovered checkout",
        agent: expect.objectContaining({
          sessionId: "ses_web_recoverable",
          state: "idle",
          turnReadiness: {
            state: "ready_to_read",
            token: "ready_web_recoverable",
            completedAt: now,
          },
        }),
      }),
    ]);
    await expect(fixture.persistence.listSessions()).resolves.toEqual([
      expect.objectContaining({
        id: "ses_web_recoverable",
        lifecycle: "open",
        title: "Recovered checkout",
      }),
    ]);

    fixture.sqlite.close();
  });
});

function createFixture(
  spoolDir: string,
  options: {
    harness?: FakeHarnessProvider;
    config?: StationConfig;
    worktree?: FakeWorktreeProvider;
    logger?: StationLogger;
  } = {},
) {
  const clock = { now: () => new Date(now) };
  const fixtureConfig = options.config ?? config;
  const sqlite = openObserverSqlite({ clock });
  const persistence = createSqliteObserverPersistence({ sqlite, clock, idFactory: ids() });
  const eventBus = createObserverEventBus();
  const station = new StationTerminalProvider({ clock });
  const harness = options.harness ?? new FakeHarnessProvider({ now });
  const providers = new ProviderRegistry({
    worktree:
      options.worktree ??
      new FakeWorktreeProvider({
        now,
        worktrees: [
          createFakeWorktree({
            id: "wt_web_feature",
            projectId: "web",
            branch: "feature",
            path: "/tmp/station/web/feature",
            remote: { host: "github.com", owner: "example", repo: "web" },
            headSha: "2222222222222222222222222222222222222222",
            now,
          }),
        ],
      }),
    terminal: new FakeTerminalProvider({ now }),
    managedTerminal: station,
    harnesses: [harness],
  });
  const core = createObserverCore({ config: fixtureConfig, providers, persistence, clock });
  const queue = createCommandQueue({ persistence, clock, idFactory: ids(), eventBus });
  const api = createObserverApi({
    core,
    providers,
    persistence,
    persistenceHealth: persistence,
    commandQueue: queue,
    eventBus,
    diagnosticEvidenceSource: new FakeDiagnosticEvidenceSource(),
    hookSpoolDir: spoolDir,
    config: fixtureConfig,
    clock,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  return { api, harness, persistence, sqlite, station };
}

class BlockingListWorktreeProvider extends FakeWorktreeProvider {
  listCalls = 0;
  #blocked:
    | {
        started: Promise<void>;
        markStarted: () => void;
        wait: Promise<void>;
        release: () => void;
      }
    | undefined;

  blockNextList(): { started: Promise<void>; release: () => void } {
    let markStarted = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release = () => undefined;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#blocked = { started, markStarted, wait, release };
    return { started, release };
  }

  override async listWorktrees(project: ProviderProjectConfig): Promise<WorktreeObservation[]> {
    this.listCalls += 1;
    const blocked = this.#blocked;
    if (blocked !== undefined) {
      this.#blocked = undefined;
      blocked.markStarted();
      await blocked.wait;
    }
    return super.listWorktrees(project);
  }
}

class MissingHooksHarness extends FakeHarnessProvider {
  async hooksStatus(): Promise<HarnessHooksStatus> {
    return {
      provider: this.id,
      installed: false,
      requested: true,
      missing: ["SessionStart"],
      message: "Hooks are not installed.",
    };
  }
}

class RecoveringHarness extends FakeHarnessProvider {
  readonly requests: BuildHarnessLaunchRequest[] = [];

  constructor(runs: HarnessRunObservation[]) {
    super({ now: () => new Date(now), runs });
  }

  override async buildLaunch(request: BuildHarnessLaunchRequest): Promise<HarnessLaunchPlan> {
    this.requests.push(request);
    return super.buildLaunch(request);
  }
}

function ids() {
  let command = 0;
  let event = 0;
  let observation = 0;
  let breadcrumb = 0;
  return {
    commandId: () => `cmd_${++command}`,
    eventId: () => `evt_${++event}`,
    observationId: () => `obs_${++observation}`,
    breadcrumbId: () => `crumb_${++breadcrumb}`,
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for predicate.");
}

async function waitForStableCount(read: () => number): Promise<void> {
  let previous = read();
  let stableSince = Date.now();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const current = read();
    if (current !== previous) {
      previous = current;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 150) {
      return;
    }
  }
  throw new Error("Timed out waiting for reconcile call count to stabilize.");
}
