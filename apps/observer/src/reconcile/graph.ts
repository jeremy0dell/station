import type {
  ClientFeatureFlags,
  HarnessCapabilities,
  HarnessRunObservation,
  OrphanedRuntimeState,
  ProviderHealth,
  ProviderId,
  ProviderProjectConfig,
  SafeError,
  SessionGroupView,
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
import {
  AGENT_STATUS,
  STATION_SCHEMA_VERSION,
  terminalBoundHarnessRunObservation,
  worktreeDisplayForAgentState,
  worktreeHasLiveAgent,
} from "@station/contracts";
import { pathIsSameOrInside } from "@station/runtime";
import { sessionRecoveryEligibility } from "../sessionRecovery/eligibility.js";
import { selectNewestSessionRecoveryCandidate } from "../sessionRecovery/selection.js";
import { harnessRunCanActivateSession, terminalCanActivateSession } from "./sessionActivation.js";
import { projectSessionGroups } from "./sessionGroups.js";
import { countsForSnapshot } from "./snapshotCounts.js";
import { terminalControlEvidence } from "./terminalControlEvidence.js";

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
  harnessRuns: HarnessRunObservation[];
  sessionMetadata?: readonly ObserverSessionMetadata[];
  worktreeDisplayTitles?: readonly ObserverWorktreeDisplayTitle[];
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

export type ObserverWorktreeDisplayTitle = {
  projectId: string;
  worktreeId: string;
  title: string;
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

export type SnapshotProjectionResult<T, TReason extends string> =
  | { status: "applied"; snapshot: StationSnapshot; value: T }
  | { status: "already-exact"; snapshot: StationSnapshot; value: T }
  | { status: "rejected"; snapshot: StationSnapshot; reason: TReason };

export type CreatedWorktreeProjectionRejectionReason =
  | "project_not_configured"
  | "project_not_in_snapshot"
  | "provider_mismatch"
  | "project_mismatch"
  | "worktree_not_present"
  | "worktree_id_collision"
  | "worktree_path_collision"
  | "worktree_branch_collision"
  | "worktree_registration_collision";

export type PreparedExternalLaunchProjectionRejectionReason =
  | "project_not_configured"
  | "project_not_in_snapshot"
  | "worktree_missing"
  | "worktree_provider_mismatch"
  | "worktree_identity_mismatch"
  | "session_not_open"
  | "session_identity_mismatch"
  | "session_harness_mismatch"
  | "session_terminal_provider_mismatch"
  | "session_conflict"
  | "terminal_provider_mismatch"
  | "terminal_target_mismatch"
  | "terminal_project_mismatch"
  | "terminal_worktree_mismatch"
  | "terminal_session_mismatch"
  | "terminal_not_open"
  | "terminal_path_mismatch"
  | "terminal_harness_binding_missing"
  | "terminal_harness_mismatch"
  | "terminal_harness_role_mismatch"
  | "terminal_harness_path_mismatch"
  | "terminal_evidence_older"
  | "agent_session_conflict"
  | "agent_harness_conflict"
  | "harness_not_registered";

export type PreparedExternalLaunchProjection = {
  row: WorktreeRow;
  session: SessionView;
  created: boolean;
};

/**
 * POLICY
 *
 * Correlates provider observations with canonical worktree title input and durable session records.
 * Branch names remain only the defensive title fallback when persistence is unavailable.
 */
export function buildStationSnapshot(input: ObserverGraphInput): StationSnapshot {
  const projectsById = new Map(input.projects.map((project) => [project.id, project]));
  const configuredWorktrees = input.worktrees.filter(
    (worktree) => projectsById.has(worktree.projectId) && worktree.state === "exists",
  );
  const worktreesById = new Map(configuredWorktrees.map((worktree) => [worktree.id, worktree]));
  const harnessRuns = input.harnessRuns;
  const harnessRunsById = new Map(harnessRuns.map((run) => [run.id, run]));
  const sessionMetadataById = new Map(
    input.sessionMetadata?.map((session) => [session.id, session]),
  );
  const titleByWorktree = new Map(
    input.worktreeDisplayTitles?.map((title) => [
      sessionWorktreeKey(title.projectId, title.worktreeId),
      title.title,
    ]),
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
        const title =
          titleByWorktree.get(sessionWorktreeKey(project.id, worktree.id)) ?? worktree.branch;
        const rowInput: BuildWorktreeRowInput = {
          project,
          worktree,
          title,
        };
        if (terminal !== undefined) rowInput.terminal = terminal;
        if (harnessRun !== undefined) rowInput.harnessRun = harnessRun;
        if (terminalCapabilities !== undefined)
          rowInput.terminalCapabilities = terminalCapabilities;
        const row = buildWorktreeRow(rowInput);
        attachTurnReadiness(row, turnReadinessBySessionId);
        const retainedSession = retainedSessionByWorktree.get(
          sessionWorktreeKey(project.id, worktree.id),
        );
        const recovery = recoveryActionForRow({
          row,
          recoveryHandles: input.recoveryHandles ?? [],
          harnessCapabilities: input.harnessCapabilities ?? {},
          sessionMetadata: input.sessionMetadata ?? [],
          retainedSession,
          featureFlags: input.featureFlags,
        });
        if (recovery !== undefined) {
          row.recovery = recovery;
        }

        const sessionInput: BuildSessionInput = {
          project,
          worktree,
          title,
          harnessCapabilities: input.harnessCapabilities ?? {},
          sessionMetadataById,
        };
        if (terminal !== undefined) sessionInput.terminal = terminal;
        if (harnessRun !== undefined) sessionInput.harnessRun = harnessRun;
        if (terminalCapabilities !== undefined) {
          sessionInput.terminalCapabilities = terminalCapabilities;
        }
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
    sessionGroups: [],
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

export function projectProviderHealthOntoSnapshot(input: {
  snapshot: StationSnapshot;
  health: ProviderHealth;
  projectedAt: string;
}): StationSnapshot {
  const providerHealth: Record<string, ProviderHealth> = {
    ...input.snapshot.providerHealth,
    [input.health.provider]: input.health,
  };
  const providerAlertIds = new Set([
    providerHealthAlertId(input.health.provider, "degraded"),
    providerHealthAlertId(input.health.provider, "unavailable"),
  ]);
  const alerts = [
    ...input.snapshot.alerts.filter((alert) => !providerAlertIds.has(alert.id)),
    ...alertsFromProviderHealth({ [input.health.provider]: input.health }, input.projectedAt),
  ];
  const healthy =
    !alerts.some((alert) => alert.severity === "error") &&
    Object.values(providerHealth).every((health) => health.status !== "unavailable");

  return {
    ...input.snapshot,
    generatedAt: input.projectedAt,
    observer: {
      ...input.snapshot.observer,
      healthy,
    },
    providerHealth,
    projects: input.snapshot.projects.map((project) =>
      project.health.provider === input.health.provider
        ? { ...project, health: input.health }
        : project,
    ),
    alerts,
  };
}

export function projectCreatedWorktreeOntoSnapshot(input: {
  snapshot: StationSnapshot;
  project: ProviderProjectConfig | undefined;
  worktreeProviderId: ProviderId;
  worktree: WorktreeObservation;
  projectedAt: string;
}): SnapshotProjectionResult<WorktreeRow, CreatedWorktreeProjectionRejectionReason> {
  if (input.project === undefined) {
    return rejectedProjection(input.snapshot, "project_not_configured");
  }
  if (!input.snapshot.projects.some((project) => project.id === input.project?.id)) {
    return rejectedProjection(input.snapshot, "project_not_in_snapshot");
  }
  if (input.worktree.provider !== input.worktreeProviderId) {
    return rejectedProjection(input.snapshot, "provider_mismatch");
  }
  if (input.worktree.projectId !== input.project.id) {
    return rejectedProjection(input.snapshot, "project_mismatch");
  }
  if (input.worktree.state !== "exists") {
    return rejectedProjection(input.snapshot, "worktree_not_present");
  }

  const sameId = input.snapshot.rows.find((row) => row.id === input.worktree.id);
  if (sameId !== undefined) {
    return worktreeRowHasExactIdentity(sameId, input.worktree)
      ? { status: "already-exact", snapshot: input.snapshot, value: sameId }
      : rejectedProjection(input.snapshot, "worktree_id_collision");
  }
  if (input.snapshot.rows.some((row) => row.path === input.worktree.path)) {
    return rejectedProjection(input.snapshot, "worktree_path_collision");
  }
  if (
    input.snapshot.rows.some(
      (row) => row.projectId === input.project?.id && row.branch === input.worktree.branch,
    )
  ) {
    return rejectedProjection(input.snapshot, "worktree_branch_collision");
  }
  if (
    input.worktree.registrationIdentity !== undefined &&
    input.snapshot.rows.some(
      (row) => row.registrationIdentity === input.worktree.registrationIdentity,
    )
  ) {
    return rejectedProjection(input.snapshot, "worktree_registration_collision");
  }

  const row = buildWorktreeRow({
    project: input.project,
    worktree: input.worktree,
    title: input.worktree.branch,
  });
  const rows = [...input.snapshot.rows, row].sort(compareRows);
  const snapshot = rebuildSnapshotCounts({
    snapshot: input.snapshot,
    rows,
    sessions: input.snapshot.sessions,
    generatedAt: input.projectedAt,
  });
  return { status: "applied", snapshot, value: row };
}

export function projectPreparedExternalLaunchOntoSnapshot(input: {
  snapshot: StationSnapshot;
  projects: readonly ProviderProjectConfig[];
  project: ProviderProjectConfig | undefined;
  worktreeProviderId: ProviderId;
  worktree: WorktreeObservation;
  terminalProviderId: ProviderId;
  terminalTargetId: string;
  terminalTarget: TerminalTargetObservation;
  harnessProviderId: ProviderId;
  session: ObserverSessionMetadata;
  sessionGroups: readonly SessionGroupView[];
  harnessCapabilities: Record<string, HarnessCapabilities>;
  terminalCapabilities?: {
    canFocusTarget?: boolean;
    canCloseTarget?: boolean;
  };
  projectedAt: string;
}): SnapshotProjectionResult<
  PreparedExternalLaunchProjection,
  PreparedExternalLaunchProjectionRejectionReason
> {
  const project = input.project;
  if (project === undefined) {
    return rejectedProjection(input.snapshot, "project_not_configured");
  }
  if (!input.snapshot.projects.some((candidate) => candidate.id === project.id)) {
    return rejectedProjection(input.snapshot, "project_not_in_snapshot");
  }
  const currentRow = input.snapshot.rows.find((row) => row.id === input.worktree.id);
  if (currentRow === undefined) {
    return rejectedProjection(input.snapshot, "worktree_missing");
  }
  if (input.worktree.provider !== input.worktreeProviderId) {
    return rejectedProjection(input.snapshot, "worktree_provider_mismatch");
  }
  if (
    input.worktree.projectId !== project.id ||
    input.worktree.state !== "exists" ||
    !worktreeRowHasExactIdentity(currentRow, input.worktree)
  ) {
    return rejectedProjection(input.snapshot, "worktree_identity_mismatch");
  }
  if (input.session.lifecycle !== "open" || input.session.endedAt !== undefined) {
    return rejectedProjection(input.snapshot, "session_not_open");
  }
  if (input.session.projectId !== project.id || input.session.worktreeId !== input.worktree.id) {
    return rejectedProjection(input.snapshot, "session_identity_mismatch");
  }
  if (input.session.harness !== input.harnessProviderId) {
    return rejectedProjection(input.snapshot, "session_harness_mismatch");
  }
  if (input.session.terminalProvider !== input.terminalProviderId) {
    return rejectedProjection(input.snapshot, "session_terminal_provider_mismatch");
  }
  if (input.harnessCapabilities[input.harnessProviderId] === undefined) {
    return rejectedProjection(input.snapshot, "harness_not_registered");
  }

  const terminalRejection = validatePreparedTerminalTarget(input);
  if (terminalRejection !== undefined) {
    return rejectedProjection(input.snapshot, terminalRejection);
  }
  if (
    terminalEvidenceIsNewer(currentRow.terminal, input.terminalTarget.observedAt) ||
    input.snapshot.sessions.some(
      (session) =>
        session.id === input.session.id &&
        terminalEvidenceIsNewer(session.terminal, input.terminalTarget.observedAt),
    )
  ) {
    return rejectedProjection(input.snapshot, "terminal_evidence_older");
  }

  const currentSession = input.snapshot.sessions.find(
    (candidate) => candidate.id === input.session.id,
  );
  if (
    currentSession !== undefined &&
    (currentSession.origin !== "station" ||
      currentSession.projectId !== project.id ||
      currentSession.worktreeId !== input.worktree.id ||
      currentSession.createdAt !== input.session.createdAt)
  ) {
    return rejectedProjection(input.snapshot, "session_identity_mismatch");
  }
  if (
    input.snapshot.sessions.some(
      (candidate) =>
        candidate.id !== input.session.id &&
        candidate.projectId === project.id &&
        candidate.worktreeId === input.worktree.id,
    )
  ) {
    return rejectedProjection(input.snapshot, "session_conflict");
  }
  if (currentSession !== undefined && currentSession.harness.provider !== input.harnessProviderId) {
    return rejectedProjection(input.snapshot, "session_harness_mismatch");
  }
  if (
    currentRow.agent?.sessionId !== undefined &&
    currentRow.agent.sessionId !== input.session.id
  ) {
    return rejectedProjection(input.snapshot, "agent_session_conflict");
  }
  if (currentRow.agent !== undefined && currentRow.agent.harness !== input.harnessProviderId) {
    return rejectedProjection(input.snapshot, "agent_harness_conflict");
  }

  const terminalBoundRun = terminalBoundHarnessRunObservation({
    harnessProvider: input.harnessProviderId,
    target: input.terminalTarget,
    currentCommand: input.terminalTarget.harnessBinding?.currentCommand,
    reason: "Managed launch succeeded; harness status has not yet been verified.",
  });
  const projectedRow = buildWorktreeRow({
    project,
    worktree: input.worktree,
    title: input.session.title ?? currentRow.title,
    terminal: input.terminalTarget,
    harnessRun: terminalBoundRun,
    ...(input.terminalCapabilities === undefined
      ? {}
      : { terminalCapabilities: input.terminalCapabilities }),
  });
  if (projectedRow.terminal === undefined || projectedRow.agent === undefined) {
    return rejectedProjection(input.snapshot, "session_identity_mismatch");
  }
  const preserveCurrentAgent =
    currentRow.agent !== undefined &&
    currentRow.agent.sessionId === input.session.id &&
    currentRow.agent.harness === input.harnessProviderId &&
    Date.parse(currentRow.agent.updatedAt) > Date.parse(terminalBoundRun.status.updatedAt);
  const row: WorktreeRow = {
    ...currentRow,
    title: projectedRow.title,
    terminal: projectedRow.terminal,
    agent: preserveCurrentAgent ? currentRow.agent : projectedRow.agent,
    display: preserveCurrentAgent ? currentRow.display : projectedRow.display,
  };

  const projectedSession = buildStationSession({
    project,
    worktree: input.worktree,
    title: input.session.title ?? currentRow.title,
    terminal: input.terminalTarget,
    harnessRun: terminalBoundRun,
    harnessCapabilities: input.harnessCapabilities,
    sessionMetadataById: new Map([[input.session.id, input.session]]),
    retainedSession: input.session,
    ...(input.terminalCapabilities === undefined
      ? {}
      : { terminalCapabilities: input.terminalCapabilities }),
  });
  if (projectedSession === undefined) {
    return rejectedProjection(input.snapshot, "session_identity_mismatch");
  }
  const session = preserveNewerSessionStatus(projectedSession, currentSession);
  const created = currentSession === undefined;
  const rows = input.snapshot.rows
    .map((candidate) => (candidate.id === row.id ? row : candidate))
    .sort(compareRows);
  const sessions = sortSessions(
    created
      ? [...input.snapshot.sessions, session]
      : input.snapshot.sessions.map((candidate) =>
          candidate.id === session.id ? session : candidate,
        ),
    input.snapshot,
    rows,
  );
  const sessionGroups = projectSessionGroups({
    groups: input.sessionGroups,
    projects: input.projects,
    sessions,
  });
  const value = { row, session, created };
  if (
    rows.length === input.snapshot.rows.length &&
    sessions.length === input.snapshot.sessions.length &&
    rows.every((candidate, index) => snapshotValueEquals(candidate, input.snapshot.rows[index])) &&
    sessions.every((candidate, index) =>
      snapshotValueEquals(candidate, input.snapshot.sessions[index]),
    ) &&
    sessionGroups.length === input.snapshot.sessionGroups.length &&
    sessionGroups.every((candidate, index) =>
      snapshotValueEquals(candidate, input.snapshot.sessionGroups[index]),
    )
  ) {
    return { status: "already-exact", snapshot: input.snapshot, value };
  }

  const countedSnapshot = rebuildSnapshotCounts({
    snapshot: input.snapshot,
    rows,
    sessions,
    generatedAt: input.projectedAt,
  });
  return {
    status: "applied",
    snapshot: {
      ...countedSnapshot,
      sessionGroups,
    },
    value,
  };
}

type BuildWorktreeRowInput = {
  project: ProviderProjectConfig;
  worktree: WorktreeObservation;
  title: string;
  terminal?: TerminalTargetObservation;
  harnessRun?: HarnessRunObservation;
  terminalCapabilities?: Record<string, boolean>;
};

function buildWorktreeRow(input: BuildWorktreeRowInput): WorktreeRow {
  const display = worktreeDisplayForAgentState(input.harnessRun?.status.value);
  const warning = warningFor(input.harnessRun, input.terminal, display.warning === true);
  const reason = displayReason(input.harnessRun, display.alert || warning);
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

  if (warning) display.warning = true;
  if (reason !== undefined) display.reason = reason;

  const row: WorktreeRow = {
    id: input.worktree.id,
    projectId: input.project.id,
    projectLabel: input.project.label,
    title: input.title,
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
  sessionMetadata: readonly ObserverSessionMetadata[];
  retainedSession?: ObserverSessionMetadata | undefined;
  featureFlags?: ClientFeatureFlags | undefined;
}): WorktreeRecoveryAction | undefined {
  // Snapshots expose a safe action hint only. The observer resolves the handle
  // back to native ids/files when session.resumeAgent runs.
  if (input.featureFlags?.flags.sessionResumeAgent !== true || worktreeHasLiveAgent(input.row)) {
    return undefined;
  }

  const eligible = input.recoveryHandles.flatMap((handle) => {
    const capabilities = input.harnessCapabilities[handle.provider];
    const eligibilityInput: Parameters<typeof sessionRecoveryEligibility>[0] = {
      handle,
      projectId: input.row.projectId,
      worktreeId: input.row.id,
      worktreePath: input.row.path,
      stationSessions: input.sessionMetadata,
      allowNoLocalSession: true,
    };
    if (input.retainedSession?.harness !== undefined) {
      eligibilityInput.expectedSession = {
        id: input.retainedSession.id,
        harness: input.retainedSession.harness,
      };
    }
    if (capabilities !== undefined) {
      eligibilityInput.registeredHarness = {
        id: handle.provider,
        canResume: capabilities.canResume,
      };
    }
    return sessionRecoveryEligibility(eligibilityInput).kind === "eligible" ? [{ handle }] : [];
  });
  // Snapshot actions and launch resolution share one total order so reconcile cannot advertise a
  // different recovery target than the command will validate and launch.
  const selected = selectNewestSessionRecoveryCandidate(eligible);
  if (selected === undefined) {
    return undefined;
  }
  const handle = selected.handle;
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
  harnessRun: HarnessRunObservation | undefined,
  capabilities?: Record<string, boolean> | undefined,
): TerminalAttachment {
  const attachment: TerminalAttachment = {
    provider: terminal.provider,
    state: terminal.state,
  };
  const control = terminalControlEvidence(terminal, capabilities);
  if (control.focusable !== undefined) attachment.focusable = control.focusable;
  if (control.closeable !== undefined) attachment.closeable = control.closeable;
  if (terminal.worktreeId !== undefined) attachment.hasWorkspace = true;
  if (hasPrimaryAgentEndpoint(terminal, harnessRun)) {
    attachment.hasPrimaryAgentEndpoint = true;
  }
  if (terminal.confidence !== undefined) attachment.confidence = terminal.confidence;
  if (terminal.reason !== undefined) attachment.reason = terminal.reason;
  if (terminal.observedAt !== undefined) attachment.observedAt = terminal.observedAt;
  return attachment;
}

function rowAgent(run: HarnessRunObservation): WorktreeRow["agent"] {
  const status = run.status;
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
  title: string;
  terminal?: TerminalTargetObservation;
  harnessRun?: HarnessRunObservation;
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
  const run = identity.harnessRun;
  const harnessProvider = run?.provider ?? identity.metadata?.harness;
  if (harnessProvider === undefined) return undefined;
  const terminal = terminalForStationSession({
    terminal: input.terminal,
    sessionId: identity.id,
    sessionRunId: identity.harnessRun?.id,
    observedOtherRunId: identity.harnessRun === undefined ? input.harnessRun?.id : undefined,
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
    title: input.title,
    ...(identity.harnessRun === undefined ? {} : { harnessRun: identity.harnessRun }),
    ...(terminal === undefined ? {} : { terminal }),
  });
}

function buildExternalSession(input: BuildSessionInput): SessionView | undefined {
  const harnessRun = input.harnessRun;
  const run = harnessRun;
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
    title: input.title,
    ...(terminal === undefined ? {} : { terminal }),
  });
}

type StationSessionIdentity = {
  id: string;
  metadata?: ObserverSessionMetadata;
  harnessRun?: HarnessRunObservation;
};

function stationSessionIdentity(input: BuildSessionInput): StationSessionIdentity | undefined {
  const harnessRun = input.harnessRun;
  if (harnessRun?.sessionId !== undefined) {
    const runSessionId = harnessRun.sessionId;
    const metadata = input.sessionMetadataById.get(runSessionId);
    if (
      !sessionMetadataIsEnded(metadata) &&
      (metadata?.lifecycle === "open" ||
        harnessRunCanActivateSession({
          run: harnessRun,
          terminals: input.terminal === undefined ? [] : [input.terminal],
          runs: [harnessRun],
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
      runs: input.harnessRun === undefined ? [] : [input.harnessRun],
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
  harnessRun?: HarnessRunObservation;
  terminal?: TerminalTargetObservation;
  status: SessionView["status"];
  createdAt: string;
  title: string;
}): SessionView {
  const run = input.harnessRun;
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

function externalRunRepresentsSession(run: HarnessRunObservation): boolean {
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

function hasPrimaryAgentEndpoint(
  terminal: TerminalTargetObservation,
  harnessRun: HarnessRunObservation | undefined,
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
  runs: HarnessRunObservation[],
): HarnessRunObservation | undefined {
  // Prefer an explicit terminal-to-run binding, then fall back to the best run for the worktree.
  if (terminal?.harnessRunId !== undefined) {
    const boundRun = runs.find((run) => run.id === terminal.harnessRunId);
    if (boundRun !== undefined) {
      return boundRun;
    }
  }

  return runs.filter((run) => run.worktreeId === worktree.id).sort(compareHarnessRuns)[0];
}

function compareRows(left: WorktreeRow, right: WorktreeRow): number {
  return (
    left.display.sortPriority - right.display.sortPriority ||
    left.branch.localeCompare(right.branch) ||
    left.id.localeCompare(right.id)
  );
}

function worktreeRowHasExactIdentity(row: WorktreeRow, worktree: WorktreeObservation): boolean {
  return (
    row.id === worktree.id &&
    row.projectId === worktree.projectId &&
    row.path === worktree.path &&
    row.branch === worktree.branch &&
    row.registrationIdentity === worktree.registrationIdentity &&
    row.worktree.state === worktree.state &&
    row.worktree.source === worktree.source
  );
}

function validatePreparedTerminalTarget(input: {
  project: ProviderProjectConfig | undefined;
  worktree: WorktreeObservation;
  terminalProviderId: ProviderId;
  terminalTargetId: string;
  terminalTarget: TerminalTargetObservation;
  harnessProviderId: ProviderId;
  session: ObserverSessionMetadata;
}): PreparedExternalLaunchProjectionRejectionReason | undefined {
  const project = input.project;
  if (project === undefined) return "project_not_configured";
  const target = input.terminalTarget;
  if (target.provider !== input.terminalProviderId) return "terminal_provider_mismatch";
  if (target.id !== input.terminalTargetId) return "terminal_target_mismatch";
  if (target.projectId !== project.id) return "terminal_project_mismatch";
  if (target.worktreeId !== input.worktree.id) return "terminal_worktree_mismatch";
  if (target.sessionId !== input.session.id) return "terminal_session_mismatch";
  if (target.state !== "open") return "terminal_not_open";
  if (target.cwd !== input.worktree.path) return "terminal_path_mismatch";
  const binding = target.harnessBinding;
  if (binding === undefined) return "terminal_harness_binding_missing";
  if (binding.harnessProvider !== input.harnessProviderId) return "terminal_harness_mismatch";
  if (binding.role !== "main-agent") return "terminal_harness_role_mismatch";
  if (binding.worktreePath !== input.worktree.path) {
    return "terminal_harness_path_mismatch";
  }
  return undefined;
}

function terminalEvidenceIsNewer(
  terminal: TerminalAttachment | undefined,
  projectedAt: string,
): boolean {
  return (
    terminal?.observedAt !== undefined && Date.parse(terminal.observedAt) > Date.parse(projectedAt)
  );
}

function preserveNewerSessionStatus(
  projected: SessionView,
  current: SessionView | undefined,
): SessionView {
  if (
    current === undefined ||
    Date.parse(current.status.updatedAt) <= Date.parse(projected.status.updatedAt)
  ) {
    return projected;
  }
  return {
    ...projected,
    updatedAt: current.updatedAt,
    harness: {
      ...projected.harness,
      mode: current.harness.mode,
      ...(current.harness.pid === undefined ? {} : { pid: current.harness.pid }),
      ...(current.harness.runId === undefined ? {} : { runId: current.harness.runId }),
    },
    status: current.status,
    tags: current.tags,
  };
}

function sortSessions(
  sessions: readonly SessionView[],
  snapshot: StationSnapshot,
  rows: readonly WorktreeRow[],
): SessionView[] {
  const projectOrder = new Map(snapshot.projects.map((project, index) => [project.id, index]));
  const rowOrder = new Map(rows.map((row, index) => [row.id, index]));
  return [...sessions].sort(
    (left, right) =>
      (projectOrder.get(left.projectId) ?? Number.MAX_SAFE_INTEGER) -
        (projectOrder.get(right.projectId) ?? Number.MAX_SAFE_INTEGER) ||
      (rowOrder.get(left.worktreeId) ?? Number.MAX_SAFE_INTEGER) -
        (rowOrder.get(right.worktreeId) ?? Number.MAX_SAFE_INTEGER) ||
      (left.origin === right.origin ? 0 : left.origin === "station" ? -1 : 1) ||
      left.id.localeCompare(right.id),
  );
}

function rebuildSnapshotCounts(input: {
  snapshot: StationSnapshot;
  rows: WorktreeRow[];
  sessions: SessionView[];
  generatedAt: string;
}): StationSnapshot {
  return {
    ...input.snapshot,
    generatedAt: input.generatedAt,
    rows: input.rows,
    sessions: input.sessions,
    projects: input.snapshot.projects.map((project) => {
      const projectRows = input.rows.filter((row) => row.projectId === project.id);
      const projectSessions = input.sessions.filter((session) => session.projectId === project.id);
      return {
        ...project,
        counts: countsForSnapshot(projectRows, projectSessions),
      };
    }),
    counts: {
      projects: input.snapshot.projects.length,
      ...countsForSnapshot(input.rows, input.sessions),
    },
  };
}

function rejectedProjection<TReason extends string>(
  snapshot: StationSnapshot,
  reason: TReason,
): { status: "rejected"; snapshot: StationSnapshot; reason: TReason } {
  return { status: "rejected", snapshot, reason };
}

function snapshotValueEquals<T>(left: T, right: T | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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

function compareHarnessRuns(left: HarnessRunObservation, right: HarnessRunObservation): number {
  return (
    AGENT_STATUS[left.status.value].priority - AGENT_STATUS[right.status.value].priority ||
    confidenceRank[right.status.confidence] - confidenceRank[left.status.confidence] ||
    Date.parse(right.status.updatedAt) - Date.parse(left.status.updatedAt) ||
    left.id.localeCompare(right.id)
  );
}

function displayReason(
  harnessRun: HarnessRunObservation | undefined,
  includeReason: boolean,
): string | undefined {
  if (harnessRun === undefined) {
    return "No harness run is associated with this worktree.";
  }
  if (includeReason) {
    return harnessRun.status.reason;
  }
  return undefined;
}

function warningFor(
  harnessRun: HarnessRunObservation | undefined,
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
    provider: input.worktreeProviderId,
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
        id: providerHealthAlertId(health.provider, health.status),
        severity: health.status === "unavailable" ? "error" : "warn",
        message:
          health.lastError?.message ??
          `The ${health.providerType} provider ${health.provider} is ${health.status}.`,
        provider: health.provider,
        createdAt: generatedAt,
      };
      if (health.lastError?.code !== undefined) {
        alert.code = health.lastError.code;
      }
      return alert;
    });
}

function providerHealthAlertId(providerId: string, status: ProviderHealth["status"]): string {
  return `alert_${providerId}_${status}`;
}

function orphans(
  input: ObserverGraphInput,
  harnessRuns: HarnessRunObservation[],
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
    const run = harnessRun;
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
    provider: input.providerId,
    providerType: input.providerType,
    status: "unavailable",
    lastCheckedAt: input.lastCheckedAt,
    lastError: input.lastError,
  };
  if (input.latencyMs !== undefined) health.latencyMs = input.latencyMs;
  if (input.capabilities !== undefined) health.capabilities = input.capabilities;
  return health;
}
