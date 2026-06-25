import type {
  AgentState,
  HarnessHooksStatus,
  ProviderProjectConfig,
  StationSnapshot,
  TerminalAttachment,
  WorktreeRow,
} from "@station/contracts";
import type { HostListEntry, StationHostClient } from "@station/host";
import {
  createStationHostController,
  StationTerminalProvider,
  stationTargetId,
} from "@station/terminal";
import { FakeHarnessProvider, FakeTerminalProvider, FakeWorktreeProvider } from "@station/testing";
import { describe, expect, it } from "vitest";
import type { ObserverPersistence } from "../../src/persistence/index";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ObserverCore } from "../../src/reconcile/core";
import { prepareExternalLaunch, reportExternalExit } from "../../src/runtime/externalLaunch";

const now = "2026-05-21T12:00:00.000Z";

const project: ProviderProjectConfig = {
  id: "web",
  label: "Web",
  root: "/tmp/station/web",
  defaults: { harness: "fake-harness", terminal: "fake-terminal", layout: "agent-shell" },
  worktrunk: { enabled: true, base: "main" },
};

function row(
  overrides: {
    agentSessionId?: string | null;
    agentState?: AgentState;
    terminalState?: TerminalAttachment["state"];
  } = {},
): WorktreeRow {
  const base: WorktreeRow = {
    id: "wt_web_feature",
    projectId: "web",
    projectLabel: "Web",
    branch: "feature/login",
    path: "/tmp/station/web/feature",
    worktree: { state: "exists", source: "worktrunk" },
    display: { statusLabel: "No agent", sortPriority: 0, alert: false },
  };
  if (overrides.agentSessionId !== undefined) {
    base.agent = {
      harness: "fake-harness",
      state: overrides.agentState ?? "working",
      runId: "fake-harness:run_1",
      confidence: "high",
      reason: "running",
      updatedAt: now,
      ...(overrides.agentSessionId === null ? {} : { sessionId: overrides.agentSessionId }),
    };
  }
  if (overrides.terminalState !== undefined) {
    base.terminal = { provider: "native", state: overrides.terminalState };
  }
  return base;
}

function snapshotWith(rows: WorktreeRow[]): StationSnapshot {
  return { rows } as unknown as StationSnapshot;
}

function fakeCore(
  rows: WorktreeRow[],
  projects: readonly ProviderProjectConfig[] = [project],
): ObserverCore {
  const snapshot = snapshotWith(rows);
  return {
    getProjects: () => projects,
    getSnapshot: () => snapshot,
    reconcile: async () => snapshot,
    projectHarnessEventStatus: async () => ({}) as never,
    updateConfig: () => {},
    getHealth: () => ({}) as never,
  } as unknown as ObserverCore;
}

const fakePersistence = {
  listSessions: async () => [],
  listWorktrees: async () => [],
} as unknown as ObserverPersistence;

/** A harness that reports hook installation status (the gate input). */
class HookableHarness extends FakeHarnessProvider {
  readonly #installed: boolean;
  readonly #requested: boolean;
  constructor(installed: boolean, requested = true) {
    super({ id: "fake-harness", now: () => new Date(now) });
    this.#installed = installed;
    this.#requested = requested;
  }
  async hooksStatus(): Promise<HarnessHooksStatus> {
    return {
      provider: this.id,
      installed: this.#installed,
      requested: this.#requested,
      missing: this.#installed ? [] : ["SessionStart"],
      message: this.#installed ? "Installed." : "Hooks are not installed.",
    };
  }
}

type Harnesses = ConstructorParameters<typeof ProviderRegistry>[0]["harnesses"];

function registryWith(
  station: StationTerminalProvider,
  harnesses: Harnesses = [
    new FakeHarnessProvider({ id: "fake-harness", now: () => new Date(now) }),
  ],
): ProviderRegistry {
  return new ProviderRegistry({
    worktree: new FakeWorktreeProvider({ id: "fake-worktree" }),
    terminal: new FakeTerminalProvider({ now: () => new Date(now) }),
    terminals: [station],
    harnesses,
  });
}

function deps(
  rows: WorktreeRow[],
  station: StationTerminalProvider,
  harnesses?: Harnesses,
  projects: readonly ProviderProjectConfig[] = [project],
) {
  return {
    core: fakeCore(rows, projects),
    providers: registryWith(station, harnesses),
    persistence: fakePersistence,
    clock: { now: () => new Date(now) },
  };
}

const prepareParams = { projectId: "web", worktreeId: "wt_web_feature" };

describe("prepareExternalLaunch", () => {
  it("mints one session + one station target + a launch plan", async () => {
    const station = new StationTerminalProvider({ clock: { now: () => new Date(now) } });
    const result = await prepareExternalLaunch(deps([row()], station), prepareParams);

    expect(result.reconcile).toBe(true);
    expect(result.outcome.kind).toBe("prepared");
    if (result.outcome.kind !== "prepared") throw new Error("expected prepared");
    expect(result.outcome.sessionId).toMatch(/^ses_/);
    expect(result.outcome.terminalTargetId).toBe(stationTargetId("wt_web_feature"));
    expect(result.outcome.launchPlan.provider).toBe("fake-harness");
    expect(result.outcome.launchPlan.env?.STATION_SESSION_ID).toBe(result.outcome.sessionId);

    // Exactly one station target was registered for the worktree.
    const targets = await station.listTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0]?.harnessBinding?.role).toBe("main-agent");
  });

  it("rejects when the harness's status hooks are not installed", async () => {
    const station = new StationTerminalProvider();
    await expect(
      prepareExternalLaunch(deps([row()], station, [new HookableHarness(false)]), prepareParams),
    ).rejects.toMatchObject({
      tag: "CommandValidationError",
      code: "HARNESS_HOOKS_NOT_INSTALLED",
      provider: "fake-harness",
    });
    // No target is left registered after a gated rejection.
    expect(await station.listTargets()).toEqual([]);
  });

  it("passes the gate when hooks are installed", async () => {
    const station = new StationTerminalProvider();
    const result = await prepareExternalLaunch(
      deps([row()], station, [new HookableHarness(true)]),
      prepareParams,
    );
    expect(result.outcome.kind).toBe("prepared");
  });

  it("uses the configured branch harness for a new external launch", async () => {
    const station = new StationTerminalProvider({ clock: { now: () => new Date(now) } });
    const configuredProject: ProviderProjectConfig = {
      ...project,
      worktreeLaunches: [{ branch: "feature/login", harness: "configured-harness" }],
    };
    const result = await prepareExternalLaunch(
      deps(
        [row()],
        station,
        [
          new FakeHarnessProvider({ id: "fake-harness", now: () => new Date(now) }),
          new FakeHarnessProvider({ id: "configured-harness", now: () => new Date(now) }),
        ],
        [configuredProject],
      ),
      prepareParams,
    );

    expect(result.outcome.kind).toBe("prepared");
    if (result.outcome.kind !== "prepared") throw new Error("expected prepared");
    expect(result.outcome.launchPlan.provider).toBe("configured-harness");
    expect((await station.listTargets())[0]?.harnessBinding?.harnessProvider).toBe(
      "configured-harness",
    );
  });

  it("guides the user to the config flag when hooks are not requested", async () => {
    const station = new StationTerminalProvider();
    // installed:false because requested:false — installing artifacts alone would
    // not satisfy the gate, so the hint must point at the config flag, not install.
    await expect(
      prepareExternalLaunch(
        deps([row()], station, [new HookableHarness(false, false)]),
        prepareParams,
      ),
    ).rejects.toMatchObject({
      code: "HARNESS_HOOKS_NOT_INSTALLED",
      hint: expect.stringContaining("install_hooks = true"),
    });
    expect(await station.listTargets()).toEqual([]);
  });

  it("returns the already-registered session for a concurrent prepare (snapshot lags)", async () => {
    const station = new StationTerminalProvider({ clock: { now: () => new Date(now) } });
    const first = await prepareExternalLaunch(deps([row()], station), prepareParams);
    if (first.outcome.kind !== "prepared") throw new Error("expected prepared");

    // The fake core never reconciles, so row.agent is still undefined — but the
    // station provider already holds a target, so a second prepare must not mint
    // a second identity.
    const second = await prepareExternalLaunch(deps([row()], station), prepareParams);
    expect(second).toEqual({
      outcome: {
        kind: "existing-session",
        sessionId: first.outcome.sessionId,
        harnessProvider: "fake-harness",
      },
      reconcile: false,
    });
    expect(await station.listTargets()).toHaveLength(1);
  });

  it("returns the existing session id instead of minting a second identity", async () => {
    const station = new StationTerminalProvider();
    const result = await prepareExternalLaunch(
      deps([row({ agentSessionId: "ses_existing" })], station),
      prepareParams,
    );
    expect(result).toEqual({
      outcome: {
        kind: "existing-session",
        sessionId: "ses_existing",
        harnessProvider: "fake-harness",
      },
      reconcile: false,
    });
    // No new target registered when an agent already exists.
    expect(await station.listTargets()).toEqual([]);
  });

  it("relaunches an exited agent instead of returning its dead session", async () => {
    const station = new StationTerminalProvider({ clock: { now: () => new Date(now) } });
    // A station agent whose PTY died (state "exited") must be relaunchable on a
    // re-click — not blocked as "already has a running agent".
    const result = await prepareExternalLaunch(
      deps([row({ agentSessionId: "ses_dead", agentState: "exited" })], station),
      prepareParams,
    );
    expect(result.outcome.kind).toBe("prepared");
    if (result.outcome.kind !== "prepared") throw new Error("expected prepared");
    expect(result.outcome.sessionId).not.toBe("ses_dead");
    expect(await station.listTargets()).toHaveLength(1);
  });

  it("relaunches an unknown-state agent whose terminal went stale (the `?` row)", async () => {
    const station = new StationTerminalProvider({ clock: { now: () => new Date(now) } });
    // The dashboard `?` row: an agent reported "unknown" because its terminal is
    // stale (e.g. Station closed and the station target went stale). It is NOT
    // genuinely running, so a row-click must relaunch it — not noop as
    // "already has a running agent".
    const result = await prepareExternalLaunch(
      deps(
        [row({ agentSessionId: "ses_lost", agentState: "unknown", terminalState: "stale" })],
        station,
      ),
      prepareParams,
    );
    expect(result.outcome.kind).toBe("prepared");
    if (result.outcome.kind !== "prepared") throw new Error("expected prepared");
    expect(result.outcome.sessionId).not.toBe("ses_lost");
    expect(await station.listTargets()).toHaveLength(1);
  });

  it("relaunches an unknown-state agent that has no terminal at all", async () => {
    const station = new StationTerminalProvider({ clock: { now: () => new Date(now) } });
    // Unknown with a missing (undefined) terminal and no session id is the worst
    // case the old gate hit: it threw SESSION_ALREADY_HAS_AGENT, a dead-end noop.
    // It must now relaunch.
    const result = await prepareExternalLaunch(
      deps([row({ agentSessionId: null, agentState: "unknown" })], station),
      prepareParams,
    );
    expect(result.outcome.kind).toBe("prepared");
    expect(await station.listTargets()).toHaveLength(1);
  });

  it("still defers to a live unknown agent whose terminal is still open", async () => {
    const station = new StationTerminalProvider();
    // Unknown but with an open, focusable terminal is genuinely reachable — hand
    // back its session rather than launching a second agent.
    const result = await prepareExternalLaunch(
      deps(
        [row({ agentSessionId: "ses_live", agentState: "unknown", terminalState: "open" })],
        station,
      ),
      prepareParams,
    );
    expect(result.outcome).toMatchObject({
      kind: "existing-session",
      sessionId: "ses_live",
      harnessProvider: "fake-harness",
    });
    expect(await station.listTargets()).toEqual([]);
  });

  it("rejects when the station provider is not registered", async () => {
    const registry = new ProviderRegistry({
      worktree: new FakeWorktreeProvider({ id: "fake-worktree" }),
      terminal: new FakeTerminalProvider({ now: () => new Date(now) }),
      harnesses: [new FakeHarnessProvider({ id: "fake-harness", now: () => new Date(now) })],
    });
    await expect(
      prepareExternalLaunch(
        {
          core: fakeCore([row()]),
          providers: registry,
          persistence: fakePersistence,
          clock: { now: () => new Date(now) },
        },
        prepareParams,
      ),
    ).rejects.toMatchObject({ code: "TERMINAL_PROVIDER_UNAVAILABLE", provider: "native" });
  });

  it("rejects a worktree that belongs to another configured project", async () => {
    const station = new StationTerminalProvider();
    const otherProject: ProviderProjectConfig = { ...project, id: "other", label: "Other" };
    const core = {
      getProjects: () => [project, otherProject],
      getSnapshot: () => snapshotWith([row()]),
      reconcile: async () => snapshotWith([row()]),
      projectHarnessEventStatus: async () => ({}) as never,
      updateConfig: () => {},
      getHealth: () => ({}) as never,
    } as unknown as ObserverCore;
    await expect(
      prepareExternalLaunch(
        {
          core,
          providers: registryWith(station),
          persistence: fakePersistence,
          clock: { now: () => new Date(now) },
        },
        { projectId: "other", worktreeId: "wt_web_feature" },
      ),
    ).rejects.toMatchObject({ code: "WORKTREE_PROJECT_MISMATCH" });
  });

  it("rejects when the worktree is not in the snapshot", async () => {
    const station = new StationTerminalProvider();
    await expect(
      prepareExternalLaunch(deps([], station), { projectId: "web", worktreeId: "wt_ghost" }),
    ).rejects.toMatchObject({ code: "WORKTREE_NOT_FOUND" });
    expect(await station.listTargets()).toEqual([]);
  });

  it("rolls back the half-prepared target if buildLaunch fails", async () => {
    const station = new StationTerminalProvider({ clock: { now: () => new Date(now) } });
    const failing = new FakeHarnessProvider({
      id: "fake-harness",
      now: () => new Date(now),
      failures: {
        buildLaunch: {
          tag: "HarnessProviderError",
          code: "HARNESS_BUILD_LAUNCH_FAILED",
          message: "boom",
        },
      },
    });
    await expect(
      prepareExternalLaunch(deps([row()], station, [failing]), prepareParams),
    ).rejects.toMatchObject({ code: "HARNESS_BUILD_LAUNCH_FAILED" });
    // openWorkspace registered a target; the failure rolled it back so a retry is clean.
    expect(await station.listTargets()).toEqual([]);
  });
});

describe("reportExternalExit", () => {
  it("drops the registered target and asks for a reconcile", async () => {
    const station = new StationTerminalProvider({ clock: { now: () => new Date(now) } });
    await prepareExternalLaunch(deps([row()], station), prepareParams);
    const targetId = stationTargetId("wt_web_feature");

    const exit = await reportExternalExit(deps([row()], station), { terminalTargetId: targetId });
    expect(exit).toEqual({
      outcome: { acknowledged: true, terminalTargetId: targetId },
      reconcile: true,
    });
    expect(await station.listTargets()).toEqual([]);
  });

  it("acknowledges an unknown target without asking for a reconcile", async () => {
    const station = new StationTerminalProvider();
    const exit = await reportExternalExit(deps([row()], station), {
      terminalTargetId: "native:nope",
    });
    expect(exit).toEqual({
      outcome: { acknowledged: false, terminalTargetId: "native:nope" },
      reconcile: false,
    });
  });
});

describe("prepareExternalLaunch existing-agent state matrix", () => {
  // For every possible agent state, prepare either hands back the live session
  // (existing-session) or relaunches (prepared). The boundary is
  // worktreeHasLiveAgent: starting/idle/working/needs_attention/stuck are live;
  // none/exited (and "no agent") are relaunchable. `unknown` depends on the
  // terminal — the default row here has none, so it is the crash-recovery
  // relaunch case (the unknown+open-terminal "live" path is pinned separately
  // above). This pins the full decision surface so a future state addition
  // forces a deliberate choice.
  const matrix: Array<{ state: AgentState; expected: "existing-session" | "prepared" }> = [
    { state: "starting", expected: "existing-session" },
    { state: "idle", expected: "existing-session" },
    { state: "working", expected: "existing-session" },
    { state: "needs_attention", expected: "existing-session" },
    { state: "stuck", expected: "existing-session" },
    { state: "unknown", expected: "prepared" },
    { state: "none", expected: "prepared" },
    { state: "exited", expected: "prepared" },
  ];

  for (const { state, expected } of matrix) {
    it(`a "${state}" agent → ${expected}`, async () => {
      const station = new StationTerminalProvider({ clock: { now: () => new Date(now) } });
      const result = await prepareExternalLaunch(
        deps([row({ agentSessionId: "ses_live", agentState: state })], station),
        prepareParams,
      );

      expect(result.outcome.kind).toBe(expected);
      if (expected === "existing-session") {
        // A live agent: hand back its session, register no second target.
        expect(result.outcome).toMatchObject({ sessionId: "ses_live" });
        expect(await station.listTargets()).toEqual([]);
      } else {
        // Relaunch: mint a fresh identity, register exactly one target.
        if (result.outcome.kind !== "prepared") throw new Error("expected prepared");
        expect(result.outcome.sessionId).not.toBe("ses_live");
        expect(await station.listTargets()).toHaveLength(1);
      }
    });
  }

  it('"no agent" (undefined) → prepared', async () => {
    const station = new StationTerminalProvider({ clock: { now: () => new Date(now) } });
    const result = await prepareExternalLaunch(deps([row()], station), prepareParams);
    expect(result.outcome.kind).toBe("prepared");
  });
});

function fakeHostClient(over: Partial<StationHostClient> = {}): StationHostClient {
  return {
    health: async () => ({ ok: true, protocolVersion: 1 }),
    spawn: async () => ({ ptyId: "pty-1", pid: 99 }),
    write: async () => undefined,
    resize: async () => undefined,
    list: async () => [],
    focus: async () => undefined,
    close: async () => ({ closed: true }),
    attach: async () => {
      throw new Error("unused");
    },
    dispose: () => undefined,
    ...over,
  };
}

function liveEntry(): HostListEntry {
  return {
    ptyId: "pty-1",
    terminalTargetId: stationTargetId("wt_web_feature"),
    worktreeId: "wt_web_feature",
    projectId: "web",
    sessionId: "ses_live",
    worktreePath: "/tmp/station/web/feature",
    harnessProvider: "fake-harness",
    pid: 99,
    alive: true,
    cols: 80,
    rows: 24,
  };
}

function hostBackedStation(client: StationHostClient): StationTerminalProvider {
  const controller = createStationHostController(
    {
      socketPath: `/tmp/ext-host-${process.pid}-${Math.random().toString(36).slice(2)}.sock`,
      stateDir: "/tmp",
      hostEntry: "/tmp/hostMain.ts",
      timeoutMs: 50, // keep the host-unavailable path fast in tests
    },
    { clientFactory: () => client, spawnHost: () => ({ pid: 1, unref: () => undefined }) },
  );
  return new StationTerminalProvider({ clock: { now: () => new Date(now) }, host: controller });
}

describe("prepareExternalLaunch (host-backed)", () => {
  it("attaches a reattachHandle to the prepared result", async () => {
    // No host PTY yet (so the prepare isn't short-circuited to existing-session);
    // launchProcess spawns one, then the prepared result carries its handle.
    let spawned = false;
    const station = hostBackedStation(
      fakeHostClient({
        spawn: async () => {
          spawned = true;
          return { ptyId: "pty-1", pid: 99 };
        },
        list: async () => (spawned ? [liveEntry()] : []),
      }),
    );
    const result = await prepareExternalLaunch(deps([row()], station), prepareParams);
    if (result.outcome.kind !== "prepared") throw new Error("expected prepared");
    expect(result.outcome.reattachHandle).toMatchObject({
      ptyId: "pty-1",
      terminalTargetId: stationTargetId("wt_web_feature"),
    });
    expect(result.outcome.reattachHandle?.hostSocketPath).toContain("ext-host-");
  });

  it("attaches a reattachHandle to an existing-session result", async () => {
    const station = hostBackedStation(fakeHostClient({ list: async () => [liveEntry()] }));
    const result = await prepareExternalLaunch(
      deps([row({ agentSessionId: "ses_live" })], station),
      prepareParams,
    );
    expect(result.outcome).toMatchObject({
      kind: "existing-session",
      sessionId: "ses_live",
      harnessProvider: "fake-harness",
      reattachHandle: { ptyId: "pty-1" },
    });
  });

  it("omits the reattachHandle when the host is unavailable (UI spawns locally)", async () => {
    // launchProcess can't reach the host → started:false → no handle → Path A.
    const station = hostBackedStation(
      fakeHostClient({
        health: async () => {
          throw new Error("host down");
        },
      }),
    );
    const result = await prepareExternalLaunch(deps([row()], station), prepareParams);
    if (result.outcome.kind !== "prepared") throw new Error("expected prepared");
    expect(result.outcome.reattachHandle).toBeUndefined();
  });
});
