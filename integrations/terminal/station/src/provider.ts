import type {
  ManagedTerminalLaunchProcessResult,
  ManagedTerminalLifecycle,
  OpenWorkspaceRequest,
  OpenWorkspaceResult,
  ProjectId,
  ProviderDoctorCheck,
  ProviderHealth,
  ProviderId,
  SessionId,
  TerminalCapabilities,
  TerminalIdentityBinding,
  TerminalLaunchProcessRequest,
  TerminalReattachInfo,
  TerminalTargetId,
  TerminalTargetObservation,
  WorktreeId,
} from "@station/contracts";
import { terminalTargetObservationFromBinding } from "@station/contracts";
import { type HostListEntry, type HostSpawnParamsInput, stationHostSafeError } from "@station/host";
import { type RuntimeClock, systemClock, toIsoTimestamp } from "@station/runtime";
import { STATION_TERMINAL_PROVIDER_ID, StationTerminalProviderError } from "./errors.js";
import type { StationHostController } from "./host/hostController.js";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export type StationTerminalProviderOptions = {
  clock?: RuntimeClock;
  /**
   * When present (the `stationPersistentAgents` flag is on), the provider is
   * host-backed: it spawns into / focuses / closes / lists the standalone
   * station-station-host. Absent ⇒ the Station UI owns the PTY locally and focus/close
   * throw, capabilities stay false.
   */
  host?: StationHostController;
};

/**
 * ADAPTER
 *
 * Station terminal provider: UI-hosted mode is a registration shim; host-backed
 * mode uses `host.list` as liveness truth so reattach/restart re-derives the
 * same session instead of minting another.
 */
export class StationTerminalProvider implements ManagedTerminalLifecycle {
  readonly id: ProviderId = STATION_TERMINAL_PROVIDER_ID;

  readonly #clock: RuntimeClock;
  readonly #host: StationHostController | undefined;
  readonly #targets = new Map<TerminalTargetId, TerminalTargetObservation>();
  // Targets backed by a host PTY (spawned via launchProcess or rebuilt from
  // host.list). listTargets drops ONLY these when their PTY is gone; a UI-hosted
  // fallback target (host was unavailable at launch) is kept until releaseTarget.
  readonly #hostBackedTargets = new Set<string>();

  constructor(options: StationTerminalProviderOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#host = options.host;
  }

  capabilities(): TerminalCapabilities {
    const hostBacked = this.#host !== undefined;
    return {
      canOpenWorkspace: true,
      // Observer-side focus/close are real only when a host owns the PTY.
      canFocusTarget: hostBacked,
      canCloseTarget: hostBacked,
      canCaptureOutput: false,
      canSendInput: false,
      canPersistIdentityBinding: true,
      canDisplayPopup: false,
    };
  }

  async health(): Promise<ProviderHealth> {
    return {
      providerId: this.id,
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
    } catch {
      return [
        {
          name: "station-host",
          status: "warn",
          message: `station host unreachable at ${this.#host.socketPath}; persistent agents are unavailable`,
          error: stationHostSafeError("HOST_UNREACHABLE", "Station host is not reachable."),
        },
      ];
    }
  }

  /**
   * Host-backed mode reconciles against `host.list`: rebuild lost live targets,
   * drop dead host targets, and dedupe by deterministic station target id.
   */
  async listTargets(): Promise<TerminalTargetObservation[]> {
    if (this.#host === undefined) {
      return [...this.#targets.values()];
    }
    let live: HostListEntry[];
    try {
      live = await this.#host.client().list();
    } catch {
      return [...this.#targets.values()];
    }
    const aliveById = new Map<string, HostListEntry>();
    for (const entry of live) {
      // Aux PTYs are owned by the Station UI (splits / [+sh] shells). They must
      // never enter reconcile: #rebuildObservation stamps every rebuilt entry
      // `main-agent`, which would mint phantom sessions/runs and rank them for
      // focus/close. Excluding them here is the single chokepoint — every other
      // host.list consumer reads the observations this produces, not host.list.
      if (!entry.alive || entry.kind === "aux" || aliveById.has(entry.terminalTargetId)) {
        continue;
      }
      aliveById.set(entry.terminalTargetId, entry);
    }
    for (const [targetId, entry] of aliveById) {
      this.#targets.set(targetId as TerminalTargetId, this.#rebuildObservation(entry));
      this.#hostBackedTargets.add(targetId); // live in host.list ⇒ host-backed
    }
    for (const targetId of [...this.#targets.keys()]) {
      // Drop only host-backed targets whose PTY is gone; a UI-hosted fallback
      // target has no host PTY and must survive until the UI reports its exit.
      if (this.#hostBackedTargets.has(targetId) && !aliveById.has(targetId)) {
        this.#targets.delete(targetId);
        this.#hostBackedTargets.delete(targetId);
      }
    }
    return [...this.#targets.values()];
  }

  /**
   * Register an externally-hosted target (no spawn). The binding carries the
   * `main-agent` harness binding `discoverTerminalBoundHarnessRuns` keys on. One
   * target per worktree: re-opening upserts by the deterministic id.
   */
  async openWorkspace(request: OpenWorkspaceRequest): Promise<OpenWorkspaceResult> {
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
    this.#targets.set(targetId, observation);
    return {
      target: binding,
      agentEndpointId: targetId,
    };
  }

  /**
   * Host-backed spawn ownership: spawn the agent into the host so it outlives the
   * UI. Returns `started: false` when not host-backed or the host is unavailable,
   * so the observer falls back to the UI spawning from the launch plan.
   */
  async launchProcess(
    request: TerminalLaunchProcessRequest,
  ): Promise<ManagedTerminalLaunchProcessResult> {
    const base = {
      terminalTargetId: request.terminalTarget.targetId,
      agentEndpointId: request.agentEndpointId,
    };
    if (this.#host === undefined) {
      return { ...base, started: false };
    }
    const handle = await this.#host.ensure();
    if (handle.status !== "running") {
      return { ...base, started: false };
    }
    const spawned = await handle.client.spawn(buildSpawnParams(request));
    this.#hostBackedTargets.add(request.terminalTarget.targetId);
    // Hand back the reattach info from the spawn result so the caller need not
    // re-query host.list — and so "started" and "has a handle" never diverge.
    return {
      ...base,
      started: true,
      reattach: { endpointId: spawned.ptyId, socketPath: this.#host.socketPath },
    };
  }

  async reattachInfo(targetId: TerminalTargetId): Promise<TerminalReattachInfo | undefined> {
    if (this.#host === undefined) {
      return undefined;
    }
    const entry = await this.#liveEntry(targetId);
    if (entry === undefined) {
      return undefined;
    }
    return { endpointId: entry.ptyId, socketPath: this.#host.socketPath };
  }

  async focusTarget(targetId: TerminalTargetId): Promise<void> {
    if (this.#host === undefined) {
      throw this.#hostedError(targetId, "focus");
    }
    await this.#host.client().focus(await this.#requirePtyId(targetId));
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
  async releaseTarget(targetId: TerminalTargetId): Promise<boolean> {
    this.#hostBackedTargets.delete(targetId);
    return this.#targets.delete(targetId);
  }

  async #liveEntry(targetId: TerminalTargetId): Promise<HostListEntry | undefined> {
    if (this.#host === undefined) {
      return undefined;
    }
    let live: HostListEntry[];
    try {
      live = await this.#host.client().list();
    } catch {
      return undefined;
    }
    return live.find((entry) => entry.terminalTargetId === targetId && entry.alive);
  }

  async #requirePtyId(targetId: TerminalTargetId): Promise<string> {
    const entry = await this.#liveEntry(targetId);
    if (entry === undefined) {
      const worktreeId = targetIdWorktree(targetId);
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
      focusable: true,
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
      hint: `This agent is hosted by the Station UI; ${action} it from Station instead.`,
    };
    if (target?.worktreeId !== undefined) options.worktreeId = target.worktreeId;
    if (target?.sessionId !== undefined) options.sessionId = target.sessionId;
    return new StationTerminalProviderError(
      "TERMINAL_STATION_HOSTED",
      `The station terminal provider cannot ${action} an externally-hosted target.`,
      options,
    );
  }
}

export function stationTargetId(worktreeId: string): TerminalTargetId {
  return `${STATION_TERMINAL_PROVIDER_ID}:${worktreeId}`;
}

function targetIdWorktree(targetId: string): string | undefined {
  const prefix = `${STATION_TERMINAL_PROVIDER_ID}:`;
  return targetId.startsWith(prefix) ? targetId.slice(prefix.length) : undefined;
}

function buildSpawnParams(request: TerminalLaunchProcessRequest): HostSpawnParamsInput {
  const binding = request.terminalTarget;
  const sessionId = binding.sessionId;
  if (sessionId === undefined) {
    throw new StationTerminalProviderError(
      "TERMINAL_TARGET_MISSING",
      "Cannot host-spawn a station agent without a session id.",
    );
  }
  return {
    terminalTargetId: binding.targetId,
    worktreeId: binding.worktreeId ?? request.worktree.id,
    projectId: binding.projectId ?? request.project.id,
    sessionId,
    worktreePath: binding.harnessBinding?.worktreePath ?? request.worktree.path,
    harnessProvider: binding.harnessBinding?.harnessProvider ?? request.launchPlan.provider,
    command: request.launchPlan.command,
    args: request.launchPlan.args,
    ...(request.launchPlan.env === undefined ? {} : { env: request.launchPlan.env }),
    cwd: request.launchPlan.cwd ?? request.worktree.path,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
  };
}
