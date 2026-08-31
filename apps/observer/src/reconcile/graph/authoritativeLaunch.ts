import type {
  HarnessCapabilities,
  ProviderId,
  ProviderProjectConfig,
  SessionGroupView,
  SessionView,
  StationSnapshot,
  TerminalAttachment,
  TerminalTargetObservation,
  WorktreeObservation,
  WorktreeRow,
} from "@station/contracts";
import { terminalBoundHarnessRunObservation } from "@station/contracts";
import { projectSessionGroups } from "../sessionGroups.js";
import { countsForSnapshot } from "../snapshotCounts.js";
import type { ObserverSessionMetadata } from "./evidence.js";
import { buildStationSession } from "./sessions.js";
import { buildWorktreeRow, compareRows } from "./worktreeRows.js";

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
