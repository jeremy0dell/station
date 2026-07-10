import type {
  AgentState,
  HarnessHooksStatus,
  ManagedTerminalLaunchProcessResult,
  ManagedTerminalLifecycle,
  OpenWorkspaceRequest,
  OpenWorkspaceResult,
  ProviderHealth,
  ProviderId,
  ProviderProjectConfig,
  SafeError,
  StationSnapshot,
  TerminalAttachment,
  TerminalCapabilities,
  TerminalLaunchProcessRequest,
  TerminalReattachInfo,
  TerminalTargetId,
  TerminalTargetObservation,
  WorktreeRow,
} from "@station/contracts";
import {
  createFakeTerminalTarget,
  FakeHarnessProvider,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "@station/testing";
import { describe, expect, it } from "vitest";
import type { ObserverPersistence } from "../../src/persistence/index";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ObserverCore } from "../../src/reconcile/core";
import { prepareExternalLaunch, reportExternalExit } from "../../src/runtime/externalLaunch";

const now = "2026-05-21T12:00:00.000Z";

function managedTargetId(worktreeId: string): TerminalTargetId {
  return `managed://${worktreeId}` as TerminalTargetId;
}

type FakeManagedTerminalOptions = {
  started?: boolean;
  reattach?: TerminalReattachInfo;
  launchFailure?: SafeError;
  releaseFailure?: SafeError;
};

/** Deliberately differs from the Station adapter in both provider id and target format. */
class FakeManagedTerminalLifecycle implements ManagedTerminalLifecycle {
  readonly id: ProviderId = "managed-test";
  readonly released: TerminalTargetId[] = [];

  readonly #targets: TerminalTargetObservation[] = [];
  readonly #terminal: FakeTerminalProvider;
  readonly #started: boolean;
  readonly #reattach: TerminalReattachInfo | undefined;
  readonly #launchFailure: SafeError | undefined;
  readonly #releaseFailure: SafeError | undefined;

  constructor(options: FakeManagedTerminalOptions = {}) {
    this.#terminal = new FakeTerminalProvider({
      id: this.id,
      now: () => new Date(now),
      targets: this.#targets,
    });
    this.#started = options.started ?? false;
    this.#reattach = options.reattach;
    this.#launchFailure = options.launchFailure;
    this.#releaseFailure = options.releaseFailure;
  }

  capabilities(): TerminalCapabilities {
    return this.#terminal.capabilities();
  }

  health(): Promise<ProviderHealth> {
    return this.#terminal.health();
  }

  listTargets(): Promise<TerminalTargetObservation[]> {
    return this.#terminal.listTargets();
  }

  async openWorkspace(request: OpenWorkspaceRequest): Promise<OpenWorkspaceResult> {
    const targetId = managedTargetId(request.worktree.id);
    const target = createFakeTerminalTarget({
      id: targetId,
      provider: this.id,
      projectId: request.project.id,
      worktreeId: request.worktree.id,
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      now,
      harnessBinding: {
        role: "main-agent",
        harnessProvider: request.harness,
        worktreePath: request.worktree.path,
      },
    });
    const existingIndex = this.#targets.findIndex(
      (candidate) => candidate.worktreeId === request.worktree.id,
    );
    if (existingIndex < 0) {
      this.#targets.push(target);
    } else {
      this.#targets[existingIndex] = target;
    }
    return {
      target: {
        provider: this.id,
        targetId,
        projectId: request.project.id,
        worktreeId: request.worktree.id,
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        harnessBinding: {
          role: "main-agent",
          harnessProvider: request.harness,
          worktreePath: request.worktree.path,
        },
        confidence: "high",
        reason: "Fake managed terminal registered a target.",
      },
      agentEndpointId: targetId,
    };
  }

  async launchProcess(
    request: TerminalLaunchProcessRequest,
  ): Promise<ManagedTerminalLaunchProcessResult> {
    if (this.#launchFailure !== undefined) {
      throw this.#launchFailure;
    }
    const result = {
      terminalTargetId: request.terminalTarget.targetId,
      agentEndpointId: request.agentEndpointId,
    };
    if (!this.#started) {
      return { ...result, started: false };
    }
    if (this.#reattach === undefined) {
      throw new Error("Fake managed terminal needs reattach info when started.");
    }
    return { ...result, started: true, reattach: this.#reattach };
  }

  async reattachInfo(targetId: TerminalTargetId): Promise<TerminalReattachInfo | undefined> {
    return this.#targets.some((target) => target.id === targetId) ? this.#reattach : undefined;
  }

  async releaseTarget(targetId: TerminalTargetId): Promise<boolean> {
    this.released.push(targetId);
    if (this.#releaseFailure !== undefined) {
      throw this.#releaseFailure;
    }
    const index = this.#targets.findIndex((target) => target.id === targetId);
    if (index < 0) {
      return false;
    }
    this.#targets.splice(index, 1);
    return true;
  }

  focusTarget(targetId: TerminalTargetId): Promise<void> {
    return this.#terminal.focusTarget(targetId);
  }

  closeTarget(targetId: TerminalTargetId): Promise<void> {
    return this.#terminal.closeTarget(targetId);
  }

  seedTarget(input: { worktreeId: string; sessionId: string }): void {
    this.#targets.push(
      createFakeTerminalTarget({
        id: managedTargetId(input.worktreeId),
        provider: this.id,
        projectId: project.id,
        worktreeId: input.worktreeId,
        sessionId: input.sessionId,
        now,
        harnessBinding: {
          role: "main-agent",
          harnessProvider: "fake-harness",
          worktreePath: "/tmp/station/web/feature",
        },
      }),
    );
  }
}

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
    base.terminal = { provider: "managed-test", state: overrides.terminalState };
  }
  return base;
}

function snapshotWith(rows: WorktreeRow[]): StationSnapshot {
  return { rows } as unknown as StationSnapshot;
}

function fakeCore(rows: WorktreeRow[]): ObserverCore {
  const snapshot = snapshotWith(rows);
  return {
    getProjects: () => [project],
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
  managedTerminal: ManagedTerminalLifecycle,
  harnesses: Harnesses = [
    new FakeHarnessProvider({ id: "fake-harness", now: () => new Date(now) }),
  ],
): ProviderRegistry {
  return new ProviderRegistry({
    worktree: new FakeWorktreeProvider({ id: "fake-worktree" }),
    terminal: new FakeTerminalProvider({ now: () => new Date(now) }),
    managedTerminal,
    harnesses,
  });
}

function deps(
  rows: WorktreeRow[],
  managedTerminal: ManagedTerminalLifecycle,
  harnesses?: Harnesses,
) {
  return {
    core: fakeCore(rows),
    providers: registryWith(managedTerminal, harnesses),
    persistence: fakePersistence,
    clock: { now: () => new Date(now) },
  };
}

const prepareParams = { projectId: "web", worktreeId: "wt_web_feature" };

describe("ProviderRegistry managed terminal role", () => {
  it("registers one adapter when the managed lifecycle is also the default terminal", () => {
    const managedTerminal = new FakeManagedTerminalLifecycle();
    const registry = new ProviderRegistry({
      worktree: new FakeWorktreeProvider({ id: "fake-worktree" }),
      terminal: managedTerminal,
      managedTerminal,
      harnesses: [],
    });

    expect(registry.terminal).toBe(managedTerminal);
    expect(registry.managedTerminal).toBe(managedTerminal);
    expect([...registry.terminals.values()]).toEqual([managedTerminal]);
  });

  it("rejects a different terminal adapter with the managed lifecycle id", () => {
    expect(
      () =>
        new ProviderRegistry({
          worktree: new FakeWorktreeProvider({ id: "fake-worktree" }),
          terminal: new FakeManagedTerminalLifecycle(),
          managedTerminal: new FakeManagedTerminalLifecycle(),
          harnesses: [],
        }),
    ).toThrow("Duplicate terminal provider id: managed-test");
  });
});

describe("prepareExternalLaunch", () => {
  it("mints one session + one managed target + a launch plan", async () => {
    const station = new FakeManagedTerminalLifecycle();
    const result = await prepareExternalLaunch(deps([row()], station), prepareParams);

    expect(result.reconcile).toBe(true);
    expect(result.outcome.kind).toBe("prepared");
    if (result.outcome.kind !== "prepared") throw new Error("expected prepared");
    expect(result.outcome.sessionId).toMatch(/^ses_/);
    expect(result.outcome.terminalTargetId).toBe(managedTargetId("wt_web_feature"));
    expect(result.outcome.launchPlan.provider).toBe("fake-harness");
    expect(result.outcome.launchPlan.env?.STATION_SESSION_ID).toBe(result.outcome.sessionId);

    // Exactly one station target was registered for the worktree.
    const targets = await station.listTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0]?.harnessBinding?.role).toBe("main-agent");
  });

  it("rejects when the harness's status hooks are not installed", async () => {
    const station = new FakeManagedTerminalLifecycle();
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
    const station = new FakeManagedTerminalLifecycle();
    const result = await prepareExternalLaunch(
      deps([row()], station, [new HookableHarness(true)]),
      prepareParams,
    );
    expect(result.outcome.kind).toBe("prepared");
  });

  it("guides the user to the config flag when hooks are not requested", async () => {
    const station = new FakeManagedTerminalLifecycle();
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
    const station = new FakeManagedTerminalLifecycle();
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
    const station = new FakeManagedTerminalLifecycle();
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
    const station = new FakeManagedTerminalLifecycle();
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
    const station = new FakeManagedTerminalLifecycle();
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
    const station = new FakeManagedTerminalLifecycle();
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
    const station = new FakeManagedTerminalLifecycle();
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

  it("rejects when the managed terminal lifecycle is not registered", async () => {
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
    ).rejects.toMatchObject({
      code: "TERMINAL_PROVIDER_UNAVAILABLE",
      message: "No managed terminal lifecycle is registered for external launch.",
    });
  });

  it("returns an existing live session without a managed lifecycle", async () => {
    const registry = new ProviderRegistry({
      worktree: new FakeWorktreeProvider({ id: "fake-worktree" }),
      terminal: new FakeTerminalProvider({ now: () => new Date(now) }),
      harnesses: [new FakeHarnessProvider({ id: "fake-harness", now: () => new Date(now) })],
    });
    await expect(
      prepareExternalLaunch(
        {
          core: fakeCore([row({ agentSessionId: "ses_existing" })]),
          providers: registry,
          persistence: fakePersistence,
          clock: { now: () => new Date(now) },
        },
        prepareParams,
      ),
    ).resolves.toEqual({
      outcome: {
        kind: "existing-session",
        sessionId: "ses_existing",
        harnessProvider: "fake-harness",
      },
      reconcile: false,
    });
  });

  it("rejects a worktree that belongs to another configured project", async () => {
    const station = new FakeManagedTerminalLifecycle();
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
    const station = new FakeManagedTerminalLifecycle();
    await expect(
      prepareExternalLaunch(deps([], station), { projectId: "web", worktreeId: "wt_ghost" }),
    ).rejects.toMatchObject({ code: "WORKTREE_NOT_FOUND" });
    expect(await station.listTargets()).toEqual([]);
  });

  it("rolls back the half-prepared target if buildLaunch fails", async () => {
    const station = new FakeManagedTerminalLifecycle();
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
    expect(station.released).toEqual([managedTargetId("wt_web_feature")]);
  });

  it("releases the opened target when managed process launch fails", async () => {
    const station = new FakeManagedTerminalLifecycle({
      launchFailure: {
        tag: "TerminalProviderError",
        code: "MANAGED_LAUNCH_FAILED",
        message: "launch failed",
      },
    });

    await expect(
      prepareExternalLaunch(deps([row()], station), prepareParams),
    ).rejects.toMatchObject({ code: "MANAGED_LAUNCH_FAILED" });
    expect(station.released).toEqual([managedTargetId("wt_web_feature")]);
    expect(await station.listTargets()).toEqual([]);
  });

  it("preserves the launch failure when rollback release also fails", async () => {
    const station = new FakeManagedTerminalLifecycle({
      launchFailure: {
        tag: "TerminalProviderError",
        code: "MANAGED_LAUNCH_FAILED",
        message: "launch failed",
      },
      releaseFailure: {
        tag: "TerminalProviderError",
        code: "MANAGED_RELEASE_FAILED",
        message: "release failed",
      },
    });

    await expect(
      prepareExternalLaunch(deps([row()], station), prepareParams),
    ).rejects.toMatchObject({ code: "MANAGED_LAUNCH_FAILED" });
    expect(station.released).toEqual([managedTargetId("wt_web_feature")]);
  });
});

describe("reportExternalExit", () => {
  it("drops the registered target and asks for a reconcile", async () => {
    const station = new FakeManagedTerminalLifecycle();
    await prepareExternalLaunch(deps([row()], station), prepareParams);
    const targetId = managedTargetId("wt_web_feature");

    const exit = await reportExternalExit(deps([row()], station), { terminalTargetId: targetId });
    expect(exit).toEqual({
      outcome: { acknowledged: true, terminalTargetId: targetId },
      reconcile: true,
    });
    expect(station.released).toEqual([targetId]);
    expect(await station.listTargets()).toEqual([]);

    await expect(
      reportExternalExit(deps([row()], station), { terminalTargetId: targetId }),
    ).resolves.toEqual({
      outcome: { acknowledged: false, terminalTargetId: targetId },
      reconcile: false,
    });
  });

  it("acknowledges an unknown target without asking for a reconcile", async () => {
    const station = new FakeManagedTerminalLifecycle();
    const exit = await reportExternalExit(deps([row()], station), {
      terminalTargetId: "managed://nope",
    });
    expect(exit).toEqual({
      outcome: { acknowledged: false, terminalTargetId: "managed://nope" },
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
      const station = new FakeManagedTerminalLifecycle();
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
    const station = new FakeManagedTerminalLifecycle();
    const result = await prepareExternalLaunch(deps([row()], station), prepareParams);
    expect(result.outcome.kind).toBe("prepared");
  });
});

describe("prepareExternalLaunch reattachment", () => {
  it("attaches a reattachHandle to the prepared result", async () => {
    const station = new FakeManagedTerminalLifecycle({
      started: true,
      reattach: { endpointId: "endpoint-1", socketPath: "/tmp/managed-test.sock" },
    });
    const result = await prepareExternalLaunch(deps([row()], station), prepareParams);
    if (result.outcome.kind !== "prepared") throw new Error("expected prepared");
    expect(result.outcome.reattachHandle).toMatchObject({
      ptyId: "endpoint-1",
      terminalTargetId: managedTargetId("wt_web_feature"),
      hostSocketPath: "/tmp/managed-test.sock",
    });
  });

  it("attaches a reattachHandle to an existing-session result", async () => {
    const station = new FakeManagedTerminalLifecycle({
      reattach: { endpointId: "endpoint-1", socketPath: "/tmp/managed-test.sock" },
    });
    station.seedTarget({ worktreeId: "wt_web_feature", sessionId: "ses_live" });
    const result = await prepareExternalLaunch(
      deps([row({ agentSessionId: "ses_live" })], station),
      prepareParams,
    );
    expect(result.outcome).toMatchObject({
      kind: "existing-session",
      sessionId: "ses_live",
      harnessProvider: "fake-harness",
      reattachHandle: {
        ptyId: "endpoint-1",
        terminalTargetId: managedTargetId("wt_web_feature"),
      },
    });
  });

  it("does not attach a replacement target from a different session", async () => {
    const station = new FakeManagedTerminalLifecycle({
      reattach: { endpointId: "endpoint-new", socketPath: "/tmp/managed-test.sock" },
    });
    station.seedTarget({ worktreeId: "wt_web_feature", sessionId: "ses_replacement" });

    await expect(
      prepareExternalLaunch(deps([row({ agentSessionId: "ses_live" })], station), prepareParams),
    ).resolves.toEqual({
      outcome: {
        kind: "existing-session",
        sessionId: "ses_live",
        harnessProvider: "fake-harness",
      },
      reconcile: false,
    });
  });

  it("omits the reattachHandle when the managed adapter does not start the process", async () => {
    const station = new FakeManagedTerminalLifecycle();
    const result = await prepareExternalLaunch(deps([row()], station), prepareParams);
    if (result.outcome.kind !== "prepared") throw new Error("expected prepared");
    expect(result.outcome.reattachHandle).toBeUndefined();
  });
});
