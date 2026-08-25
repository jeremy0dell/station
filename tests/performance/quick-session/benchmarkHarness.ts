import { DEFAULT_WORKSPACE_CONFIG, type StationConfig } from "@station/config";
import type {
  CommandId,
  CommandRecord,
  CreateWorktreeRequest,
  HarnessEventReport,
  ManagedOpenWorkspaceResult,
  ManagedTerminalAttachment,
  ManagedTerminalLaunchProcessRequest,
  ManagedTerminalLaunchProcessResult,
  ManagedTerminalLifecycle,
  OpenWorkspaceRequest,
  ProviderDoctorCheck,
  ProviderDoctorContext,
  ProviderHealth,
  ProviderProjectConfig,
  ReleaseManagedTerminalTargetRequest,
  RemoveWorktreeRequest,
  RemoveWorktreeResult,
  SafeError,
  StationSnapshot,
  TerminalCapture,
  TerminalFocusContext,
  TerminalLaunchProcessRequest,
  TerminalLaunchProcessResult,
  TerminalTargetId,
  TerminalTargetObservation,
  WorktreeCapabilities,
  WorktreeObservation,
  WorktreeProvider,
} from "@station/contracts";
import { STATION_SCHEMA_VERSION } from "@station/contracts";
import {
  createCommandQueue,
  createObserverApi,
  createObserverCore,
  createObserverEventBus,
  createSqliteObserverPersistence,
  openObserverSqlite,
  ProviderRegistry,
  registerObserverCommandHandlers,
} from "@station/observer/internal";
import {
  createFakeHarnessRun,
  createFakeWorktree,
  FakeHarnessProvider,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "@station/testing";
import { createWorktreeCreateCoordinator } from "../../../apps/observer/src/worktreeCreateCoordinator.js";
import { createWorktreeMutationCoordinator } from "../../../apps/observer/src/worktreeMutationCoordinator.js";
import { createUnexpectedProjectConfigWriter } from "../../../apps/observer/test/support/projectConfigWriter.js";

export const quickSessionStages = [
  "intentAccepted",
  "commandQueued",
  "mutationStarted",
  "mutationCompleted",
  "usableWorktreeObserved",
  "launchRequested",
  "processSpawned",
  "harnessReady",
  "canonicalSessionVisible",
  "optimisticRemoved",
  "focusedAndAcceptingInput",
] as const;

export type QuickSessionStage = (typeof quickSessionStages)[number];

export type QuickSessionSample = {
  branch: string;
  projectId: string;
  commandId: CommandId;
  traceId: string;
  timestampsMs: Record<QuickSessionStage, number>;
  totalMs: number;
  stageMs: {
    queueAndPreflight: number;
    repositoryMutation: number;
    worktreeObservation: number;
    launchPreparationAndSpawn: number;
    harnessReadiness: number;
    canonicalProjection: number;
    optimisticAndFocus: number;
  };
};

export type QuickSessionCosts = {
  mutationMs: number;
  scanBaseMs: number;
  scanPerWorktreeMs: number;
  processSpawnMs: number;
  harnessReadyMs: number;
};

export const defaultQuickSessionCosts: QuickSessionCosts = {
  mutationMs: 4,
  scanBaseMs: 4,
  scanPerWorktreeMs: 0.16,
  processSpawnMs: 1,
  harnessReadyMs: 1,
};

type ActiveRecorder = {
  branch: string;
  mark(stage: QuickSessionStage): void;
  sample(): Omit<QuickSessionSample, "commandId" | "traceId">;
};

export type QuickSessionBenchmarkFixture = {
  api: ReturnType<typeof createObserverApi>;
  config: StationConfig;
  core: ReturnType<typeof createObserverCore>;
  harness: FakeHarnessProvider;
  queue: ReturnType<typeof createCommandQueue>;
  worktree: InstrumentedWorktreeProvider;
  startup(): Promise<void>;
  close(): Promise<void>;
};

export type CreateQuickSessionBenchmarkFixtureOptions = {
  projects?: number;
  worktreesPerProject?: number;
  costs?: Partial<QuickSessionCosts>;
  startup?: boolean;
  failBranches?: ReadonlySet<string>;
  reconcileDebounceMs?: number;
  interactiveReconcileDebounceMs?: number;
};

export async function createQuickSessionBenchmarkFixture(
  options: CreateQuickSessionBenchmarkFixtureOptions = {},
): Promise<QuickSessionBenchmarkFixture> {
  const projectCount = options.projects ?? 1;
  const worktreesPerProject = options.worktreesPerProject ?? 49;
  const costs = { ...defaultQuickSessionCosts, ...options.costs };
  const config = benchmarkConfig(projectCount);
  const initialWorktrees = config.projects.flatMap((project) =>
    Array.from({ length: worktreesPerProject }, (_, index) =>
      createFakeWorktree({
        id: `wt_${project.id}_shape_${index}`,
        projectId: project.id,
        branch: `shape-${index}`,
        path: `/tmp/station-performance/${project.id}/shape-${index}`,
        registrationIdentity: `shape:${project.id}:${index}`,
        now: nowIso(),
      }),
    ),
  );
  const worktree = new InstrumentedWorktreeProvider({
    initialWorktrees,
    costs,
    failBranches: options.failBranches,
  });
  const terminal = new InstrumentedManagedTerminal();
  const harness = new FakeHarnessProvider({ id: "fake-harness", now: nowIso });
  const providers = new ProviderRegistry({
    worktree,
    terminal,
    managedTerminal: terminal,
    harnesses: [harness],
  });
  const clock = { now: () => new Date() };
  const sqlite = openObserverSqlite({ clock });
  const ids = observerIds();
  const persistence = createSqliteObserverPersistence({ sqlite, clock, idFactory: ids });
  const eventBus = createObserverEventBus();
  const queue = createCommandQueue({ persistence, clock, idFactory: ids, eventBus });
  const core = createObserverCore({ config, providers, persistence, clock });
  const worktreeCreates = createWorktreeCreateCoordinator();
  const worktreeMutations = createWorktreeMutationCoordinator();
  registerObserverCommandHandlers({
    projectConfigWriter: createUnexpectedProjectConfigWriter(),
    queue,
    core,
    providers,
    projects: config.projects,
    persistence,
    eventBus,
    clock,
    idFactory: ids,
    worktreeCreates,
    worktreeMutations,
  });
  const metadataRefresh = {
    refresh: async () => undefined,
    shutdown: async () => undefined,
  };
  const api = createObserverApi({
    core,
    providers,
    persistence,
    persistenceHealth: persistence,
    commandQueue: queue,
    worktreeCreates,
    worktreeMutations,
    eventBus,
    diagnosticEvidenceSource: {
      collect: async () => ({
        state: { totalBytes: 0, files: 0 },
        logs: [],
        hookSpool: { pending: 0, failed: 0 },
      }),
    },
    clock,
    config,
    metadataRefresh,
    hookReconcileDebounceMs: options.reconcileDebounceMs ?? 0,
    interactiveReconcileDebounceMs:
      options.interactiveReconcileDebounceMs ?? options.reconcileDebounceMs ?? 0,
  });
  let started = false;
  let closed = false;
  const fixture: QuickSessionBenchmarkFixture = {
    api,
    config,
    core,
    harness,
    queue,
    worktree,
    startup: async () => {
      if (started) return;
      started = true;
      await api.reconcile("observer.startup");
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await queue.drain();
      await metadataRefresh.shutdown();
      sqlite.close();
    },
  };
  if (options.startup !== false) {
    await fixture.startup();
  }
  return fixture;
}

export async function runQuickSession(
  fixture: QuickSessionBenchmarkFixture,
  input: {
    branch: string;
    projectId?: string;
    recorder?: ActiveRecorder;
  },
): Promise<QuickSessionSample> {
  const projectId = input.projectId ?? "project-0";
  const recorder = input.recorder ?? createRecorder(input.branch, projectId);
  fixture.worktree.registerRecorder(input.branch, recorder);
  recorder.mark("commandQueued");
  try {
    const receipt = await fixture.api.dispatch({
      type: "worktree.create",
      payload: {
        projectId,
        branch: input.branch,
        launchHarness: "fake-harness",
      },
    });
    const command = await waitForTerminalCommand(fixture.api, receipt.commandId);
    assertCommandSucceeded(command);
    const row = fixture.core
      .getSnapshot()
      .rows.find(
        (candidate) => candidate.projectId === projectId && candidate.branch === input.branch,
      );
    if (row === undefined) {
      throw new Error(`Quick Session worktree ${projectId}/${input.branch} was not observable.`);
    }
    recorder.mark("usableWorktreeObserved");
    recorder.mark("launchRequested");
    const prepared = await fixture.api.prepareExternalLaunch({
      projectId,
      worktreeId: row.id,
      harness: "fake-harness",
      title: input.branch,
    });
    if (prepared.kind !== "prepared") {
      throw new Error(`Quick Session ${input.branch} unexpectedly resolved an existing session.`);
    }
    await delay(defaultQuickSessionCosts.processSpawnMs);
    recorder.mark("processSpawned");
    fixture.harness.addRun(
      createFakeHarnessRun({
        id: `run_${prepared.sessionId}`,
        projectId,
        worktreeId: row.id,
        sessionId: prepared.sessionId,
        cwd: row.path,
        state: "starting",
        now: nowIso(),
      }),
    );
    await delay(defaultQuickSessionCosts.harnessReadyMs);
    recorder.mark("harnessReady");
    await waitForSnapshot(fixture, (snapshot) =>
      snapshot.sessions.some(
        (session) =>
          session.id === prepared.sessionId &&
          session.projectId === projectId &&
          session.worktreeId === row.id,
      ),
    );
    recorder.mark("canonicalSessionVisible");
    recorder.mark("optimisticRemoved");
    await fixture.api.getSnapshot();
    recorder.mark("focusedAndAcceptingInput");
    if (receipt.traceId === undefined) {
      throw new Error(`Quick Session command ${receipt.commandId} has no trace id.`);
    }
    return {
      ...recorder.sample(),
      commandId: receipt.commandId,
      traceId: receipt.traceId,
    };
  } finally {
    fixture.worktree.unregisterRecorder(input.branch, recorder);
  }
}

export function beginQuickSessionRecording(
  branch: string,
  projectId = "project-0",
): ActiveRecorder {
  return createRecorder(branch, projectId);
}

export async function submitUnrelatedHarnessEvent(
  fixture: QuickSessionBenchmarkFixture,
  reportId: string,
): Promise<void> {
  const observedAt = nowIso();
  const report: HarnessEventReport = {
    schemaVersion: STATION_SCHEMA_VERSION,
    reportId,
    provider: "fake-harness",
    kind: "harness",
    eventType: "UnrelatedMetadata",
    observedAt,
    status: {
      value: "working",
      confidence: "medium",
      reason: "Synthetic unrelated activity for Quick Session contention measurement.",
      source: "harness_event",
      updatedAt: observedAt,
    },
    correlation: { worktreeId: "wt_unrelated" },
    diagnostics: { rawEventType: "UnrelatedMetadata" },
  };
  await fixture.api.reportHarnessEvent(report);
}

export async function runRemovalBurst(
  fixture: QuickSessionBenchmarkFixture,
  count: number,
): Promise<{ durationMs: number; removed: number }> {
  const rows = fixture.core.getSnapshot().rows.slice(0, count);
  const startedAt = globalThis.performance.now();
  const receipts = await Promise.all(
    rows.map((row) =>
      fixture.api.dispatch({
        type: "worktree.remove",
        payload: {
          projectId: row.projectId,
          worktreeId: row.id,
          expectedPath: row.path,
          expectedBranch: row.branch,
          expectedRegistrationIdentity: row.registrationIdentity,
          force: false,
        },
      }),
    ),
  );
  const records = await Promise.all(
    receipts.map((receipt) => waitForTerminalCommand(fixture.api, receipt.commandId)),
  );
  const removed = records.filter((record) => record.status === "succeeded").length;
  return { durationMs: globalThis.performance.now() - startedAt, removed };
}

export async function waitForTerminalCommand(
  api: ReturnType<typeof createObserverApi>,
  commandId: CommandId,
  timeoutMs = 10_000,
): Promise<CommandRecord> {
  const deadline = globalThis.performance.now() + timeoutMs;
  while (globalThis.performance.now() <= deadline) {
    const record = await api.getCommand(commandId);
    if (record.status === "succeeded" || record.status === "failed") return record;
    await delay(1);
  }
  throw new Error(`Timed out waiting for ${commandId}.`);
}

export async function waitForMutationStarted(
  fixture: QuickSessionBenchmarkFixture,
  branch: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = globalThis.performance.now() + timeoutMs;
  while (globalThis.performance.now() <= deadline) {
    if (fixture.worktree.mutationStarted(branch)) return;
    await delay(1);
  }
  throw new Error(`Timed out waiting for repository mutation ${branch} to start.`);
}

export async function waitForProviderScanCount(
  fixture: QuickSessionBenchmarkFixture,
  count: number,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = globalThis.performance.now() + timeoutMs;
  while (globalThis.performance.now() <= deadline) {
    if (fixture.worktree.scanCount >= count) return;
    await delay(1);
  }
  throw new Error(`Timed out waiting for ${count} provider scans.`);
}

function assertCommandSucceeded(record: CommandRecord): void {
  if (record.status !== "succeeded") {
    throw new Error(`Quick Session command ${record.id} finished as ${record.status}.`);
  }
}

function createRecorder(branch: string, projectId: string): ActiveRecorder {
  const origin = globalThis.performance.now();
  const marks = new Map<QuickSessionStage, number>([["intentAccepted", origin]]);
  return {
    branch,
    mark: (stage) => {
      if (!marks.has(stage)) marks.set(stage, globalThis.performance.now());
    },
    sample: () => {
      const absolute = Object.fromEntries(
        quickSessionStages.map((stage) => {
          const value = marks.get(stage);
          if (value === undefined) throw new Error(`Missing Quick Session stage ${stage}.`);
          return [stage, value];
        }),
      ) as Record<QuickSessionStage, number>;
      const timestampsMs = Object.fromEntries(
        quickSessionStages.map((stage) => [stage, absolute[stage] - origin]),
      ) as Record<QuickSessionStage, number>;
      const totalMs = timestampsMs.focusedAndAcceptingInput;
      return {
        branch,
        projectId,
        timestampsMs,
        totalMs,
        stageMs: {
          queueAndPreflight: timestampsMs.mutationStarted - timestampsMs.commandQueued,
          repositoryMutation: timestampsMs.mutationCompleted - timestampsMs.mutationStarted,
          worktreeObservation: timestampsMs.usableWorktreeObserved - timestampsMs.mutationCompleted,
          launchPreparationAndSpawn: timestampsMs.processSpawned - timestampsMs.launchRequested,
          harnessReadiness: timestampsMs.harnessReady - timestampsMs.processSpawned,
          canonicalProjection: timestampsMs.canonicalSessionVisible - timestampsMs.harnessReady,
          optimisticAndFocus:
            timestampsMs.focusedAndAcceptingInput - timestampsMs.canonicalSessionVisible,
        },
      };
    },
  };
}

class InstrumentedWorktreeProvider implements WorktreeProvider {
  readonly id = "fake-worktree";
  readonly #delegate: FakeWorktreeProvider;
  readonly #costs: QuickSessionCosts;
  readonly #failBranches: ReadonlySet<string>;
  readonly #recorders = new Map<string, ActiveRecorder>();
  readonly #startedBranches = new Set<string>();
  scanCount = 0;
  activeCreateCount = 0;
  maxConcurrentCreates = 0;
  readonly #activeCreatesByProject = new Map<string, number>();
  readonly #maxCreatesByProject = new Map<string, number>();

  get maxConcurrentCreatesPerProject(): number {
    return Math.max(0, ...this.#maxCreatesByProject.values());
  }

  constructor(input: {
    initialWorktrees: WorktreeObservation[];
    costs: QuickSessionCosts;
    failBranches?: ReadonlySet<string>;
  }) {
    this.#delegate = new FakeWorktreeProvider({
      id: this.id,
      worktrees: input.initialWorktrees,
      now: nowIso,
      createPath: (request) => `/tmp/station-performance/${request.project.id}/${request.branch}`,
    });
    this.#costs = input.costs;
    this.#failBranches = input.failBranches ?? new Set();
  }

  registerRecorder(branch: string, recorder: ActiveRecorder): void {
    this.#recorders.set(branch, recorder);
  }

  unregisterRecorder(branch: string, recorder: ActiveRecorder): void {
    if (this.#recorders.get(branch) === recorder) this.#recorders.delete(branch);
  }

  mutationStarted(branch: string): boolean {
    return this.#startedBranches.has(branch);
  }

  capabilities(): WorktreeCapabilities {
    return this.#delegate.capabilities();
  }

  health(): Promise<ProviderHealth> {
    return this.#delegate.health();
  }

  doctorChecks(context?: ProviderDoctorContext): Promise<ProviderDoctorCheck[]> {
    return Promise.resolve(context === undefined ? [] : []);
  }

  async listWorktrees(project: ProviderProjectConfig): Promise<WorktreeObservation[]> {
    this.scanCount += 1;
    const current = this.#delegate.snapshot().worktrees.length;
    await delay(this.#costs.scanBaseMs + current * this.#costs.scanPerWorktreeMs);
    return this.#delegate.listWorktrees(project);
  }

  async createWorktree(request: CreateWorktreeRequest): Promise<WorktreeObservation> {
    this.activeCreateCount += 1;
    this.maxConcurrentCreates = Math.max(this.maxConcurrentCreates, this.activeCreateCount);
    const activeForProject = (this.#activeCreatesByProject.get(request.project.id) ?? 0) + 1;
    this.#activeCreatesByProject.set(request.project.id, activeForProject);
    this.#maxCreatesByProject.set(
      request.project.id,
      Math.max(this.#maxCreatesByProject.get(request.project.id) ?? 0, activeForProject),
    );
    this.#startedBranches.add(request.branch);
    const recorder = this.#recorders.get(request.branch);
    recorder?.mark("mutationStarted");
    try {
      await delay(this.#costs.mutationMs);
      if (this.#failBranches.has(request.branch)) {
        throw {
          tag: "WorktreeProviderError",
          code: "SYNTHETIC_WORKTREE_CREATE_FAILED",
          message: "Synthetic worktree creation failed.",
          provider: this.id,
        } satisfies SafeError;
      }
      const result = await this.#delegate.createWorktree(request);
      recorder?.mark("mutationCompleted");
      return result;
    } finally {
      this.activeCreateCount -= 1;
      const remainingForProject = (this.#activeCreatesByProject.get(request.project.id) ?? 1) - 1;
      this.#activeCreatesByProject.set(request.project.id, remainingForProject);
    }
  }

  async removeWorktree(request: RemoveWorktreeRequest): Promise<RemoveWorktreeResult> {
    await delay(this.#costs.mutationMs);
    return this.#delegate.removeWorktree(request);
  }

  snapshot(): ReturnType<FakeWorktreeProvider["snapshot"]> {
    return this.#delegate.snapshot();
  }
}

export class InstrumentedManagedTerminal implements ManagedTerminalLifecycle {
  readonly id = "native";
  readonly #terminal = new FakeTerminalProvider({
    id: "native",
    now: nowIso,
    capabilities: { canLaunchProcessPersistently: false },
  });
  readonly #bindings = new Map<TerminalTargetId, { sessionId: string; token: string }>();
  #sequence = 0;

  capabilities(): ReturnType<FakeTerminalProvider["capabilities"]> {
    return this.#terminal.capabilities();
  }

  health(): Promise<ProviderHealth> {
    return this.#terminal.health();
  }

  listTargets(): Promise<TerminalTargetObservation[]> {
    return this.#terminal.listTargets();
  }

  openWorkspace(request: OpenWorkspaceRequest) {
    return this.#terminal.openWorkspace(request);
  }

  async openManagedWorkspace(request: OpenWorkspaceRequest): Promise<ManagedOpenWorkspaceResult> {
    const opened = await this.#terminal.openWorkspace(request);
    const token = `binding_${++this.#sequence}`;
    if (request.sessionId === undefined)
      throw new Error("Managed benchmark launch requires session id.");
    this.#bindings.set(opened.target.targetId, { sessionId: request.sessionId, token });
    return { ...opened, bindingToken: token };
  }

  launchProcess(request: TerminalLaunchProcessRequest): Promise<TerminalLaunchProcessResult> {
    return this.#terminal.launchProcess(request);
  }

  launchManagedProcess(
    request: ManagedTerminalLaunchProcessRequest,
  ): Promise<ManagedTerminalLaunchProcessResult> {
    return Promise.resolve({
      terminalTargetId: request.terminalTarget.targetId,
      agentEndpointId: request.agentEndpointId,
      started: false,
    });
  }

  focusTarget(targetId: TerminalTargetId, context?: TerminalFocusContext): Promise<void> {
    return this.#terminal.focusTarget(targetId, context);
  }

  closeTarget(targetId: TerminalTargetId): Promise<void> {
    return this.#terminal.closeTarget(targetId);
  }

  captureTarget(targetId: TerminalTargetId): Promise<TerminalCapture> {
    return this.#terminal.captureTarget(targetId);
  }

  sendInput(targetId: TerminalTargetId, input: string): Promise<void> {
    return this.#terminal.sendInput(targetId, input);
  }

  attachmentForTarget(_targetId: TerminalTargetId): Promise<ManagedTerminalAttachment | undefined> {
    return Promise.resolve(undefined);
  }

  async releaseTarget(request: ReleaseManagedTerminalTargetRequest): Promise<boolean> {
    const binding = this.#bindings.get(request.targetId);
    if (
      binding === undefined ||
      binding.sessionId !== request.expectedSessionId ||
      (request.expectedBindingToken !== undefined && binding.token !== request.expectedBindingToken)
    ) {
      return false;
    }
    this.#bindings.delete(request.targetId);
    await this.#terminal.closeTarget(request.targetId);
    return true;
  }
}

function benchmarkConfig(projectCount: number): StationConfig {
  return {
    schemaVersion: 1,
    workspace: DEFAULT_WORKSPACE_CONFIG,
    defaults: {
      worktreeProvider: "fake-worktree",
      terminal: "native",
      harness: "fake-harness",
      layout: "agent-shell",
      defaultBranch: "main",
    },
    projects: Array.from({ length: projectCount }, (_, index) => ({
      id: `project-${index}`,
      label: `Project ${index}`,
      root: `/tmp/station-performance/project-${index}`,
      defaultBranch: "main",
      defaults: {
        harness: "fake-harness",
        terminal: "native",
        layout: "agent-shell",
      },
      worktrunk: { enabled: true },
    })),
  };
}

function observerIds() {
  let command = 0;
  let event = 0;
  let error = 0;
  let observation = 0;
  let breadcrumb = 0;
  let session = 0;
  let group = 0;
  return {
    commandId: () => `cmd_perf_${++command}`,
    eventId: () => `evt_perf_${++event}`,
    errorId: () => `err_perf_${++error}`,
    observationId: () => `obs_perf_${++observation}`,
    breadcrumbId: () => `crumb_perf_${++breadcrumb}`,
    sessionId: () => `ses_perf_${++session}`,
    sessionGroupId: () => `grp_perf_${++group}`,
  };
}

async function waitForSnapshot(
  fixture: QuickSessionBenchmarkFixture,
  predicate: (snapshot: StationSnapshot) => boolean,
  timeoutMs = 10_000,
): Promise<StationSnapshot> {
  const deadline = globalThis.performance.now() + timeoutMs;
  while (globalThis.performance.now() <= deadline) {
    const snapshot = fixture.core.getSnapshot();
    if (predicate(snapshot)) return snapshot;
    await delay(1);
  }
  throw new Error("Timed out waiting for the Quick Session canonical snapshot.");
}

function nowIso(): string {
  return new Date().toISOString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
