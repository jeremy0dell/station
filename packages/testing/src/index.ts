import type {
  BuildHarnessLaunchRequest,
  Confidence,
  CreateWorktreeRequest,
  GetWorktreeRequest,
  HarnessCapabilities,
  HarnessClassificationContext,
  HarnessDiscoveryContext,
  HarnessEventContext,
  HarnessEventObservation,
  HarnessLaunchPlan,
  HarnessProvider,
  HarnessRunObservation,
  HarnessStatusObservation,
  HarnessStopRequest,
  HarnessStopResult,
  OpenWorkspaceRequest,
  OpenWorkspaceResult,
  ProviderHealth,
  ProviderId,
  ProviderProjectConfig,
  RawHarnessEvent,
  RemoveWorktreeRequest,
  RemoveWorktreeResult,
  RepositoryRemote,
  SafeError,
  TerminalCapabilities,
  TerminalCapture,
  TerminalFocusContext,
  TerminalHarnessBinding,
  TerminalLaunchProcessRequest,
  TerminalLaunchProcessResult,
  TerminalProvider,
  TerminalState,
  TerminalTargetId,
  TerminalTargetObservation,
  WorktreeCapabilities,
  WorktreeId,
  WorktreeObservation,
  WorktreeProvider,
} from "@station/contracts";

export type FakeProviderClock = string | (() => Date | string);

type FakeWorktreeProviderMethod =
  | "health"
  | "listWorktrees"
  | "createWorktree"
  | "removeWorktree"
  | "getWorktree";

type FakeTerminalProviderMethod =
  | "health"
  | "listTargets"
  | "openWorkspace"
  | "launchProcess"
  | "focusTarget"
  | "closeTarget"
  | "captureTarget"
  | "sendInput";

type FakeHarnessProviderMethod =
  | "health"
  | "buildLaunch"
  | "discoverRuns"
  | "classifyRun"
  | "ingestEvent"
  | "stop";

export type FakeProviderFailures<TMethod extends string> = Partial<Record<TMethod, SafeError>>;

export type CreateFakeWorktreeInput = {
  id?: WorktreeId;
  provider?: ProviderId;
  projectId?: string;
  branch?: string;
  path?: string;
  registrationIdentity?: string;
  now?: FakeProviderClock;
  isPrimaryCheckout?: boolean;
  dirty?: boolean;
  ahead?: number;
  behind?: number;
  remote?: RepositoryRemote;
  headSha?: string;
  providerData?: unknown;
};

export type CreateFakeTerminalTargetInput = {
  id?: TerminalTargetId;
  provider?: ProviderId;
  projectId?: string;
  worktreeId?: WorktreeId;
  sessionId?: string;
  harnessRunId?: string;
  cwd?: string;
  state?: TerminalState;
  focusable?: boolean;
  closeable?: boolean;
  confidence?: Confidence;
  reason?: string;
  now?: FakeProviderClock;
  harnessBinding?: TerminalHarnessBinding;
  providerData?: unknown;
};

export type CreateFakeHarnessRunInput = {
  id?: string;
  provider?: ProviderId;
  projectId?: string;
  worktreeId?: WorktreeId;
  sessionId?: string;
  cwd?: string;
  state?: HarnessRunObservation["state"];
  confidence?: Confidence;
  reason?: string;
  pid?: number;
  now?: FakeProviderClock;
  providerData?: unknown;
};

export type FakeWorktreeProviderOptions = {
  id?: ProviderId;
  now?: FakeProviderClock;
  worktrees?: WorktreeObservation[];
  createPath?: (request: CreateWorktreeRequest) => string;
  health?: Partial<ProviderHealth>;
  capabilities?: Partial<WorktreeCapabilities>;
  failures?: FakeProviderFailures<FakeWorktreeProviderMethod>;
};

export type FakeTerminalProviderOptions = {
  id?: ProviderId;
  now?: FakeProviderClock;
  targets?: TerminalTargetObservation[];
  health?: Partial<ProviderHealth>;
  capabilities?: Partial<TerminalCapabilities>;
  failures?: FakeProviderFailures<FakeTerminalProviderMethod>;
  onLaunch?: (request: TerminalLaunchProcessRequest) => void | Promise<void>;
};

export type FakeHarnessProviderOptions = {
  id?: ProviderId;
  now?: FakeProviderClock;
  runs?: HarnessRunObservation[];
  health?: Partial<ProviderHealth>;
  capabilities?: Partial<HarnessCapabilities>;
  failures?: FakeProviderFailures<FakeHarnessProviderMethod>;
};

const defaultWorktreeCapabilities: WorktreeCapabilities = {
  canCreate: true,
  canRemove: true,
  canList: true,
  canEmitLifecycleEvents: true,
  canExposeDirtyState: true,
  canSeedWorkingTree: true,
};

const defaultTerminalCapabilities: TerminalCapabilities = {
  canOpenWorkspace: true,
  canFocusTarget: true,
  canCloseTarget: true,
  canCaptureOutput: true,
  canSendInput: true,
  canPersistIdentityBinding: true,
  canDisplayPopup: true,
};

const defaultHarnessCapabilities: HarnessCapabilities = {
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
};

function resolveNow(clock?: FakeProviderClock): string {
  if (typeof clock === "function") {
    const value = clock();
    return value instanceof Date ? value.toISOString() : value;
  }

  return clock ?? new Date(0).toISOString();
}

function providerHealth(
  input: {
    providerId: ProviderId;
    providerType: ProviderHealth["providerType"];
    now?: FakeProviderClock;
    capabilities: Record<string, boolean>;
  },
  override?: Partial<ProviderHealth>,
): ProviderHealth {
  return {
    providerId: input.providerId,
    providerType: input.providerType,
    status: "healthy",
    lastCheckedAt: resolveNow(input.now),
    latencyMs: 0,
    capabilities: input.capabilities,
    ...override,
  };
}

function maybeThrow<TMethod extends string>(
  failures: FakeProviderFailures<TMethod> | undefined,
  method: TMethod,
): void {
  const failure = failures?.[method];
  if (failure !== undefined) {
    throw failure;
  }
}

function compactProviderData(providerData: unknown): { providerData?: unknown } {
  return providerData === undefined ? {} : { providerData };
}

export function createFakeWorktree(input: CreateFakeWorktreeInput = {}): WorktreeObservation {
  const projectId = input.projectId ?? "web";
  const branch = input.branch ?? "main";

  return {
    id: input.id ?? `wt_${projectId}_${branch.replaceAll(/[^a-zA-Z0-9]+/g, "_")}`,
    provider: input.provider ?? "fake-worktree",
    projectId,
    branch,
    path: input.path ?? `/tmp/station/${projectId}/${branch.replaceAll("/", "-")}`,
    ...(input.registrationIdentity === undefined
      ? {}
      : { registrationIdentity: input.registrationIdentity }),
    state: "exists",
    source: "worktrunk",
    ...(input.isPrimaryCheckout === undefined
      ? {}
      : { isPrimaryCheckout: input.isPrimaryCheckout }),
    dirty: input.dirty ?? false,
    ahead: input.ahead ?? 0,
    behind: input.behind ?? 0,
    ...(input.remote === undefined ? {} : { remote: input.remote }),
    ...(input.headSha === undefined ? {} : { headSha: input.headSha }),
    confidence: "high",
    reason: "Fake provider listed the worktree.",
    observedAt: resolveNow(input.now),
    ...compactProviderData(input.providerData),
  };
}

export function createFakeTerminalTarget(
  input: CreateFakeTerminalTargetInput = {},
): TerminalTargetObservation {
  const state = input.state ?? "open";

  return {
    id: input.id ?? "term_fake",
    provider: input.provider ?? "fake-terminal",
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.worktreeId === undefined ? {} : { worktreeId: input.worktreeId }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.harnessRunId === undefined ? {} : { harnessRunId: input.harnessRunId }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    state,
    ...(input.focusable === undefined ? {} : { focusable: input.focusable }),
    ...(input.closeable === undefined ? {} : { closeable: input.closeable }),
    confidence: input.confidence ?? (state === "unknown" ? "low" : "high"),
    reason: input.reason ?? "Fake provider listed the terminal target.",
    observedAt: resolveNow(input.now),
    ...(input.harnessBinding === undefined ? {} : { harnessBinding: input.harnessBinding }),
    ...compactProviderData(input.providerData),
  };
}

export function createFakeHarnessRun(input: CreateFakeHarnessRunInput = {}): HarnessRunObservation {
  const state = input.state ?? "idle";
  const pid = input.pid ?? (state === "exited" ? undefined : 5000);

  return {
    id: input.id ?? "run_fake",
    provider: input.provider ?? "fake-harness",
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.worktreeId === undefined ? {} : { worktreeId: input.worktreeId }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(pid === undefined ? {} : { pid }),
    state,
    confidence: input.confidence ?? (state === "unknown" ? "low" : "high"),
    reason: input.reason ?? `Fake harness run is ${state}.`,
    observedAt: resolveNow(input.now),
    ...compactProviderData(input.providerData),
  };
}

export class FakeWorktreeProvider implements WorktreeProvider {
  readonly id: ProviderId;

  readonly #now: FakeProviderClock | undefined;
  readonly #worktrees: WorktreeObservation[];
  readonly #removed: RemoveWorktreeRequest[] = [];
  readonly #created: CreateWorktreeRequest[] = [];
  readonly #createPath: ((request: CreateWorktreeRequest) => string) | undefined;
  readonly #health: Partial<ProviderHealth> | undefined;
  readonly #capabilities: WorktreeCapabilities;
  readonly #failures: FakeProviderFailures<FakeWorktreeProviderMethod> | undefined;

  constructor(options: FakeWorktreeProviderOptions = {}) {
    this.id = options.id ?? "fake-worktree";
    this.#now = options.now;
    this.#worktrees = (options.worktrees ?? []).map(withFakeRegistrationIdentity);
    this.#createPath = options.createPath;
    this.#health = options.health;
    this.#capabilities = {
      ...defaultWorktreeCapabilities,
      ...options.capabilities,
    };
    this.#failures = options.failures;
  }

  capabilities(): WorktreeCapabilities {
    return this.#capabilities;
  }

  async health(): Promise<ProviderHealth> {
    maybeThrow(this.#failures, "health");
    return providerHealth(
      {
        providerId: this.id,
        providerType: "worktree",
        capabilities: this.#capabilities,
        ...(this.#now === undefined ? {} : { now: this.#now }),
      },
      this.#health,
    );
  }

  async listWorktrees(project: ProviderProjectConfig): Promise<WorktreeObservation[]> {
    maybeThrow(this.#failures, "listWorktrees");
    return this.#worktrees.filter((worktree) => worktree.projectId === project.id);
  }

  async createWorktree(request: CreateWorktreeRequest): Promise<WorktreeObservation> {
    maybeThrow(this.#failures, "createWorktree");
    this.#created.push(request);
    const path = this.#createPath?.(request) ?? request.path;
    const worktree = createFakeWorktree({
      provider: this.id,
      projectId: request.project.id,
      branch: request.branch,
      ...(path === undefined ? {} : { path }),
      registrationIdentity: `fake-registration:${request.project.id}:${request.branch}:${path ?? "managed"}`,
      ...(this.#now === undefined ? {} : { now: this.#now }),
    });
    this.#worktrees.push(worktree);
    return worktree;
  }

  async removeWorktree(request: RemoveWorktreeRequest): Promise<RemoveWorktreeResult> {
    maybeThrow(this.#failures, "removeWorktree");
    const recorded: RemoveWorktreeRequest = {
      worktreeId: request.worktreeId,
      expectedPath: request.expectedPath,
      expectedBranch: request.expectedBranch,
      expectedRegistrationIdentity: request.expectedRegistrationIdentity,
    };
    if (request.projectId !== undefined) recorded.projectId = request.projectId;
    if (request.force !== undefined) recorded.force = request.force;
    const index = this.#worktrees.findIndex((worktree) => worktree.id === request.worktreeId);
    const selected = this.#worktrees[index];
    if (
      selected !== undefined &&
      (selected.path !== request.expectedPath ||
        selected.branch !== request.expectedBranch ||
        selected.registrationIdentity !== request.expectedRegistrationIdentity)
    ) {
      const error: SafeError = {
        tag: "WorktreeProviderError",
        code: "FAKE_WORKTREE_CHANGED",
        message: "The fake worktree changed before removal.",
        provider: this.id,
        worktreeId: request.worktreeId,
      };
      throw error;
    }
    this.#removed.push(recorded);
    if (index >= 0) {
      this.#worktrees.splice(index, 1);
    }
    return {
      worktreeId: request.worktreeId,
      removed: index >= 0,
    };
  }

  async getWorktree(request: GetWorktreeRequest): Promise<WorktreeObservation | null> {
    maybeThrow(this.#failures, "getWorktree");
    return (
      this.#worktrees.find((worktree) => {
        if (request.worktreeId !== undefined) {
          return worktree.id === request.worktreeId;
        }
        if (request.path !== undefined) {
          return worktree.path === request.path;
        }
        return false;
      }) ?? null
    );
  }

  snapshot(): {
    worktrees: WorktreeObservation[];
    removed: RemoveWorktreeRequest[];
    created: CreateWorktreeRequest[];
  } {
    return {
      worktrees: [...this.#worktrees],
      removed: this.#removed.map((request) => ({ ...request })),
      created: this.#created.map((request) => ({ ...request })),
    };
  }
}

function withFakeRegistrationIdentity(worktree: WorktreeObservation): WorktreeObservation {
  if (worktree.registrationIdentity === undefined) {
    worktree.registrationIdentity = `fake-registration:${worktree.id}:${worktree.path}`;
  }
  return worktree;
}

export class FakeTerminalProvider implements TerminalProvider {
  readonly id: ProviderId;

  readonly #now: FakeProviderClock | undefined;
  readonly #targets: TerminalTargetObservation[];
  readonly #launches: TerminalLaunchProcessRequest[] = [];
  readonly #focused: TerminalTargetId[] = [];
  readonly #focusContexts: Array<TerminalFocusContext | undefined> = [];
  readonly #closed: TerminalTargetId[] = [];
  readonly #health: Partial<ProviderHealth> | undefined;
  readonly #capabilities: TerminalCapabilities;
  readonly #failures: FakeProviderFailures<FakeTerminalProviderMethod> | undefined;
  readonly #onLaunch: ((request: TerminalLaunchProcessRequest) => void | Promise<void>) | undefined;

  constructor(options: FakeTerminalProviderOptions = {}) {
    this.id = options.id ?? "fake-terminal";
    this.#now = options.now;
    this.#targets = options.targets ?? [];
    this.#health = options.health;
    this.#capabilities = {
      ...defaultTerminalCapabilities,
      ...options.capabilities,
    };
    this.#failures = options.failures;
    this.#onLaunch = options.onLaunch;
  }

  capabilities(): TerminalCapabilities {
    return this.#capabilities;
  }

  async health(): Promise<ProviderHealth> {
    maybeThrow(this.#failures, "health");
    return providerHealth(
      {
        providerId: this.id,
        providerType: "terminal",
        capabilities: this.#capabilities,
        ...(this.#now === undefined ? {} : { now: this.#now }),
      },
      this.#health,
    );
  }

  async listTargets(): Promise<TerminalTargetObservation[]> {
    maybeThrow(this.#failures, "listTargets");
    return [...this.#targets];
  }

  async openWorkspace(request: OpenWorkspaceRequest): Promise<OpenWorkspaceResult> {
    maybeThrow(this.#failures, "openWorkspace");
    const target = createFakeTerminalTarget({
      provider: this.id,
      projectId: request.project.id,
      worktreeId: request.worktree.id,
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      ...(this.#now === undefined ? {} : { now: this.#now }),
      harnessBinding: {
        role: "main-agent",
        harnessProvider: request.harness,
        worktreePath: request.worktree.path,
      },
    });
    this.#targets.push(target);
    return {
      target: {
        provider: this.id,
        targetId: target.id,
        projectId: request.project.id,
        worktreeId: request.worktree.id,
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        harnessBinding: {
          role: "main-agent",
          harnessProvider: request.harness,
          worktreePath: request.worktree.path,
        },
        confidence: "high",
        reason: "Fake provider opened a workspace.",
      },
      agentEndpointId: target.id,
    };
  }

  async launchProcess(request: TerminalLaunchProcessRequest): Promise<TerminalLaunchProcessResult> {
    maybeThrow(this.#failures, "launchProcess");
    this.#launches.push(request);
    await this.#onLaunch?.(request);
    return {
      terminalTargetId: request.terminalTarget.targetId,
      agentEndpointId: request.agentEndpointId,
      started: true,
    };
  }

  async focusTarget(_targetId: TerminalTargetId, context?: TerminalFocusContext): Promise<void> {
    maybeThrow(this.#failures, "focusTarget");
    this.#focused.push(_targetId);
    this.#focusContexts.push(context);
  }

  async closeTarget(targetId: TerminalTargetId): Promise<void> {
    maybeThrow(this.#failures, "closeTarget");
    this.#closed.push(targetId);
    const index = this.#targets.findIndex((target) => target.id === targetId);
    if (index >= 0) {
      this.#targets.splice(index, 1);
    }
  }

  async captureTarget(targetId: TerminalTargetId): Promise<TerminalCapture> {
    maybeThrow(this.#failures, "captureTarget");
    return {
      targetId,
      capturedAt: resolveNow(this.#now),
      text: "",
    };
  }

  async sendInput(_targetId: TerminalTargetId, _input: string): Promise<void> {
    maybeThrow(this.#failures, "sendInput");
  }

  snapshot(): {
    targets: TerminalTargetObservation[];
    launches: TerminalLaunchProcessRequest[];
    focused: TerminalTargetId[];
    focusContexts: Array<TerminalFocusContext | undefined>;
    closed: TerminalTargetId[];
  } {
    return {
      targets: [...this.#targets],
      launches: [...this.#launches],
      focused: [...this.#focused],
      focusContexts: [...this.#focusContexts],
      closed: [...this.#closed],
    };
  }
}

export class FakeHarnessProvider implements HarnessProvider {
  readonly id: ProviderId;

  readonly #now: FakeProviderClock | undefined;
  readonly #runs: HarnessRunObservation[];
  readonly #stopped: HarnessStopRequest[] = [];
  readonly #health: Partial<ProviderHealth> | undefined;
  readonly #capabilities: HarnessCapabilities;
  readonly #failures: FakeProviderFailures<FakeHarnessProviderMethod> | undefined;

  constructor(options: FakeHarnessProviderOptions = {}) {
    this.id = options.id ?? "fake-harness";
    this.#now = options.now;
    this.#runs = options.runs ?? [];
    this.#health = options.health;
    this.#capabilities = {
      ...defaultHarnessCapabilities,
      ...options.capabilities,
    };
    this.#failures = options.failures;
  }

  capabilities(): HarnessCapabilities {
    return this.#capabilities;
  }

  async health(): Promise<ProviderHealth> {
    maybeThrow(this.#failures, "health");
    return providerHealth(
      {
        providerId: this.id,
        providerType: "harness",
        capabilities: this.#capabilities,
        ...(this.#now === undefined ? {} : { now: this.#now }),
      },
      this.#health,
    );
  }

  async buildLaunch(request: BuildHarnessLaunchRequest): Promise<HarnessLaunchPlan> {
    maybeThrow(this.#failures, "buildLaunch");
    return {
      provider: this.id,
      command: this.id,
      args: [request.project.id, request.worktree.branch],
      cwd: request.worktree.path,
      mode: request.mode ?? "interactive",
      env: {
        STATION_PROJECT_ID: request.project.id,
        STATION_WORKTREE_ID: request.worktree.id,
        STATION_WORKTREE_PATH: request.worktree.path,
        STATION_HARNESS_PROVIDER: this.id,
        ...(request.sessionId === undefined ? {} : { STATION_SESSION_ID: request.sessionId }),
      },
      providerData: {
        fake: true,
        ...(request.initialPrompt === undefined ? {} : { initialPromptProvided: true }),
        ...(request.profile === undefined ? {} : { profile: request.profile }),
        ...(request.permissionMode === undefined ? {} : { permissionMode: request.permissionMode }),
        ...(request.approvalPolicy === undefined ? {} : { approvalPolicy: request.approvalPolicy }),
        ...(request.sandboxMode === undefined ? {} : { sandboxMode: request.sandboxMode }),
      },
    };
  }

  async discoverRuns(_context: HarnessDiscoveryContext): Promise<HarnessRunObservation[]> {
    maybeThrow(this.#failures, "discoverRuns");
    return [...this.#runs];
  }

  async classifyRun(
    run: HarnessRunObservation,
    _context: HarnessClassificationContext,
  ): Promise<HarnessStatusObservation> {
    maybeThrow(this.#failures, "classifyRun");
    return {
      provider: this.id,
      runId: run.id,
      ...(run.projectId === undefined ? {} : { projectId: run.projectId }),
      ...(run.worktreeId === undefined ? {} : { worktreeId: run.worktreeId }),
      ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
      status: {
        value: run.state,
        confidence: run.confidence,
        reason: run.reason,
        source: "harness_process",
        updatedAt: run.observedAt,
      },
      observedAt: resolveNow(this.#now),
    };
  }

  async ingestEvent(
    event: RawHarnessEvent,
    _context: HarnessEventContext,
  ): Promise<HarnessEventObservation[]> {
    maybeThrow(this.#failures, "ingestEvent");
    const observedAt = event.observedAt ?? resolveNow(this.#now);
    return this.#runs.map((run) => ({
      provider: this.id,
      runId: run.id,
      ...(run.worktreeId === undefined ? {} : { worktreeId: run.worktreeId }),
      ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
      status: {
        value: run.state,
        confidence: run.confidence,
        reason: run.reason,
        source: "harness_event",
        updatedAt: observedAt,
      },
      observedAt,
    }));
  }

  async stop(request: HarnessStopRequest): Promise<HarnessStopResult> {
    maybeThrow(this.#failures, "stop");
    const recorded: HarnessStopRequest = {
      runId: request.runId,
    };
    if (request.sessionId !== undefined) recorded.sessionId = request.sessionId;
    if (request.force !== undefined) recorded.force = request.force;
    this.#stopped.push(recorded);
    const index = this.#runs.findIndex((run) => run.id === request.runId);
    const run = this.#runs[index];
    if (run !== undefined) {
      const exited: HarnessRunObservation = {
        id: run.id,
        provider: run.provider,
        state: "exited",
        confidence: "high",
        reason: "Fake harness run was stopped.",
        observedAt: resolveNow(this.#now),
      };
      if (run.projectId !== undefined) exited.projectId = run.projectId;
      if (run.worktreeId !== undefined) exited.worktreeId = run.worktreeId;
      if (run.sessionId !== undefined) exited.sessionId = run.sessionId;
      if (run.providerData !== undefined) exited.providerData = run.providerData;
      this.#runs[index] = exited;
    }
    return {
      runId: request.runId,
      stopped: run !== undefined,
    };
  }

  addRun(run: HarnessRunObservation): void {
    this.#runs.push(run);
  }

  snapshot(): { runs: HarnessRunObservation[]; stopped: HarnessStopRequest[] } {
    return {
      runs: [...this.#runs],
      stopped: this.#stopped.map((request) => ({ ...request })),
    };
  }
}

export * from "./setupProfiles.js";
