import type {
  ManagedOpenWorkspaceResult,
  ManagedTerminalAttachment,
  ManagedTerminalLaunchProcessRequest,
  ManagedTerminalLaunchProcessResult,
  ManagedTerminalLifecycle,
  OpenWorkspaceRequest,
  OpenWorkspaceResult,
  ProjectId,
  ProviderDoctorCheck,
  ProviderHealth,
  ProviderId,
  ReleaseManagedTerminalTargetRequest,
  SafeError,
  SessionId,
  TerminalCapabilities,
  TerminalIdentityBinding,
  TerminalLaunchProcessRequest,
  TerminalOutputCompatibility,
  TerminalTargetId,
  TerminalTargetObservation,
  WorktreeId,
} from "@station/contracts";
import { terminalTargetObservationFromBinding } from "@station/contracts";
import {
  type HostListEntry,
  type HostSpawnParamsInput,
  isStationHostCompatibilityError,
  stationHostSafeError,
} from "@station/host";
import {
  type RuntimeClock,
  safeErrorFromUnknown,
  systemClock,
  toIsoTimestamp,
} from "@station/runtime";
import { STATION_TERMINAL_PROVIDER_ID, StationTerminalProviderError } from "./errors.js";
import type { StationHostController } from "./host/hostController.js";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export type StationTerminalProviderOptions = {
  clock?: RuntimeClock;
  /**
   * When present (the `stationPersistentAgents` flag is on), Station Host supplies
   * spawn, list, close, and attachment lifecycle. Native Station still owns
   * presentation, so external focus remains unsupported. Without Host, the Station
   * UI owns the PTY locally and close is unsupported too.
   */
  host?: StationHostController;
};

type PreviousTargetBinding = {
  observation: TerminalTargetObservation;
  bindingToken?: string | undefined;
  hostBacked: boolean;
};

type TerminalTargetListResult =
  | { status: "complete"; targets: TerminalTargetObservation[] }
  | { status: "indeterminate"; targets: TerminalTargetObservation[]; error: SafeError };

/**
 * ADAPTER
 *
 * Station terminal provider: UI-hosted mode is a registration shim; host-backed
 * mode supplies process lifecycle, opaque attachment identity, and reconciled
 * tri-state attachment evidence. Native presentation remains locally owned by
 * Station and is never externally focusable.
 * Attachment evidence is false for UI-owned targets, true only when the latest
 * Host listing applies, and absent for cached Host targets after an uncertain read.
 * Reconcile-aware discovery declares cached fallback indeterminate so it cannot
 * masquerade as current debug evidence.
 * Deterministic targets are released only when their current Station session and,
 * for managed launch attempts, opaque binding generation match.
 */
export class StationTerminalProvider implements ManagedTerminalLifecycle {
  readonly id: ProviderId = STATION_TERMINAL_PROVIDER_ID;

  readonly #clock: RuntimeClock;
  readonly #host: StationHostController | undefined;
  readonly #targets = new Map<TerminalTargetId, TerminalTargetObservation>();
  // Targets backed by a host PTY (spawned via launchProcess or rebuilt from
  // host.list). listTargets drops ONLY these when their process is gone; a UI-hosted
  // fallback target (host was unavailable at launch) is kept until releaseTarget.
  readonly #hostBackedTargets = new Set<string>();
  readonly #bindingTokens = new Map<TerminalTargetId, string>();
  readonly #previousBindings = new Map<TerminalTargetId, PreviousTargetBinding[]>();
  #pendingOrphanRecovery: Promise<boolean> | undefined;
  #targetRevision = 0;
  #listRequestSequence = 0;
  #appliedHostListSequence: number | undefined;
  #bindingSequence = 0;

  constructor(options: StationTerminalProviderOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#host = options.host;
  }

  capabilities(): TerminalCapabilities {
    const hostBacked = this.#host !== undefined;
    return {
      canOpenWorkspace: true,
      // Host backing grants lifecycle cleanup and attachment, not presentation control.
      canFocusTarget: false,
      canCloseTarget: hostBacked,
      canCaptureOutput: false,
      canSendInput: false,
      canPersistIdentityBinding: true,
      canLaunchProcessPersistently: hostBacked,
      canDisplayPopup: false,
    };
  }

  async health(): Promise<ProviderHealth> {
    return {
      provider: this.id,
      providerType: "terminal",
      status: "healthy",
      lastCheckedAt: toIsoTimestamp(this.#clock.now()),
      capabilities: this.capabilities(),
    };
  }

  /**
   * Surface the station host's status to `stn doctor` / `setup check`. Only
   * host-backed providers report; an unreachable host degrades to `warn`
   * (UI-hosted launches still work, persistent agents do not).
   */
  async doctorChecks(): Promise<ProviderDoctorCheck[]> {
    if (this.#host === undefined) {
      return [];
    }
    try {
      const live = await this.#host.client().list();
      // Count agents only; aux PTYs (Station-owned splits / [+sh] shells) share the
      // host but are not harness runs and would inflate the "agents" figure.
      const count = live.filter((entry) => entry.alive && entry.kind !== "aux").length;
      return [
        {
          name: "station-host",
          status: "ok",
          message: `running, owns ${count} agent(s), reattachable`,
        },
      ];
    } catch (error) {
      const safeError = safeErrorFromUnknown(
        error,
        stationHostSafeError("HOST_UNREACHABLE", "Station host is not reachable."),
      );
      return [
        {
          name: "station-host",
          status: "warn",
          message: `${safeError.message} Persistent agents are unavailable at ${this.#host.socketPath}.`,
          error: safeError,
        },
      ];
    }
  }

  /**
   * Host-backed mode reconciles against `host.list`: rebuild lost live targets,
   * drop dead host targets, and dedupe by deterministic station target id.
   */
  async listTargets(): Promise<TerminalTargetObservation[]> {
    return (await this.#listTargetsWithOutcome()).targets;
  }

  async listTargetsForReconcile(): Promise<TerminalTargetObservation[]> {
    const result = await this.#listTargetsWithOutcome();
    if (result.status === "indeterminate") {
      throw result.error;
    }
    return result.targets;
  }

  async #listTargetsWithOutcome(): Promise<TerminalTargetListResult> {
    if (this.#host === undefined) {
      return { status: "complete", targets: this.#listedTargets() };
    }
    this.#listRequestSequence += 1;
    const requestSequence = this.#listRequestSequence;
    const targetRevision = this.#targetRevision;
    let orphanRecovery = this.#pendingOrphanRecovery;
    if (orphanRecovery === undefined) {
      orphanRecovery = this.#host.recoverOrphanedTargets().finally(() => {
        this.#pendingOrphanRecovery = undefined;
      });
      this.#pendingOrphanRecovery = orphanRecovery;
    }
    const recoveredOrphans = await orphanRecovery;
    let live: HostListEntry[];
    try {
      live = await this.#host.client().list();
    } catch (error) {
      if (isStationHostCompatibilityError(error)) {
        throw error;
      }
      if (recoveredOrphans) {
        throw error;
      }
      const targets = this.#listedTargets();
      if (this.#hasCurrentHostEvidence()) {
        return { status: "complete", targets };
      }
      return {
        status: "indeterminate",
        targets,
        error: safeErrorFromUnknown(
          error,
          stationHostSafeError("HOST_UNREACHABLE", "Station host target listing failed."),
        ),
      };
    }
    // A response cannot overwrite a target rebound, released, or host-backed
    // after this request began; a newer list request also supersedes this view.
    if (requestSequence !== this.#listRequestSequence || targetRevision !== this.#targetRevision) {
      const targets = this.#listedTargets();
      if (this.#hasCurrentHostEvidence()) {
        return { status: "complete", targets };
      }
      return {
        status: "indeterminate",
        targets,
        error: stationHostSafeError(
          "HOST_REQUEST_FAILED",
          "Station host target listing was superseded before it could be applied.",
        ),
      };
    }
    const aliveById = new Map<string, HostListEntry>();
    for (const entry of live) {
      // Aux PTYs are owned by the Station UI (splits / [+sh] shells). They must
      // never enter reconcile: #rebuildObservation stamps every rebuilt entry
      // `main-agent`, which would mint phantom sessions/runs and expose them for
      // lifecycle cleanup. Excluding them here is the single chokepoint — every
      // other host.list consumer reads the observations this produces, not host.list.
      if (!entry.alive || entry.kind === "aux" || aliveById.has(entry.terminalTargetId)) {
        continue;
      }
      aliveById.set(entry.terminalTargetId, entry);
    }
    for (const [targetId, entry] of aliveById) {
      const typedTargetId = targetId as TerminalTargetId;
      if (this.#targets.get(typedTargetId)?.sessionId !== entry.sessionId) {
        this.#bindingTokens.delete(typedTargetId);
        this.#previousBindings.delete(typedTargetId);
      }
      this.#targets.set(typedTargetId, this.#rebuildObservation(entry));
      this.#hostBackedTargets.add(targetId); // live in host.list ⇒ host-backed
    }
    for (const targetId of [...this.#targets.keys()]) {
      // Drop only host-backed targets whose PTY is gone; a UI-hosted fallback
      // target has no host PTY and must survive until the UI reports its exit.
      if (this.#hostBackedTargets.has(targetId) && !aliveById.has(targetId)) {
        this.#targets.delete(targetId);
        this.#hostBackedTargets.delete(targetId);
        this.#bindingTokens.delete(targetId);
        this.#previousBindings.delete(targetId);
      }
    }
    this.#appliedHostListSequence = requestSequence;
    return { status: "complete", targets: this.#listedTargets() };
  }

  #hasCurrentHostEvidence(): boolean {
    return (
      this.#appliedHostListSequence !== undefined &&
      this.#appliedHostListSequence === this.#listRequestSequence
    );
  }

  #listedTargets(): TerminalTargetObservation[] {
    const hasCurrentHostEvidence = this.#hasCurrentHostEvidence();
    return [...this.#targets.values()].map((target) => {
      const observation: TerminalTargetObservation = { ...target };
      if (!this.#hostBackedTargets.has(target.id)) {
        observation.hasManagedAttachment = false;
      } else if (hasCurrentHostEvidence) {
        observation.hasManagedAttachment = true;
      }
      return observation;
    });
  }

  /**
   * Register an externally-hosted target (no spawn). The binding carries the
   * `main-agent` harness binding `discoverTerminalBoundHarnessRuns` keys on. One
   * target per worktree: re-opening upserts by the deterministic id.
   */
  async openWorkspace(request: OpenWorkspaceRequest): Promise<OpenWorkspaceResult> {
    const opened = this.#registerWorkspace(request);
    this.#previousBindings.delete(opened.target.targetId);
    return opened;
  }

  /** Opens one provisional managed-launch binding that exact failure cleanup can roll back. */
  async openManagedWorkspace(request: OpenWorkspaceRequest): Promise<ManagedOpenWorkspaceResult> {
    return this.#registerWorkspace(request);
  }

  #registerWorkspace(request: OpenWorkspaceRequest): ManagedOpenWorkspaceResult {
    const targetId = stationTargetId(request.worktree.id);
    const binding: TerminalIdentityBinding = {
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
      reason: "Station-hosted terminal target registered; the PTY is owned by the Station UI.",
    };
    const observation = terminalTargetObservationFromBinding({
      binding,
      worktree: request.worktree,
      observedAt: toIsoTimestamp(this.#clock.now()),
    });
    observation.focusable = false;
    observation.closeable = false;
    const previous = this.#targets.get(targetId);
    if (previous !== undefined) {
      const stack = this.#previousBindings.get(targetId) ?? [];
      stack.push({
        observation: previous,
        bindingToken: this.#bindingTokens.get(targetId),
        hostBacked: this.#hostBackedTargets.has(targetId),
      });
      this.#previousBindings.set(targetId, stack);
    } else {
      this.#previousBindings.delete(targetId);
    }
    const bindingToken = `binding_${++this.#bindingSequence}`;
    this.#targets.set(targetId, observation);
    this.#bindingTokens.set(targetId, bindingToken);
    // Re-registration starts a new provisional generation; Host ownership must be
    // proven again by this generation's spawn or a matching live Host entry.
    this.#hostBackedTargets.delete(targetId);
    this.#targetRevision += 1;
    return {
      target: binding,
      agentEndpointId: targetId,
      bindingToken,
    };
  }

  /**
   * Host-backed spawn ownership: spawn the agent into the host so it outlives the
   * UI. Returns `started: false` when not host-backed or the host is unavailable,
   * so the observer permits the UI to spawn from the launch plan and apply any
   * harness compatibility selected at this adapter boundary.
   */
  async launchProcess(
    request: TerminalLaunchProcessRequest,
  ): Promise<ManagedTerminalLaunchProcessResult> {
    const bindingToken = this.#bindingTokens.get(request.terminalTarget.targetId);
    if (bindingToken === undefined) {
      this.#throwLaunchBindingSuperseded(request);
    }
    const managedRequest: ManagedTerminalLaunchProcessRequest = { ...request, bindingToken };
    try {
      return await this.launchManagedProcess(managedRequest);
    } catch (error) {
      await this.#releaseLaunchTarget(managedRequest);
      throw error;
    }
  }

  async launchManagedProcess(
    request: ManagedTerminalLaunchProcessRequest,
  ): Promise<ManagedTerminalLaunchProcessResult> {
    const base = {
      terminalTargetId: request.terminalTarget.targetId,
      agentEndpointId: request.agentEndpointId,
    };
    this.#assertLaunchBindingCurrent(request);
    if (this.#host === undefined) {
      this.#commitLaunchBinding(request);
      return localLaunchResult(request);
    }
    const handle = await this.#host.ensure();
    if (handle.status !== "running") {
      if (isStationHostCompatibilityError(handle.error)) {
        throw handle.error;
      }
      this.#commitLaunchBinding(request);
      return localLaunchResult(request);
    }
    await handle.client.spawn(buildSpawnParams(request));
    if (this.#targetMatchesLaunch(request)) {
      this.#hostBackedTargets.add(request.terminalTarget.targetId);
      this.#targetRevision += 1;
    }
    this.#commitLaunchBinding(request);
    return {
      ...base,
      started: true,
      attachment: {
        kind: "managed-terminal",
        terminalTargetId: request.terminalTarget.targetId,
      },
    };
  }

  async attachmentForTarget(
    targetId: TerminalTargetId,
  ): Promise<ManagedTerminalAttachment | undefined> {
    if (this.#host === undefined) {
      return undefined;
    }
    const expectedSessionId = this.#targets.get(targetId)?.sessionId;
    const entry = await this.#liveEntry(targetId, expectedSessionId);
    if (
      entry === undefined ||
      (expectedSessionId !== undefined &&
        this.#targets.get(targetId)?.sessionId !== expectedSessionId)
    ) {
      return undefined;
    }
    return { kind: "managed-terminal", terminalTargetId: targetId };
  }

  async focusTarget(targetId: TerminalTargetId): Promise<void> {
    throw this.#hostedError(targetId, "focus");
  }

  async closeTarget(targetId: TerminalTargetId): Promise<void> {
    if (this.#host === undefined) {
      throw this.#hostedError(targetId, "close");
    }
    await this.#host.client().close(await this.#requirePtyId(targetId));
  }

  /**
   * Drop an abandoned or exited target so the next reconcile removes the session.
   * Host-backed liveness in `listTargets` is the other removal path.
   */
  async releaseTarget(request: ReleaseManagedTerminalTargetRequest): Promise<boolean> {
    const target = this.#targets.get(request.targetId);
    if (
      target?.sessionId !== request.expectedSessionId ||
      (request.expectedBindingToken !== undefined &&
        this.#bindingTokens.get(request.targetId) !== request.expectedBindingToken)
    ) {
      return false;
    }
    this.#hostBackedTargets.delete(request.targetId);
    this.#bindingTokens.delete(request.targetId);
    const previous = this.#previousBindings.get(request.targetId)?.pop();
    if (previous === undefined) {
      this.#targets.delete(request.targetId);
      this.#previousBindings.delete(request.targetId);
    } else {
      this.#targets.set(request.targetId, previous.observation);
      if (previous.bindingToken !== undefined) {
        this.#bindingTokens.set(request.targetId, previous.bindingToken);
      }
      if (previous.hostBacked) {
        this.#hostBackedTargets.add(request.targetId);
      }
      if (this.#previousBindings.get(request.targetId)?.length === 0) {
        this.#previousBindings.delete(request.targetId);
      }
    }
    this.#targetRevision += 1;
    return true;
  }

  #targetMatchesLaunch(request: ManagedTerminalLaunchProcessRequest): boolean {
    const sessionId = request.terminalTarget.sessionId;
    return (
      sessionId !== undefined &&
      this.#targets.get(request.terminalTarget.targetId)?.sessionId === sessionId &&
      this.#bindingTokens.get(request.terminalTarget.targetId) === request.bindingToken
    );
  }

  #assertLaunchBindingCurrent(request: ManagedTerminalLaunchProcessRequest): void {
    if (this.#targetMatchesLaunch(request)) {
      return;
    }
    this.#throwLaunchBindingSuperseded(request);
  }

  #throwLaunchBindingSuperseded(request: TerminalLaunchProcessRequest): never {
    throw new StationTerminalProviderError(
      "TERMINAL_TARGET_SUPERSEDED",
      "The managed terminal binding was superseded before launch.",
      {
        worktreeId: request.worktree.id,
        ...(request.terminalTarget.sessionId === undefined
          ? {}
          : { sessionId: request.terminalTarget.sessionId }),
      },
    );
  }

  #commitLaunchBinding(request: ManagedTerminalLaunchProcessRequest): void {
    if (!this.#targetMatchesLaunch(request)) {
      return;
    }
    this.#previousBindings.delete(request.terminalTarget.targetId);
  }

  async #releaseLaunchTarget(request: ManagedTerminalLaunchProcessRequest): Promise<boolean> {
    const sessionId = request.terminalTarget.sessionId;
    if (sessionId === undefined || !this.#targetMatchesLaunch(request)) {
      return false;
    }
    return this.releaseTarget({
      targetId: request.terminalTarget.targetId,
      expectedSessionId: sessionId,
      expectedBindingToken: request.bindingToken,
    });
  }

  async #liveEntry(
    targetId: TerminalTargetId,
    expectedSessionId?: SessionId,
  ): Promise<HostListEntry | undefined> {
    if (this.#host === undefined) {
      return undefined;
    }
    let live: HostListEntry[];
    try {
      live = await this.#host.client().list();
    } catch (error) {
      if (isStationHostCompatibilityError(error)) {
        throw error;
      }
      return undefined;
    }
    return live.find(
      (entry) =>
        entry.kind === "agent" &&
        entry.terminalTargetId === targetId &&
        entry.alive &&
        (expectedSessionId === undefined || entry.sessionId === expectedSessionId),
    );
  }

  async #requirePtyId(targetId: TerminalTargetId): Promise<string> {
    const entry = await this.#liveEntry(targetId);
    if (entry === undefined) {
      const prefix = `${STATION_TERMINAL_PROVIDER_ID}:`;
      const worktreeId = targetId.startsWith(prefix) ? targetId.slice(prefix.length) : undefined;
      throw new StationTerminalProviderError(
        "TERMINAL_TARGET_MISSING",
        "No live host PTY for this station target.",
        worktreeId === undefined ? {} : { worktreeId },
      );
    }
    return entry.ptyId;
  }

  #rebuildObservation(entry: HostListEntry): TerminalTargetObservation {
    // Feed worktreePath into BOTH cwd and harnessBinding.worktreePath, or
    // terminalTargetMatchesKnownWorktree drops the rebuilt run.
    return {
      id: entry.terminalTargetId as TerminalTargetId,
      provider: this.id,
      state: "open",
      focusable: false,
      closeable: true,
      confidence: "high",
      reason: "Rehydrated from station-host liveness after reconnect.",
      observedAt: toIsoTimestamp(this.#clock.now()),
      projectId: entry.projectId as ProjectId,
      worktreeId: entry.worktreeId as WorktreeId,
      sessionId: entry.sessionId as SessionId,
      cwd: entry.worktreePath,
      harnessBinding: {
        role: "main-agent",
        harnessProvider: entry.harnessProvider as ProviderId,
        worktreePath: entry.worktreePath,
      },
    };
  }

  #hostedError(
    targetId: TerminalTargetId,
    action: "focus" | "close",
  ): StationTerminalProviderError {
    const target = this.#targets.get(targetId);
    const options: ConstructorParameters<typeof StationTerminalProviderError>[2] = {
      hint:
        action === "focus"
          ? "Open native Station and select the session there."
          : "This agent is hosted by the Station UI; close it from Station instead.",
    };
    if (target?.worktreeId !== undefined) options.worktreeId = target.worktreeId;
    if (target?.sessionId !== undefined) options.sessionId = target.sessionId;
    return new StationTerminalProviderError(
      "TERMINAL_STATION_HOSTED",
      action === "focus"
        ? "Native Station sessions cannot be focused from an external dashboard."
        : "The station terminal provider cannot close an externally-hosted target.",
      options,
    );
  }
}

export function stationTargetId(worktreeId: string): TerminalTargetId {
  return `${STATION_TERMINAL_PROVIDER_ID}:${worktreeId}`;
}

function buildSpawnParams(request: ManagedTerminalLaunchProcessRequest): HostSpawnParamsInput {
  const binding = request.terminalTarget;
  const sessionId = binding.sessionId;
  if (sessionId === undefined) {
    throw new StationTerminalProviderError(
      "TERMINAL_TARGET_MISSING",
      "Cannot host-spawn a station agent without a session id.",
    );
  }
  const harnessProvider = harnessProviderForLaunch(request);
  const params: HostSpawnParamsInput = {
    terminalTargetId: binding.targetId,
    worktreeId: binding.worktreeId ?? request.worktree.id,
    projectId: binding.projectId ?? request.project.id,
    sessionId,
    worktreePath: binding.harnessBinding?.worktreePath ?? request.worktree.path,
    harnessProvider,
    command: request.launchPlan.command,
    args: request.launchPlan.args,
    cwd: request.launchPlan.cwd ?? request.worktree.path,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
  };
  if (request.launchPlan.env !== undefined) {
    params.env = request.launchPlan.env;
  }
  const outputCompatibility = outputCompatibilityForLaunch(request);
  if (outputCompatibility !== undefined) {
    params.outputCompatibility = outputCompatibility;
  }
  return params;
}

function harnessProviderForLaunch(request: ManagedTerminalLaunchProcessRequest): ProviderId {
  return request.terminalTarget.harnessBinding?.harnessProvider ?? request.launchPlan.provider;
}

function outputCompatibilityForLaunch(
  request: ManagedTerminalLaunchProcessRequest,
): TerminalOutputCompatibility | undefined {
  return harnessProviderForLaunch(request) === "codex" ? "top-region-scrollback" : undefined;
}

function localLaunchResult(
  request: ManagedTerminalLaunchProcessRequest,
): Extract<ManagedTerminalLaunchProcessResult, { started: false }> {
  const result: Extract<ManagedTerminalLaunchProcessResult, { started: false }> = {
    terminalTargetId: request.terminalTarget.targetId,
    agentEndpointId: request.agentEndpointId,
    started: false,
  };
  const outputCompatibility = outputCompatibilityForLaunch(request);
  if (outputCompatibility !== undefined) {
    result.outputCompatibility = outputCompatibility;
  }
  return result;
}
