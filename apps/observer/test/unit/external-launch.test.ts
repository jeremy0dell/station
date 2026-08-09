import type {
  AgentState,
  BuildHarnessLaunchRequest,
  HarnessHooksStatus,
  HarnessLaunchPlan,
  ManagedOpenWorkspaceResult,
  ManagedTerminalAttachment,
  ManagedTerminalLaunchProcessRequest,
  ManagedTerminalLaunchProcessResult,
  ManagedTerminalLifecycle,
  OpenWorkspaceRequest,
  ProviderHealth,
  ProviderId,
  ProviderProjectConfig,
  ReleaseManagedTerminalTargetRequest,
  SafeError,
  SessionRecoveryHandle,
  StationSnapshot,
  TerminalAttachment,
  TerminalCapabilities,
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
import type { SessionStore } from "../../src/persistence/index";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ObserverCore } from "../../src/reconcile/core";
import { prepareExternalLaunch, reportExternalExit } from "../../src/runtime/externalLaunch";
import {
  createWorktreeMutationCoordinator,
  type WorktreeMutationCoordinator,
} from "../../src/worktreeMutationCoordinator";
import { createInMemoryObserverPersistence } from "../support/inMemoryObserverPersistence";

const now = "2026-05-21T12:00:00.000Z";

function managedTargetId(worktreeId: string): TerminalTargetId {
  return `managed://${worktreeId}` as TerminalTargetId;
}

type FakeManagedTerminalOptions = {
  started?: boolean;
  attachment?: ManagedTerminalAttachment;
  outputCompatibility?: "top-region-scrollback";
  launchFailure?: SafeError;
  releaseFailure?: SafeError;
  releaseResult?: boolean;
};

/** Deliberately differs from the Station adapter in both provider id and target format. */
class FakeManagedTerminalLifecycle implements ManagedTerminalLifecycle {
  readonly id: ProviderId = "managed-test";
  readonly released: ReleaseManagedTerminalTargetRequest[] = [];

  readonly #targets: TerminalTargetObservation[] = [];
  readonly #terminal: FakeTerminalProvider;
  readonly #started: boolean;
  readonly #attachment: ManagedTerminalAttachment | undefined;
  readonly #outputCompatibility: "top-region-scrollback" | undefined;
  readonly #launchFailure: SafeError | undefined;
  readonly #releaseFailure: SafeError | undefined;
  readonly #releaseResult: boolean;
  readonly #bindingTokens = new Map<TerminalTargetId, string>();
  #bindingSequence = 0;

  constructor(options: FakeManagedTerminalOptions = {}) {
    this.#terminal = new FakeTerminalProvider({
      id: this.id,
      now: () => new Date(now),
      targets: this.#targets,
    });
    this.#started = options.started ?? false;
    this.#attachment = options.attachment;
    this.#outputCompatibility = options.outputCompatibility;
    this.#launchFailure = options.launchFailure;
    this.#releaseFailure = options.releaseFailure;
    this.#releaseResult = options.releaseResult ?? true;
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

  async openWorkspace(request: OpenWorkspaceRequest): Promise<ManagedOpenWorkspaceResult> {
    return this.openManagedWorkspace(request);
  }

  async openManagedWorkspace(request: OpenWorkspaceRequest): Promise<ManagedOpenWorkspaceResult> {
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
    const bindingToken = `binding_${++this.#bindingSequence}`;
    this.#bindingTokens.set(targetId, bindingToken);
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
      bindingToken,
    };
  }

  async launchManagedProcess(
    request: ManagedTerminalLaunchProcessRequest,
  ): Promise<ManagedTerminalLaunchProcessResult> {
    if (this.#launchFailure !== undefined) {
      throw this.#launchFailure;
    }
    const result = {
      terminalTargetId: request.terminalTarget.targetId,
      agentEndpointId: request.agentEndpointId,
    };
    if (!this.#started) {
      return {
        ...result,
        started: false,
        ...(this.#outputCompatibility === undefined
          ? {}
          : { outputCompatibility: this.#outputCompatibility }),
      } as ManagedTerminalLaunchProcessResult;
    }
    if (this.#attachment === undefined) {
      throw new Error("Fake managed terminal needs an attachment when started.");
    }
    return { ...result, started: true, attachment: this.#attachment };
  }

  async attachmentForTarget(
    targetId: TerminalTargetId,
  ): Promise<ManagedTerminalAttachment | undefined> {
    return this.#targets.some((target) => target.id === targetId) ? this.#attachment : undefined;
  }

  async releaseTarget(request: ReleaseManagedTerminalTargetRequest): Promise<boolean> {
    this.released.push(request);
    if (this.#releaseFailure !== undefined) {
      throw this.#releaseFailure;
    }
    if (!this.#releaseResult) {
      return false;
    }
    const index = this.#targets.findIndex(
      (target) =>
        target.id === request.targetId &&
        target.sessionId === request.expectedSessionId &&
        (request.expectedBindingToken === undefined ||
          this.#bindingTokens.get(request.targetId) === request.expectedBindingToken),
    );
    if (index < 0) {
      return false;
    }
    this.#targets.splice(index, 1);
    this.#bindingTokens.delete(request.targetId);
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
    title: "Readable login task",
    branch: "feature/login",
    path: "/tmp/station/web/feature",
    worktree: { state: "exists", source: "worktrunk" },
    display: { statusLabel: "no agent", sortPriority: 0, alert: false },
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

function retainedSession(
  overrides: Partial<StationSnapshot["sessions"][number]> = {},
): StationSnapshot["sessions"][number] {
  return {
    id: "ses_recoverable",
    origin: "station",
    projectId: "web",
    worktreeId: "wt_web_feature",
    createdAt: now,
    updatedAt: now,
    harness: {
      provider: "fake-harness",
      mode: "interactive",
      capabilities: {
        canLaunch: true,
        canDiscoverRuns: true,
        canEmitEvents: true,
        canClassifyStatus: true,
        canReceivePrompt: false,
        canResume: true,
        canStop: true,
        canRunNonInteractive: true,
        canExposeApprovalState: true,
        supportsModifiedEnterSoftNewline: false,
      },
    },
    status: {
      value: "none",
      confidence: "low",
      reason: "No harness run is currently observed for this Station session.",
      source: "reconcile",
      updatedAt: now,
    },
    title: "Readable login task",
    tags: [],
    ...overrides,
  };
}

function recoveryHandle(overrides: Partial<SessionRecoveryHandle> = {}): SessionRecoveryHandle {
  return {
    id: "rec_recoverable",
    provider: "fake-harness",
    projectId: "web",
    worktreeId: "wt_web_feature",
    sessionId: "ses_recoverable",
    target: { kind: "native-session", id: "native_recoverable" },
    cwd: "/tmp/station/web/feature",
    observedAt: now,
    lastSeenAt: now,
    ...overrides,
  };
}

function snapshotWith(
  rows: WorktreeRow[],
  sessions: StationSnapshot["sessions"] = [],
): StationSnapshot {
  return { rows, sessions } as unknown as StationSnapshot;
}

function fakeCore(rows: WorktreeRow[], sessions: StationSnapshot["sessions"] = []): ObserverCore {
  const snapshot = snapshotWith(rows, sessions);
  return {
    getProjects: () => [project],
    getSnapshot: () => snapshot,
    reconcile: async () => snapshot,
    projectHarnessEventStatus: async () => ({}) as never,
    updateConfig: () => {},
    getHealth: () => ({}) as never,
  } as unknown as ObserverCore;
}

function trackingPersistence() {
  const seeded: Array<Parameters<SessionStore["seedSession"]>[0]> = [];
  const renamed: Array<Parameters<SessionStore["renameSession"]>[0]> = [];
  const discarded: Array<Parameters<SessionStore["discardSessionSeed"]>[0]> = [];
  const store = {
    findRememberedHarnessProviderForWorktree: async () => undefined,
    seedSession: async (input: Parameters<SessionStore["seedSession"]>[0]) => {
      seeded.push(input);
      return {} as Awaited<ReturnType<SessionStore["seedSession"]>>;
    },
    renameSession: async (input: Parameters<SessionStore["renameSession"]>[0]) => {
      renamed.push(input);
      return {} as Awaited<ReturnType<SessionStore["renameSession"]>>;
    },
    discardSessionSeed: async (input: Parameters<SessionStore["discardSessionSeed"]>[0]) => {
      discarded.push(input);
      return { discardedSessions: 1, discardedWorktreeTitles: 0 };
    },
  } as unknown as SessionStore;
  return { store, seeded, renamed, discarded };
}

const fakePersistence = trackingPersistence().store;

/** A harness that reports hook installation status (the gate input). */
class HookableHarness extends FakeHarnessProvider {
  healthCalls = 0;
  hooksCalls = 0;
  readonly #installed: boolean;
  readonly #requested: boolean;
  constructor(installed: boolean, requested = true) {
    super({ id: "fake-harness", now: () => new Date(now) });
    this.#installed = installed;
    this.#requested = requested;
  }
  override async health(): Promise<ProviderHealth> {
    this.healthCalls += 1;
    return super.health();
  }
  async hooksStatus(): Promise<HarnessHooksStatus> {
    this.hooksCalls += 1;
    return {
      provider: this.id,
      installed: this.#installed,
      requested: this.#requested,
      missing: this.#installed ? [] : ["SessionStart"],
      message: this.#installed ? "Installed." : "Hooks are not installed.",
    };
  }
}

class CapturingHarness extends FakeHarnessProvider {
  readonly requests: BuildHarnessLaunchRequest[] = [];

  override async buildLaunch(request: BuildHarnessLaunchRequest): Promise<HarnessLaunchPlan> {
    this.requests.push(request);
    return super.buildLaunch(request);
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
  persistence: SessionStore = createInMemoryObserverPersistence({
    clock: { now: () => new Date(now) },
  }),
  options: {
    sessions?: StationSnapshot["sessions"];
    sessionResumeAgentEnabled?: boolean;
    worktreeMutations?: WorktreeMutationCoordinator;
  } = {},
) {
  return {
    core: fakeCore(rows, options.sessions),
    providers: registryWith(managedTerminal, harnesses),
    persistence,
    clock: { now: () => new Date(now) },
    sessionResumeAgentEnabled: options.sessionResumeAgentEnabled ?? false,
    worktreeMutations: options.worktreeMutations ?? createWorktreeMutationCoordinator(),
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
    const launchDeps = deps([row()], station);
    const result = await prepareExternalLaunch(launchDeps, prepareParams);

    expect(result.reconcile).toBe(true);
    expect(result.outcome.kind).toBe("prepared");
    if (result.outcome.kind !== "prepared") throw new Error("expected prepared");
    expect(result.outcome.sessionId).toMatch(/^ses_/);
    expect(result.outcome.terminalTargetId).toBe(managedTargetId("wt_web_feature"));
    expect(result.outcome.launchPlan.provider).toBe("fake-harness");
    expect(result.outcome.launchPlan.env?.STATION_SESSION_ID).toBe(result.outcome.sessionId);
    expect(result.outcome).not.toHaveProperty("outputCompatibility");

    // Exactly one station target was registered for the worktree.
    const targets = await station.listTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0]?.harnessBinding?.role).toBe("main-agent");
    await expect(launchDeps.persistence.listSessions()).resolves.toEqual([
      expect.objectContaining({
        id: result.outcome.sessionId,
        title: "Readable login task",
      }),
    ]);
    await expect(launchDeps.persistence.listWorktreeDisplayTitles()).resolves.toEqual([
      expect.objectContaining({
        projectId: "web",
        worktreeId: "wt_web_feature",
        title: "Readable login task",
      }),
    ]);
  });

  it("propagates local output compatibility from the managed terminal adapter", async () => {
    const station = new FakeManagedTerminalLifecycle({
      outputCompatibility: "top-region-scrollback",
    });

    const result = await prepareExternalLaunch(deps([row()], station), prepareParams);

    expect(result.outcome).toMatchObject({
      kind: "prepared",
      outputCompatibility: "top-region-scrollback",
    });
  });

  it("persists a custom title before exposing a newly prepared session", async () => {
    const station = new FakeManagedTerminalLifecycle();
    const persistence = trackingPersistence();

    const result = await prepareExternalLaunch(
      deps([row()], station, undefined, persistence.store),
      { ...prepareParams, title: "Hexagonal PT 12" },
    );

    expect(result.outcome.kind).toBe("prepared");
    if (result.outcome.kind !== "prepared") throw new Error("expected prepared");
    expect(persistence.seeded).toEqual([
      expect.objectContaining({
        sessionId: result.outcome.sessionId,
        projectId: "web",
        worktreeId: "wt_web_feature",
        initialTitle: "Hexagonal PT 12",
      }),
    ]);
    expect(persistence.renamed).toEqual([
      expect.objectContaining({
        sessionId: result.outcome.sessionId,
        title: "Hexagonal PT 12",
      }),
    ]);
    expect(persistence.discarded).toEqual([]);
  });

  it("preserves unavailable health and creates no title or managed target", async () => {
    const station = new FakeManagedTerminalLifecycle();
    const persistence = trackingPersistence();
    const healthError: SafeError = {
      tag: "ProviderUnavailableError",
      code: "FAKE_CLI_MISSING",
      message: "The selected harness CLI is unavailable.",
      provider: "fake-harness",
    };
    const harness = new FakeHarnessProvider({
      id: "fake-harness",
      now: () => new Date(now),
      health: { status: "unavailable", lastError: healthError },
    });

    await expect(
      prepareExternalLaunch(deps([row()], station, [harness], persistence.store), prepareParams),
    ).rejects.toEqual(healthError);
    expect(await station.listTargets()).toEqual([]);
    expect(persistence.seeded).toEqual([]);
    expect(persistence.renamed).toEqual([]);
    expect(persistence.discarded).toEqual([]);
  });

  it("rejects when the harness's status hooks are not installed", async () => {
    const station = new FakeManagedTerminalLifecycle();
    await expect(
      prepareExternalLaunch(
        {
          ...deps([row()], station, [new HookableHarness(false)]),
          configPath: "/tmp/custom station/config.toml",
        },
        prepareParams,
      ),
    ).rejects.toMatchObject({
      tag: "CommandValidationError",
      code: "HARNESS_HOOKS_NOT_INSTALLED",
      provider: "fake-harness",
      hint: "Run `stn --config '/tmp/custom station/config.toml' hooks install fake-harness --yes`, then `stn --config '/tmp/custom station/config.toml' hooks doctor fake-harness` to confirm, and retry.",
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
    const attachment: ManagedTerminalAttachment = {
      kind: "managed-terminal",
      terminalTargetId: managedTargetId("wt_web_feature"),
    };
    const station = new FakeManagedTerminalLifecycle({ started: true, attachment });
    const first = await prepareExternalLaunch(deps([row()], station), prepareParams);
    if (first.outcome.kind !== "prepared") throw new Error("expected prepared");

    // The fake core never reconciles, so row.agent is still undefined — but the
    // station provider already holds a target, so a second prepare must not mint
    // a second identity.
    const secondDeps = deps([row()], station);
    const second = await prepareExternalLaunch(secondDeps, prepareParams);
    expect(second).toEqual({
      outcome: {
        kind: "existing-session",
        sessionId: first.outcome.sessionId,
        harnessProvider: "fake-harness",
        attachment,
      },
      reconcile: false,
    });
    expect(await station.listTargets()).toHaveLength(1);
    await expect(secondDeps.persistence.listWorktreeDisplayTitles()).resolves.toEqual([]);
  });

  it("returns the existing session id without applying a requested title", async () => {
    const station = new FakeManagedTerminalLifecycle();
    const persistence = trackingPersistence();
    const harness = new HookableHarness(false);
    const result = await prepareExternalLaunch(
      deps([row({ agentSessionId: "ses_existing" })], station, [harness], persistence.store),
      { ...prepareParams, title: "Do not rename me" },
    );
    expect(result).toEqual({
      outcome: {
        kind: "existing-session",
        sessionId: "ses_existing",
        harnessProvider: "fake-harness",
      },
      reconcile: false,
    });
    // No title or target is created when an agent already exists.
    expect(persistence.seeded).toEqual([]);
    expect(persistence.renamed).toEqual([]);
    expect(persistence.discarded).toEqual([]);
    expect(await station.listTargets()).toEqual([]);
    expect(harness.healthCalls).toBe(0);
    expect(harness.hooksCalls).toBe(0);
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

  it("recovers the exact canonical Station session through typed provider resume options", async () => {
    const persistence = createInMemoryObserverPersistence({
      clock: { now: () => new Date(now) },
    });
    await persistence.seedSession({
      sessionId: "ses_recoverable",
      projectId: "web",
      worktreeId: "wt_web_feature",
      initialTitle: "Readable login task",
      createdAt: now,
      lastSeenAt: now,
    });
    await persistence.renameSession({
      sessionId: "ses_recoverable",
      title: "Canonical recovered title",
      renamedAt: now,
    });
    const persistedHandle = await persistence.upsertSessionRecoveryHandle(recoveryHandle());
    const harness = new CapturingHarness({ id: "fake-harness", now: () => new Date(now) });
    const station = new FakeManagedTerminalLifecycle();

    const result = await prepareExternalLaunch(
      deps([row()], station, [harness], persistence, {
        sessions: [retainedSession({ title: "Canonical recovered title" })],
        sessionResumeAgentEnabled: true,
      }),
      { ...prepareParams, title: "Ignored fresh title" },
    );

    expect(result).toMatchObject({
      reconcile: true,
      outcome: {
        kind: "prepared",
        sessionId: "ses_recoverable",
        terminalTargetId: managedTargetId("wt_web_feature"),
      },
    });
    expect(harness.requests).toEqual([
      expect.objectContaining({
        sessionId: "ses_recoverable",
        resume: {
          target: { kind: "native-session", id: "native_recoverable" },
          previousSessionId: "ses_recoverable",
          recoveryHandleId: persistedHandle.id,
        },
      }),
    ]);
    await expect(persistence.listSessions()).resolves.toEqual([
      expect.objectContaining({ id: "ses_recoverable", title: "Canonical recovered title" }),
    ]);
    await expect(persistence.listSessionRecoveryHandles()).resolves.toEqual([persistedHandle]);
  });

  it("returns an adopted Host target before recovery or its feature gate", async () => {
    const attachment: ManagedTerminalAttachment = {
      kind: "managed-terminal",
      terminalTargetId: managedTargetId("wt_web_feature"),
    };
    const station = new FakeManagedTerminalLifecycle({ started: true, attachment });
    station.seedTarget({ worktreeId: "wt_web_feature", sessionId: "ses_recoverable" });
    const harness = new HookableHarness(false);

    const result = await prepareExternalLaunch(
      deps(
        [row({ agentSessionId: "ses_recoverable", agentState: "unknown", terminalState: "stale" })],
        station,
        [harness],
        fakePersistence,
        { sessions: [retainedSession()] },
      ),
      prepareParams,
    );

    expect(result).toEqual({
      outcome: {
        kind: "existing-session",
        sessionId: "ses_recoverable",
        harnessProvider: "fake-harness",
        attachment,
      },
      reconcile: false,
    });
    expect(harness.healthCalls).toBe(0);
    expect(harness.hooksCalls).toBe(0);
  });

  it("fails an interrupted canonical session when automatic resume is disabled", async () => {
    const station = new FakeManagedTerminalLifecycle();
    const persistence = trackingPersistence();

    await expect(
      prepareExternalLaunch(
        deps([row()], station, undefined, persistence.store, {
          sessions: [retainedSession()],
        }),
        prepareParams,
      ),
    ).rejects.toMatchObject({
      tag: "CommandValidationError",
      code: "SESSION_RESUME_DISABLED",
      sessionId: "ses_recoverable",
    });
    expect(await station.listTargets()).toEqual([]);
    expect(persistence.seeded).toEqual([]);
  });

  it("fails recovery validation before terminal mutation", async () => {
    const station = new FakeManagedTerminalLifecycle();
    await expect(
      prepareExternalLaunch(
        deps([row()], station, undefined, undefined, {
          sessions: [retainedSession()],
          sessionResumeAgentEnabled: true,
        }),
        prepareParams,
      ),
    ).rejects.toMatchObject({ code: "SESSION_RECOVERY_HANDLE_NOT_FOUND" });
    expect(await station.listTargets()).toEqual([]);
  });

  it("starts fresh for an explicitly ended session without consuming its old handle", async () => {
    const persistence = createInMemoryObserverPersistence({
      clock: { now: () => new Date(now) },
    });
    await persistence.seedSession({
      sessionId: "ses_recoverable",
      projectId: "web",
      worktreeId: "wt_web_feature",
      initialTitle: "Readable login task",
      createdAt: now,
      lastSeenAt: now,
    });
    await persistence.markSessionsEnded({
      subject: { kind: "session", sessionId: "ses_recoverable" },
      endedAt: now,
    });
    const persistedHandle = await persistence.upsertSessionRecoveryHandle(recoveryHandle());
    const harness = new CapturingHarness({ id: "fake-harness", now: () => new Date(now) });
    const station = new FakeManagedTerminalLifecycle();

    const result = await prepareExternalLaunch(
      deps(
        [row({ agentSessionId: "ses_recoverable", agentState: "exited" })],
        station,
        [harness],
        persistence,
        { sessionResumeAgentEnabled: true },
      ),
      prepareParams,
    );

    expect(result.outcome.kind).toBe("prepared");
    if (result.outcome.kind !== "prepared") throw new Error("expected prepared");
    expect(result.outcome.sessionId).not.toBe("ses_recoverable");
    expect(harness.requests[0]).not.toHaveProperty("resume");
    await expect(persistence.listSessionRecoveryHandles()).resolves.toEqual([persistedHandle]);
  });

  it("rechecks canonical membership after session close wins the worktree mutation lane", async () => {
    const persistence = createInMemoryObserverPersistence({
      clock: { now: () => new Date(now) },
    });
    await persistence.upsertSessionRecoveryHandle(recoveryHandle());
    const harness = new CapturingHarness({ id: "fake-harness", now: () => new Date(now) });
    const station = new FakeManagedTerminalLifecycle();
    const worktreeMutations = createWorktreeMutationCoordinator();
    let snapshot = snapshotWith([row()], [retainedSession()]);
    const core = {
      ...fakeCore([row()], [retainedSession()]),
      getSnapshot: () => snapshot,
    } as ObserverCore;
    let closeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      closeStarted = resolve;
    });
    let finishClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const close = worktreeMutations.run("web", "wt_web_feature", async () => {
      closeStarted();
      await closeGate;
      snapshot = snapshotWith([row()], []);
    });
    await started;
    const launchDeps = deps([row()], station, [harness], persistence, {
      sessions: [retainedSession()],
      sessionResumeAgentEnabled: true,
      worktreeMutations,
    });
    launchDeps.core = core;
    const launch = prepareExternalLaunch(launchDeps, prepareParams);

    finishClose();
    await close;
    const result = await launch;

    expect(result.outcome).toMatchObject({ kind: "prepared" });
    if (result.outcome.kind !== "prepared") throw new Error("expected prepared");
    expect(result.outcome.sessionId).not.toBe("ses_recoverable");
    expect(harness.requests[0]).not.toHaveProperty("resume");
  });

  it.each([
    "harness build",
    "managed process launch",
  ] as const)("preserves retained session state when recovered %s fails", async (failureStage) => {
    const persistence = createInMemoryObserverPersistence({
      clock: { now: () => new Date(now) },
    });
    await persistence.seedSession({
      sessionId: "ses_recoverable",
      projectId: "web",
      worktreeId: "wt_web_feature",
      initialTitle: "Readable login task",
      createdAt: now,
      lastSeenAt: now,
    });
    await persistence.renameSession({
      sessionId: "ses_recoverable",
      title: "Canonical recovered title",
      renamedAt: now,
    });
    await persistence.upsertSessionTurnReadiness({
      sessionId: "ses_recoverable",
      projectId: "web",
      worktreeId: "wt_web_feature",
      token: "ready_recoverable",
      completedAt: now,
    });
    const persistedHandle = await persistence.upsertSessionRecoveryHandle(recoveryHandle());
    const failure: SafeError =
      failureStage === "harness build"
        ? {
            tag: "HarnessProviderError",
            code: "HARNESS_BUILD_LAUNCH_FAILED",
            message: "build failed",
          }
        : {
            tag: "TerminalProviderError",
            code: "MANAGED_LAUNCH_FAILED",
            message: "launch failed",
          };
    const harness = new FakeHarnessProvider({
      id: "fake-harness",
      now: () => new Date(now),
      ...(failureStage === "harness build" ? { failures: { buildLaunch: failure } } : {}),
    });
    const station = new FakeManagedTerminalLifecycle(
      failureStage === "managed process launch" ? { launchFailure: failure } : {},
    );

    await expect(
      prepareExternalLaunch(
        deps([row()], station, [harness], persistence, {
          sessions: [retainedSession({ title: "Canonical recovered title" })],
          sessionResumeAgentEnabled: true,
        }),
        prepareParams,
      ),
    ).rejects.toEqual(failure);

    expect(station.released).toEqual([
      {
        targetId: managedTargetId("wt_web_feature"),
        expectedSessionId: "ses_recoverable",
        expectedBindingToken: "binding_1",
      },
    ]);
    expect(await station.listTargets()).toEqual([]);
    await expect(persistence.listSessions()).resolves.toEqual([
      expect.objectContaining({
        id: "ses_recoverable",
        lifecycle: "open",
        title: "Canonical recovered title",
      }),
    ]);
    await expect(persistence.listSessionTurnReadiness()).resolves.toEqual([
      expect.objectContaining({ sessionId: "ses_recoverable", token: "ready_recoverable" }),
    ]);
    await expect(persistence.listSessionRecoveryHandles()).resolves.toEqual([persistedHandle]);
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
          worktreeMutations: createWorktreeMutationCoordinator(),
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
          worktreeMutations: createWorktreeMutationCoordinator(),
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
          worktreeMutations: createWorktreeMutationCoordinator(),
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
    expect(station.released).toEqual([
      {
        targetId: managedTargetId("wt_web_feature"),
        expectedSessionId: expect.stringMatching(/^ses_/),
        expectedBindingToken: "binding_1",
      },
    ]);
  });

  it("releases the opened target and discards only the failed session projection", async () => {
    const station = new FakeManagedTerminalLifecycle({
      launchFailure: {
        tag: "TerminalProviderError",
        code: "MANAGED_LAUNCH_FAILED",
        message: "launch failed",
      },
    });
    const launchDeps = deps([row()], station);

    await expect(prepareExternalLaunch(launchDeps, prepareParams)).rejects.toMatchObject({
      code: "MANAGED_LAUNCH_FAILED",
    });
    expect(station.released).toEqual([
      {
        targetId: managedTargetId("wt_web_feature"),
        expectedSessionId: expect.stringMatching(/^ses_/),
        expectedBindingToken: "binding_1",
      },
    ]);
    expect(await station.listTargets()).toEqual([]);
    await expect(launchDeps.persistence.listSessions()).resolves.toEqual([]);
    await expect(launchDeps.persistence.listWorktreeDisplayTitles()).resolves.toEqual([
      expect.objectContaining({
        worktreeId: "wt_web_feature",
        title: "Readable login task",
      }),
    ]);
  });

  it("preserves the launch failure and seed when target release is uncertain", async () => {
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
    const persistence = trackingPersistence();

    await expect(
      prepareExternalLaunch(deps([row()], station, undefined, persistence.store), {
        ...prepareParams,
        title: "Hexagonal PT 12",
      }),
    ).rejects.toMatchObject({ code: "MANAGED_LAUNCH_FAILED" });
    expect(station.released).toEqual([
      {
        targetId: managedTargetId("wt_web_feature"),
        expectedSessionId: persistence.seeded[0]?.sessionId,
        expectedBindingToken: "binding_1",
      },
    ]);
    expect(persistence.discarded).toEqual([]);
    expect(await station.listTargets()).toHaveLength(1);
  });

  it("preserves the failed seed when exact target release is refused", async () => {
    const station = new FakeManagedTerminalLifecycle({
      launchFailure: {
        tag: "TerminalProviderError",
        code: "MANAGED_LAUNCH_FAILED",
        message: "launch failed",
      },
      releaseResult: false,
    });
    const persistence = trackingPersistence();

    await expect(
      prepareExternalLaunch(deps([row()], station, undefined, persistence.store), prepareParams),
    ).rejects.toMatchObject({ code: "MANAGED_LAUNCH_FAILED" });

    expect(station.released).toEqual([
      {
        targetId: managedTargetId("wt_web_feature"),
        expectedSessionId: persistence.seeded[0]?.sessionId,
        expectedBindingToken: "binding_1",
      },
    ]);
    expect(persistence.discarded).toEqual([]);
    expect(await station.listTargets()).toHaveLength(1);
  });
});

describe("reportExternalExit", () => {
  it("drops the registered target and asks for a reconcile", async () => {
    const station = new FakeManagedTerminalLifecycle();
    const prepared = await prepareExternalLaunch(deps([row()], station), prepareParams);
    if (prepared.outcome.kind !== "prepared") throw new Error("expected prepared launch");
    const targetId = managedTargetId("wt_web_feature");

    const exit = await reportExternalExit(deps([row()], station), {
      terminalTargetId: targetId,
      expectedSessionId: prepared.outcome.sessionId,
      expectedBindingToken: prepared.outcome.terminalBindingToken,
    });
    expect(exit).toEqual({
      outcome: { acknowledged: true, terminalTargetId: targetId },
      reconcile: true,
    });
    expect(station.released).toEqual([
      {
        targetId,
        expectedSessionId: prepared.outcome.sessionId,
        expectedBindingToken: prepared.outcome.terminalBindingToken,
      },
    ]);
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
      expectedSessionId: "ses_missing",
    });
    expect(exit).toEqual({
      outcome: { acknowledged: false, terminalTargetId: "managed://nope" },
      reconcile: false,
    });
  });

  it("fails closed when the report omits its expected session", async () => {
    const station = new FakeManagedTerminalLifecycle();
    station.seedTarget({ worktreeId: "wt_web_feature", sessionId: "ses_current" });

    const exit = await reportExternalExit(deps([row()], station), {
      terminalTargetId: managedTargetId("wt_web_feature"),
    });

    expect(exit.reconcile).toBe(false);
    expect(exit.outcome.acknowledged).toBe(false);
    expect(station.released).toEqual([]);
    expect(await station.listTargets()).toMatchObject([{ sessionId: "ses_current" }]);
  });

  it("does not let a delayed old-session exit release its replacement", async () => {
    const station = new FakeManagedTerminalLifecycle();
    station.seedTarget({ worktreeId: "wt_web_feature", sessionId: "ses_old" });
    await station.openManagedWorkspace({
      project,
      worktree: {
        id: "wt_web_feature",
        provider: "fake-worktree",
        projectId: "web",
        branch: "feature/login",
        path: "/tmp/station/web/feature",
        state: "exists",
        source: "worktrunk",
        observedAt: now,
      },
      harness: "fake-harness",
      layout: "agent-shell",
      sessionId: "ses_replacement",
    });

    const staleExit = await reportExternalExit(deps([row()], station), {
      terminalTargetId: managedTargetId("wt_web_feature"),
      expectedSessionId: "ses_old",
    });

    expect(staleExit).toEqual({
      outcome: {
        acknowledged: false,
        terminalTargetId: managedTargetId("wt_web_feature"),
      },
      reconcile: false,
    });
    expect(await station.listTargets()).toMatchObject([{ sessionId: "ses_replacement" }]);
  });

  it("does not let a stale same-session exit release a newer binding generation", async () => {
    const station = new FakeManagedTerminalLifecycle();
    const observedWorktree = {
      id: "wt_web_feature",
      provider: "fake-worktree",
      projectId: "web",
      branch: "feature/login",
      path: "/tmp/station/web/feature",
      state: "exists" as const,
      source: "worktrunk" as const,
      observedAt: now,
    };
    const first = await station.openManagedWorkspace({
      project,
      worktree: observedWorktree,
      harness: "fake-harness",
      layout: "agent-shell",
      sessionId: "ses_recoverable",
    });
    const replacement = await station.openManagedWorkspace({
      project,
      worktree: observedWorktree,
      harness: "fake-harness",
      layout: "agent-shell",
      sessionId: "ses_recoverable",
    });

    const staleExit = await reportExternalExit(deps([row()], station), {
      terminalTargetId: managedTargetId("wt_web_feature"),
      expectedSessionId: "ses_recoverable",
      expectedBindingToken: first.bindingToken,
    });

    expect(staleExit.reconcile).toBe(false);
    expect(staleExit.outcome.acknowledged).toBe(false);
    expect(station.released).toEqual([
      {
        targetId: managedTargetId("wt_web_feature"),
        expectedSessionId: "ses_recoverable",
        expectedBindingToken: first.bindingToken,
      },
    ]);
    expect(replacement.bindingToken).not.toBe(first.bindingToken);
    expect(await station.listTargets()).toMatchObject([{ sessionId: "ses_recoverable" }]);
  });

  it("fails closed when no managed lifecycle is registered", async () => {
    const registry = new ProviderRegistry({
      worktree: new FakeWorktreeProvider({ id: "fake-worktree" }),
      terminal: new FakeTerminalProvider({ now: () => new Date(now) }),
      harnesses: [new FakeHarnessProvider({ id: "fake-harness", now: () => new Date(now) })],
    });

    const exit = await reportExternalExit(
      {
        core: fakeCore([row()]),
        providers: registry,
        persistence: fakePersistence,
        clock: { now: () => new Date(now) },
      },
      {
        terminalTargetId: managedTargetId("wt_web_feature"),
        expectedSessionId: "ses_current",
      },
    );

    expect(exit).toEqual({
      outcome: {
        acknowledged: false,
        terminalTargetId: managedTargetId("wt_web_feature"),
      },
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

describe("prepareExternalLaunch managed attachments", () => {
  it("passes the adapter's opaque attachment through to the prepared result", async () => {
    const attachment: ManagedTerminalAttachment = {
      kind: "managed-terminal",
      terminalTargetId: managedTargetId("wt_web_feature"),
    };
    const station = new FakeManagedTerminalLifecycle({
      started: true,
      attachment,
    });
    const result = await prepareExternalLaunch(deps([row()], station), prepareParams);
    if (result.outcome.kind !== "prepared") throw new Error("expected prepared");
    expect(result.outcome.attachment).toBe(attachment);
    expect(result.outcome).not.toHaveProperty("outputCompatibility");
  });

  it("passes the adapter's opaque attachment through to an existing-session result", async () => {
    const attachment: ManagedTerminalAttachment = {
      kind: "managed-terminal",
      terminalTargetId: managedTargetId("wt_web_feature"),
    };
    const station = new FakeManagedTerminalLifecycle({ attachment });
    station.seedTarget({ worktreeId: "wt_web_feature", sessionId: "ses_live" });
    const result = await prepareExternalLaunch(
      deps([row({ agentSessionId: "ses_live" })], station),
      prepareParams,
    );
    expect(result.outcome).toMatchObject({
      kind: "existing-session",
      sessionId: "ses_live",
      harnessProvider: "fake-harness",
      attachment,
    });
  });

  it("prefers an attachable replacement target over stale snapshot identity", async () => {
    const station = new FakeManagedTerminalLifecycle({
      attachment: {
        kind: "managed-terminal",
        terminalTargetId: managedTargetId("wt_web_feature"),
      },
    });
    station.seedTarget({ worktreeId: "wt_web_feature", sessionId: "ses_replacement" });

    await expect(
      prepareExternalLaunch(deps([row({ agentSessionId: "ses_live" })], station), prepareParams),
    ).resolves.toEqual({
      outcome: {
        kind: "existing-session",
        sessionId: "ses_replacement",
        harnessProvider: "fake-harness",
        attachment: {
          kind: "managed-terminal",
          terminalTargetId: managedTargetId("wt_web_feature"),
        },
      },
      reconcile: false,
    });
  });

  it("omits the attachment when the managed adapter does not start the process", async () => {
    const station = new FakeManagedTerminalLifecycle();
    const result = await prepareExternalLaunch(deps([row()], station), prepareParams);
    if (result.outcome.kind !== "prepared") throw new Error("expected prepared");
    expect(result.outcome.attachment).toBeUndefined();
  });
});
