import type {
  ClientFeatureFlags,
  HarnessCapabilities,
  HarnessRunObservation,
  OrphanedRuntimeState,
  ProviderHealth,
  ProviderId,
  ProviderProjectConfig,
  SafeError,
  SessionRecoveryHandle,
  SessionView,
  SnapshotHarness,
  StationAlert,
  StationSnapshot,
  TerminalAttachment,
  TerminalTargetObservation,
  WorktreeObservation,
  WorktreeRecoveryAction,
  WorktreeRow,
} from "@station/contracts";
import { STATION_SCHEMA_VERSION, worktreeHasLiveAgent } from "@station/contracts";
import { pathIsSameOrInside } from "@station/runtime";
import { harnessRunCanActivateSession, terminalCanActivateSession } from "../sessionActivation.js";
import type { ObserverHarnessRun } from "./harnessEventStatus.js";
import { countsForSnapshot, statusPolicy } from "./statusPolicy.js";

export type ObserverGraphInput = {
  generatedAt: string;
  observer: {
    pid: number;
    startedAt: string;
    version: string;
    healthy?: boolean;
  };
  projects: ProviderProjectConfig[];
  worktreeProviderId: ProviderId;
  providerHealth: Record<string, ProviderHealth>;
  harnesses?: SnapshotHarness[];
  harnessCapabilities?: Record<string, HarnessCapabilities>;
  worktrees: WorktreeObservation[];
  terminalTargets: TerminalTargetObservation[];
  harnessRuns: ObserverHarnessRun[];
  sessionMetadata?: readonly ObserverSessionMetadata[];
  recoveryHandles?: readonly SessionRecoveryHandle[];
  turnReadiness?: readonly ObserverTurnReadiness[];
  alerts?: StationAlert[];
  featureFlags?: ClientFeatureFlags;
};

export type ObserverSessionMetadata = {
  id: string;
  projectId: string;
  worktreeId: string;
  lifecycle: "legacy" | "open" | "ended";
  title?: string;
  harness?: string;
  terminalProvider?: string;
  state?: string;
  createdAt: string;
  endedAt?: string;
  lastSeenAt: string;
};

export type ObserverTurnReadiness = {
  sessionId: string;
  projectId: string;
  worktreeId: string;
  token: string;
  completedAt: string;
};

const emptyHarnessCapabilities: HarnessCapabilities = {
  canLaunch: false,
  canDiscoverRuns: false,
  canEmitEvents: false,
  canClassifyStatus: false,
  canReceivePrompt: false,
  canResume: false,
  canStop: false,
  canRunNonInteractive: false,
  canExposeApprovalState: false,
  supportsModifiedEnterSoftNewline: false,
};

const confidenceRank = {
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * POLICY
 *
 * Correlates provider observations and durable session records into canonical snapshot truth.
 */
export function buildStationSnapshot(input: ObserverGraphInput): StationSnapshot {
  const projectsById = new Map(input.projects.map((project) => [project.id, project]));
  const configuredWorktrees = input.worktrees.filter(
    (worktree) => projectsById.has(worktree.projectId) && worktree.state === "exists",
  );
  const worktreesById = new Map(configuredWorktrees.map((worktree) => [worktree.id, worktree]));
  const harnessRuns = input.harnessRuns;
  const harnessRunsById = new Map(harnessRuns.map((run) => [run.run.id, run.run]));
  const sessionMetadataById = new Map(
    input.sessionMetadata?.map((session) => [session.id, session]),
  );
  const retainedSessionByWorktree = newestRetainedSessionByWorktree(input.sessionMetadata ?? []);
  const turnReadinessBySessionId = new Map(
    input.turnReadiness?.map((readiness) => [readiness.sessionId, readiness]),
  );
  const providerAlerts = alertsFromProviderHealth(input.providerHealth, input.generatedAt);
  const alerts = [...providerAlerts, ...(input.alerts ?? [])];
  const allRows: WorktreeRow[] = [];
  const sessions: SessionView[] = [];

  for (const project of input.projects) {
    const rowsForProject = configuredWorktrees
      .filter((worktree) => worktree.projectId === project.id)
      .map((worktree) => {
        const terminal = chooseTerminal(worktree, input.terminalTargets);
        const harnessRun = chooseHarnessRun(worktree, terminal, harnessRuns);
        const terminalCapabilities =
          terminal === undefined
            ? undefined
            : input.providerHealth[terminal.provider]?.capabilities;
        const rowInput: BuildWorktreeRowInput = {
          project,
          worktree,
        };
        if (terminal !== undefined) rowInput.terminal = terminal;
        if (harnessRun !== undefined) rowInput.harnessRun = harnessRun;
        if (terminalCapabilities !== undefined)
          rowInput.terminalCapabilities = terminalCapabilities;
        const row = buildWorktreeRow(rowInput);
        attachTurnReadiness(row, turnReadinessBySessionId);
        const recovery = recoveryActionForRow({
          row,
          recoveryHandles: input.recoveryHandles ?? [],
          harnessCapabilities: input.harnessCapabilities ?? {},
          featureFlags: input.featureFlags,
        });
        if (recovery !== undefined) {
          row.recovery = recovery;
        }

        const sessionInput: BuildSessionInput = {
          project,
          worktree,
          harnessCapabilities: input.harnessCapabilities ?? {},
          sessionMetadataById,
        };
        if (terminal !== undefined) sessionInput.terminal = terminal;
        if (harnessRun !== undefined) sessionInput.harnessRun = harnessRun;
        if (terminalCapabilities !== undefined) {
          sessionInput.terminalCapabilities = terminalCapabilities;
        }
        const retainedSession = retainedSessionByWorktree.get(
          sessionWorktreeKey(project.id, worktree.id),
        );
        if (retainedSession !== undefined) {
          sessionInput.retainedSession = retainedSession;
        }
        sessions.push(...buildSessions(sessionInput));

        return row;
      })
      .sort(compareRows);

    allRows.push(...rowsForProject);
  }

  const projects = input.projects.map((project) => {
    const rows = allRows.filter((row) => row.projectId === project.id);
    const projectSessions = sessions.filter((session) => session.projectId === project.id);
    return {
      id: project.id,
      label: project.label,
      root: project.root,
      defaults: project.defaults,
      health: input.providerHealth[input.worktreeProviderId] ?? unknownProviderHealth(input),
      counts: countsForSnapshot(rows, projectSessions),
    };
  });

  const counts = {
    projects: input.projects.length,
    ...countsForSnapshot(allRows, sessions),
  };

  const observerHealthy =
    input.observer.healthy ??
    (!alerts.some((alert) => alert.severity === "error") &&
      Object.values(input.providerHealth).every((health) => health.status !== "unavailable"));

  const snapshot: StationSnapshot = {
    schemaVersion: STATION_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    observer: {
      pid: input.observer.pid,
      startedAt: input.observer.startedAt,
      version: input.observer.version,
      healthy: observerHealthy,
    },
    providerHealth: input.providerHealth,
    projects,
    rows: allRows,
    sessions,
    counts,
    alerts,
    ...(input.featureFlags === undefined ? {} : { featureFlags: input.featureFlags }),
    ...orphans(input, harnessRuns, worktreesById, projectsById, harnessRunsById),
  };
  if (input.harnesses !== undefined) {
    snapshot.harnesses = input.harnesses;
  }
  return snapshot;
}

type BuildWorktreeRowInput = {
  project: ProviderProjectConfig;
  worktree: WorktreeObservation;
  terminal?: TerminalTargetObservation;
  harnessRun?: ObserverHarnessRun;
  terminalCapabilities?: Record<string, boolean>;
};

function buildWorktreeRow(input: BuildWorktreeRowInput): WorktreeRow {
  const state = input.harnessRun?.status.value ?? "no_agent";
  const policy = statusPolicy[state];
  const warning = warningFor(input.harnessRun, input.terminal, policy.warning);
  const reason = displayReason(input.harnessRun, warning);
  const worktree: WorktreeRow["worktree"] = {
    state: input.worktree.state,
    source: input.worktree.source,
  };
  if (input.worktree.dirty !== undefined) worktree.dirty = input.worktree.dirty;
  if (input.worktree.ahead !== undefined) worktree.ahead = input.worktree.ahead;
  if (input.worktree.behind !== undefined) worktree.behind = input.worktree.behind;
  if (input.worktree.pr !== undefined) worktree.pr = input.worktree.pr;
  if (input.worktree.changeSummary !== undefined) {
    worktree.changeSummary = input.worktree.changeSummary;
  }
  if (input.worktree.checks !== undefined) worktree.checks = input.worktree.checks;
  if (input.worktree.remote !== undefined) worktree.remote = input.worktree.remote;
  if (input.worktree.headSha !== undefined) worktree.headSha = input.worktree.headSha;

  const display: WorktreeRow["display"] = {
    statusLabel: policy.label,
    sortPriority: policy.priority,
    alert: policy.alert,
  };
  if (warning) display.warning = true;
  if (reason !== undefined) display.reason = reason;

  const row: WorktreeRow = {
    id: input.worktree.id,
    projectId: input.project.id,
    projectLabel: input.project.label,
    branch: input.worktree.branch,
    path: input.worktree.path,
    worktree,
    display,
  };
  if (input.worktree.registrationIdentity !== undefined) {
    row.registrationIdentity = input.worktree.registrationIdentity;
  }
  if (input.terminal !== undefined)
    row.terminal = terminalAttachment(input.terminal, input.harnessRun, input.terminalCapabilities);
  if (input.harnessRun !== undefined) row.agent = rowAgent(input.harnessRun);
  return row;
}

function attachTurnReadiness(
  row: WorktreeRow,
  readinessBySessionId: ReadonlyMap<string, ObserverTurnReadiness>,
): void {
  const agent = row.agent;
  if (agent?.state !== "idle" || agent.sessionId === undefined) {
    return;
  }
  const readiness = readinessBySessionId.get(agent.sessionId);
  if (
    readiness === undefined ||
    readiness.projectId !== row.projectId ||
    readiness.worktreeId !== row.id
  ) {
    return;
  }
  agent.turnReadiness = {
    state: "ready_to_read",
    token: readiness.token,
    completedAt: readiness.completedAt,
  };
}

function recoveryActionForRow(input: {
  row: WorktreeRow;
  recoveryHandles: readonly SessionRecoveryHandle[];
  harnessCapabilities: Record<string, HarnessCapabilities>;
  featureFlags?: ClientFeatureFlags | undefined;
}): WorktreeRecoveryAction | undefined {
  // Snapshots expose a safe action hint only. The observer resolves the handle
  // back to native ids/files when session.resumeAgent runs.
  if (input.featureFlags?.flags.sessionResumeAgent !== true || worktreeHasLiveAgent(input.row)) {
    return undefined;
  }

  const matching = input.recoveryHandles.filter(
    (handle) =>
      handle.projectId === input.row.projectId &&
      handle.worktreeId === input.row.id &&
      input.harnessCapabilities[handle.provider]?.canResume === true,
  );
  if (matching.length !== 1) {
    return undefined;
  }

  const handle = matching[0];
  if (handle === undefined) {
    return undefined;
  }
  const action: WorktreeRecoveryAction = {
    kind: "agent-resume",
    handleId: handle.id,
    provider: handle.provider,
    targetKind: handle.target.kind,
    lastSeenAt: handle.lastSeenAt,
  };
  if (handle.sessionId !== undefined) action.sessionId = handle.sessionId;
  return action;
}

function terminalAttachment(
  terminal: TerminalTargetObservation,
  harnessRun: ObserverHarnessRun | undefined,
  capabilities?: Record<string, boolean> | undefined,
): TerminalAttachment {
  const attachment: TerminalAttachment = {
    provider: terminal.provider,
    state: terminal.state,
  };
  // Gate on the provider's capabilities: an externally-hosted provider (e.g.
  // "station") reports canFocusTarget/canCloseTarget false, so its agents are
  // not focusable/closeable from the dashboard even when the state allows it.
  // Unknown capabilities fail open (the prior state-only behavior).
  const focusable =
    terminal.focusable ??
    (capabilities?.canFocusTarget !== false && isFocusableTerminalState(terminal.state));
  const closeable =
    terminal.closeable ??
    (capabilities?.canCloseTarget !== false && isCloseableTerminalState(terminal.state));
  if (focusable) {
    attachment.focusable = true;
  }
  if (closeable) {
    attachment.closeable = true;
  }
  if (terminal.worktreeId !== undefined) attachment.hasWorkspace = true;
  if (hasPrimaryAgentEndpoint(terminal, harnessRun)) {
    attachment.hasPrimaryAgentEndpoint = true;
  }
  if (terminal.confidence !== undefined) attachment.confidence = terminal.confidence;
  if (terminal.reason !== undefined) attachment.reason = terminal.reason;
  if (terminal.observedAt !== undefined) attachment.observedAt = terminal.observedAt;
  return attachment;
}

function rowAgent(harnessRun: ObserverHarnessRun): WorktreeRow["agent"] {
  const run = harnessRun.run;
  const status = harnessRun.status;
  const agent: NonNullable<WorktreeRow["agent"]> = {
    harness: run.provider,
    state: status.value,
    runId: run.id,
    confidence: status.confidence,
    reason: status.reason,
    updatedAt: status.updatedAt,
  };
  if (status.attention !== undefined) agent.attention = status.attention;
  if (run.pid !== undefined) agent.pid = run.pid;
  if (run.sessionId !== undefined) agent.sessionId = run.sessionId;
  return agent;
}

type BuildSessionInput = {
  project: ProviderProjectConfig;
  worktree: WorktreeObservation;
  terminal?: TerminalTargetObservation;
  harnessRun?: ObserverHarnessRun;
  harnessCapabilities: Record<string, HarnessCapabilities>;
  sessionMetadataById: ReadonlyMap<string, ObserverSessionMetadata>;
  retainedSession?: ObserverSessionMetadata;
  terminalCapabilities?: Record<string, boolean>;
};

function buildSessions(input: BuildSessionInput): SessionView[] {
  const sessions: SessionView[] = [];
  const stationSession = buildStationSession(input);
  if (stationSession !== undefined) sessions.push(stationSession);
  const externalSession = buildExternalSession(input);
  if (externalSession !== undefined) sessions.push(externalSession);
  return sessions;
}

function buildStationSession(input: BuildSessionInput): SessionView | undefined {
  const identity = stationSessionIdentity(input);
  if (identity === undefined) return undefined;
  const run = identity.harnessRun?.run;
  const harnessProvider = run?.provider ?? identity.metadata?.harness;
  if (harnessProvider === undefined) return undefined;
  const terminal = terminalForStationSession({
    terminal: input.terminal,
    sessionId: identity.id,
    sessionRunId: identity.harnessRun?.run.id,
    observedOtherRunId: identity.harnessRun === undefined ? input.harnessRun?.run.id : undefined,
  });
  const status =
    identity.harnessRun?.status ??
    retainedSessionStatus(identity.metadata, input.worktree.observedAt);
  const createdAt = identity.metadata?.createdAt ?? run?.observedAt ?? terminal?.observedAt;
  if (createdAt === undefined) return undefined;

  return sessionView({
    id: identity.id,
    origin: "station",
    input,
    harnessProvider,
    status,
    createdAt,
    title: identity.metadata?.title ?? input.worktree.branch,
    ...(identity.harnessRun === undefined ? {} : { harnessRun: identity.harnessRun }),
    ...(terminal === undefined ? {} : { terminal }),
  });
}

function buildExternalSession(input: BuildSessionInput): SessionView | undefined {
  const harnessRun = input.harnessRun;
  const run = harnessRun?.run;
  if (
    harnessRun === undefined ||
    run === undefined ||
    run.sessionId !== undefined ||
    !externalRunRepresentsSession(harnessRun)
  ) {
    return undefined;
  }
  const terminal = terminalForExternalRun(input.terminal, run.id);
  return sessionView({
    id: run.id,
    origin: "external",
    input,
    harnessProvider: run.provider,
    harnessRun,
    status: harnessRun.status,
    createdAt: run.observedAt,
    title: input.worktree.branch,
    ...(terminal === undefined ? {} : { terminal }),
  });
}

type StationSessionIdentity = {
  id: string;
  metadata?: ObserverSessionMetadata;
  harnessRun?: ObserverHarnessRun;
};

function stationSessionIdentity(input: BuildSessionInput): StationSessionIdentity | undefined {
  const harnessRun = input.harnessRun;
  if (harnessRun?.run.sessionId !== undefined) {
    const runSessionId = harnessRun.run.sessionId;
    const metadata = input.sessionMetadataById.get(runSessionId);
    if (
      !sessionMetadataIsEnded(metadata) &&
      (metadata?.lifecycle === "open" ||
        harnessRunCanActivateSession({
          run: harnessRun.run,
          terminals: input.terminal === undefined ? [] : [input.terminal],
          runs: [harnessRun.run],
        }))
    ) {
      return {
        id: runSessionId,
        harnessRun,
        ...(metadata === undefined ? {} : { metadata }),
      };
    }
  }

  const terminalSessionId = input.terminal?.sessionId;
  if (
    terminalSessionId !== undefined &&
    input.terminal !== undefined &&
    terminalCanActivateSession({
      target: input.terminal,
      runs: input.harnessRun === undefined ? [] : [input.harnessRun.run],
    })
  ) {
    const metadata = input.sessionMetadataById.get(terminalSessionId);
    if (metadata !== undefined && !sessionMetadataIsEnded(metadata)) {
      return { id: metadata.id, metadata };
    }
  }

  const retained = input.retainedSession;
  return retained === undefined ? undefined : { id: retained.id, metadata: retained };
}

function sessionMetadataIsEnded(metadata: ObserverSessionMetadata | undefined): boolean {
  return metadata?.lifecycle === "ended" || metadata?.endedAt !== undefined;
}

function terminalForStationSession(input: {
  terminal: TerminalTargetObservation | undefined;
  sessionId: string;
  sessionRunId: string | undefined;
  observedOtherRunId: string | undefined;
}): TerminalTargetObservation | undefined {
  const { terminal } = input;
  if (terminal === undefined) return undefined;
  if (terminal.sessionId === undefined) {
    return input.sessionRunId !== undefined && terminal.harnessRunId === input.sessionRunId
      ? terminal
      : undefined;
  }
  if (terminal.sessionId !== input.sessionId) return undefined;
  if (terminal.harnessRunId === undefined) return terminal;
  if (input.sessionRunId !== undefined) {
    return terminal.harnessRunId === input.sessionRunId ? terminal : undefined;
  }
  return terminal.harnessRunId === input.observedOtherRunId ? undefined : terminal;
}

function terminalForExternalRun(
  terminal: TerminalTargetObservation | undefined,
  runId: string,
): TerminalTargetObservation | undefined {
  if (terminal?.sessionId !== undefined) return undefined;
  return terminal?.harnessRunId === runId ? terminal : undefined;
}

function sessionView(input: {
  id: string;
  origin: SessionView["origin"];
  input: BuildSessionInput;
  harnessProvider: string;
  harnessRun?: ObserverHarnessRun;
  terminal?: TerminalTargetObservation;
  status: SessionView["status"];
  createdAt: string;
  title: string;
}): SessionView {
  const run = input.harnessRun?.run;
  const harness: SessionView["harness"] = {
    provider: input.harnessProvider,
    mode: "unknown",
    capabilities:
      input.input.harnessCapabilities[input.harnessProvider] ?? emptyHarnessCapabilities,
  };
  if (run !== undefined) harness.runId = run.id;
  if (run?.pid !== undefined) harness.pid = run.pid;

  const session: SessionView = {
    id: input.id,
    origin: input.origin,
    projectId: input.input.project.id,
    worktreeId: input.input.worktree.id,
    createdAt: input.createdAt,
    updatedAt: input.status.updatedAt,
    harness,
    status: {
      value: input.status.value,
      confidence: input.status.confidence,
      reason: input.status.reason,
      source: input.status.source,
      updatedAt: input.status.updatedAt,
    },
    title: input.title,
    tags: [],
  };
  if (input.status.attention !== undefined) session.status.attention = input.status.attention;
  if (input.terminal !== undefined) {
    session.terminal = terminalAttachment(
      input.terminal,
      input.harnessRun,
      input.input.terminalCapabilities,
    );
  }
  return session;
}

function externalRunRepresentsSession(run: ObserverHarnessRun): boolean {
  return (
    run.status.value !== "none" && run.status.value !== "unknown" && run.status.value !== "exited"
  );
}

function retainedSessionStatus(
  metadata: ObserverSessionMetadata | undefined,
  fallbackUpdatedAt: string,
): SessionView["status"] {
  const updatedAt = metadata?.lastSeenAt ?? fallbackUpdatedAt;
  return {
    value: "none",
    confidence: "low",
    reason: "No harness run is currently observed for this Station session.",
    source: "reconcile",
    updatedAt,
  };
}

function newestRetainedSessionByWorktree(
  sessions: readonly ObserverSessionMetadata[],
): ReadonlyMap<string, ObserverSessionMetadata> {
  const retained = new Map<string, ObserverSessionMetadata>();
  for (const session of sessions) {
    if (
      session.lifecycle !== "open" ||
      session.endedAt !== undefined ||
      session.harness === undefined
    ) {
      continue;
    }
    const key = sessionWorktreeKey(session.projectId, session.worktreeId);
    const current = retained.get(key);
    if (current === undefined || compareSessionRecency(session, current) > 0) {
      retained.set(key, session);
    }
  }
  return retained;
}

function sessionWorktreeKey(projectId: string, worktreeId: string): string {
  return JSON.stringify([projectId, worktreeId]);
}

function compareSessionRecency(
  left: ObserverSessionMetadata,
  right: ObserverSessionMetadata,
): number {
  return (
    Date.parse(left.lastSeenAt) - Date.parse(right.lastSeenAt) ||
    Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

function isFocusableTerminalState(state: TerminalTargetObservation["state"]): boolean {
  return state === "open" || state === "detached" || state === "unknown";
}

function isCloseableTerminalState(state: TerminalTargetObservation["state"]): boolean {
  return state === "open" || state === "detached" || state === "unknown" || state === "stale";
}

function hasPrimaryAgentEndpoint(
  terminal: TerminalTargetObservation,
  harnessRun: ObserverHarnessRun | undefined,
): boolean {
  return (
    terminal.harnessBinding?.role === "main-agent" ||
    terminal.harnessRunId !== undefined ||
    terminal.sessionId !== undefined ||
    harnessRun !== undefined
  );
}

function chooseTerminal(
  worktree: WorktreeObservation,
  terminals: TerminalTargetObservation[],
): TerminalTargetObservation | undefined {
  return terminals
    .filter(
      (terminal) =>
        terminal.worktreeId === worktree.id && terminalTargetMatchesWorktree(terminal, worktree),
    )
    .sort(compareObservations)[0];
}

function terminalTargetMatchesWorktree(
  terminal: TerminalTargetObservation,
  worktree: WorktreeObservation,
): boolean {
  if (terminal.cwd === undefined || terminal.cwd.length === 0) {
    return true;
  }
  return pathIsSameOrInside(terminal.cwd, worktree.path);
}

function chooseHarnessRun(
  worktree: WorktreeObservation,
  terminal: TerminalTargetObservation | undefined,
  runs: ObserverHarnessRun[],
): ObserverHarnessRun | undefined {
  // Prefer an explicit terminal-to-run binding, then fall back to the best run for the worktree.
  if (terminal?.harnessRunId !== undefined) {
    const boundRun = runs.find((run) => run.run.id === terminal.harnessRunId);
    if (boundRun !== undefined) {
      return boundRun;
    }
  }

  return runs.filter((run) => run.run.worktreeId === worktree.id).sort(compareHarnessRuns)[0];
}

function compareRows(left: WorktreeRow, right: WorktreeRow): number {
  return (
    left.display.sortPriority - right.display.sortPriority ||
    left.branch.localeCompare(right.branch) ||
    left.id.localeCompare(right.id)
  );
}

function compareObservations(
  left: TerminalTargetObservation,
  right: TerminalTargetObservation,
): number {
  return (
    confidenceRank[right.confidence] - confidenceRank[left.confidence] ||
    Date.parse(right.observedAt) - Date.parse(left.observedAt) ||
    left.id.localeCompare(right.id)
  );
}

function compareHarnessRuns(left: ObserverHarnessRun, right: ObserverHarnessRun): number {
  return (
    statusPolicy[left.status.value].priority - statusPolicy[right.status.value].priority ||
    confidenceRank[right.status.confidence] - confidenceRank[left.status.confidence] ||
    Date.parse(right.status.updatedAt) - Date.parse(left.status.updatedAt) ||
    left.run.id.localeCompare(right.run.id)
  );
}

function displayReason(
  harnessRun: ObserverHarnessRun | undefined,
  warning: boolean,
): string | undefined {
  if (harnessRun === undefined) {
    return "No harness run is associated with this worktree.";
  }
  if (
    harnessRun.status.value === "needs_attention" ||
    harnessRun.status.value === "stuck" ||
    warning
  ) {
    return harnessRun.status.reason;
  }
  return undefined;
}

function warningFor(
  harnessRun: ObserverHarnessRun | undefined,
  terminal: TerminalTargetObservation | undefined,
  defaultWarning: boolean,
): boolean {
  if (defaultWarning) {
    return true;
  }
  if (harnessRun?.status.value !== "unknown") {
    return false;
  }

  const reason = `${harnessRun.status.reason} ${terminal?.reason ?? ""}`.toLowerCase();
  return (
    reason.includes("conflict") ||
    reason.includes("stale") ||
    reason.includes("failed") ||
    reason.includes("invalid")
  );
}

function unknownProviderHealth(input: ObserverGraphInput): ProviderHealth {
  return {
    providerId: input.worktreeProviderId,
    providerType: "worktree",
    status: "unknown",
    lastCheckedAt: input.generatedAt,
  };
}

function alertsFromProviderHealth(
  providerHealth: Record<string, ProviderHealth>,
  generatedAt: string,
): StationAlert[] {
  return Object.values(providerHealth)
    .filter((health) => health.status === "unavailable" || health.status === "degraded")
    .map((health) => {
      const alert: StationAlert = {
        id: `alert_${health.providerId}_${health.status}`,
        severity: health.status === "unavailable" ? "error" : "warn",
        message:
          health.lastError?.message ??
          `The ${health.providerType} provider ${health.providerId} is ${health.status}.`,
        provider: health.providerId,
        createdAt: generatedAt,
      };
      if (health.lastError?.code !== undefined) {
        alert.code = health.lastError.code;
      }
      return alert;
    });
}

function orphans(
  input: ObserverGraphInput,
  harnessRuns: ObserverHarnessRun[],
  worktreesById: Map<string, WorktreeObservation>,
  projectsById: Map<string, ProviderProjectConfig>,
  harnessRunsById: Map<string, HarnessRunObservation>,
): { orphans?: OrphanedRuntimeState[] } {
  // Runtime state without a configured worktree remains visible as an orphan instead of disappearing.
  const orphans: OrphanedRuntimeState[] = [];

  for (const terminal of input.terminalTargets) {
    const hasProject = terminal.projectId === undefined || projectsById.has(terminal.projectId);
    const worktree =
      terminal.worktreeId === undefined ? undefined : worktreesById.get(terminal.worktreeId);
    const hasWorktree = worktree !== undefined;
    const hasHarness =
      terminal.harnessRunId === undefined || harnessRunsById.has(terminal.harnessRunId);
    const pathMismatch =
      worktree !== undefined && !terminalTargetMatchesWorktree(terminal, worktree);

    if (!hasProject || !hasWorktree || !hasHarness || pathMismatch) {
      const orphan: OrphanedRuntimeState = {
        id: `orphan_${terminal.id}`,
        kind: "terminal_target",
        provider: terminal.provider,
        terminalTargetId: terminal.id,
        reason: pathMismatch
          ? "Terminal target path does not match the configured worktree."
          : "Terminal target has no matching configured project or worktree.",
        observedAt: terminal.observedAt,
      };
      if (terminal.projectId !== undefined) orphan.projectId = terminal.projectId;
      if (terminal.worktreeId !== undefined) orphan.worktreeId = terminal.worktreeId;
      if (terminal.sessionId !== undefined) orphan.sessionId = terminal.sessionId;
      orphans.push(orphan);
    }
  }

  for (const harnessRun of harnessRuns) {
    const run = harnessRun.run;
    const hasProject = run.projectId === undefined || projectsById.has(run.projectId);
    const hasWorktree = run.worktreeId !== undefined && worktreesById.has(run.worktreeId);

    if (!hasProject || !hasWorktree) {
      const orphan: OrphanedRuntimeState = {
        id: `orphan_${run.id}`,
        kind: "harness_run",
        provider: run.provider,
        harnessRunId: run.id,
        reason: "Harness run has no matching configured project or worktree.",
        observedAt: run.observedAt,
      };
      if (run.projectId !== undefined) orphan.projectId = run.projectId;
      if (run.worktreeId !== undefined) orphan.worktreeId = run.worktreeId;
      if (run.sessionId !== undefined) orphan.sessionId = run.sessionId;
      orphans.push(orphan);
    }
  }

  if (orphans.length === 0) {
    return {};
  }
  return { orphans };
}

export function safeErrorToProviderHealth(input: {
  providerId: ProviderId;
  providerType: ProviderHealth["providerType"];
  lastCheckedAt: string;
  lastError: SafeError;
  capabilities?: Record<string, boolean>;
  latencyMs?: number;
}): ProviderHealth {
  const health: ProviderHealth = {
    providerId: input.providerId,
    providerType: input.providerType,
    status: "unavailable",
    lastCheckedAt: input.lastCheckedAt,
    lastError: input.lastError,
  };
  if (input.latencyMs !== undefined) health.latencyMs = input.latencyMs;
  if (input.capabilities !== undefined) health.capabilities = input.capabilities;
  return health;
}
