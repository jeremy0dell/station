import type {
  HarnessEventReport,
  ObservedStatus,
  ProjectView,
  SessionView,
  StationEvent,
  StationSnapshot,
  WorktreeRow,
} from "@station/contracts";
import { pathIsSameOrInside } from "@station/runtime";
import { countsForRows, statusPolicy } from "./statusPolicy.js";

type WorktreeAgent = NonNullable<WorktreeRow["agent"]>;
type CorrelatedBy = "harnessRunId" | "sessionId" | "worktreeId";

export type StatusProjectionResult = {
  projected: boolean;
  snapshot: StationSnapshot;
  events: StationEvent[];
  worktreeId?: string;
  sessionId?: string;
  correlatedBy?: CorrelatedBy;
};

type ProjectionTarget = {
  rowIndex: number;
  correlatedBy: CorrelatedBy;
};

/**
 * Resolve a cwd-only correlation into a worktreeId at the ingress boundary.
 * cwd is the weakest identity (dropped when ambiguous); resolving it here once
 * means live projection AND the persisted observation both correlate by the
 * contract field, so the status survives reconcile overlays. Stronger
 * correlation fields, when present, are left untouched.
 */
export function withWorktreeCorrelationFromCwd(
  report: HarnessEventReport,
  snapshot: StationSnapshot,
): HarnessEventReport {
  const correlation = report.correlation;
  if (
    correlation?.cwd === undefined ||
    correlation.harnessRunId !== undefined ||
    correlation.sessionId !== undefined ||
    correlation.worktreeId !== undefined
  ) {
    return report;
  }
  const worktreeId = rowIdForCwd(snapshot.rows, correlation.cwd);
  if (worktreeId === undefined) {
    return report;
  }
  return { ...report, correlation: { ...correlation, worktreeId } };
}

// Deepest containing worktree wins; a tie at the same depth is ambiguous and
// resolves to nothing (mirrors resolveWorktreeByProjectPath in run.ts).
function rowIdForCwd(rows: readonly WorktreeRow[], cwd: string): string | undefined {
  const matches = rows
    .filter((row) => pathIsSameOrInside(cwd, row.path))
    .sort(
      (left, right) =>
        right.path.length - left.path.length ||
        left.id.localeCompare(right.id) ||
        left.path.localeCompare(right.path),
    );
  const match = matches[0];
  if (match === undefined) {
    return undefined;
  }
  const next = matches[1];
  if (next !== undefined && next.path.length === match.path.length) {
    return undefined;
  }
  return match.id;
}

export function projectHarnessEventReportOntoSnapshot(input: {
  snapshot: StationSnapshot;
  report: HarnessEventReport;
  projectedAt: string;
}): StatusProjectionResult {
  const status = input.report.status;
  if (status === undefined || status.value === "unknown") {
    return unprojected(input.snapshot);
  }

  const target = findProjectionTarget(input.snapshot, input.report);
  if (target === undefined) {
    return unprojected(input.snapshot);
  }

  const currentRow = input.snapshot.rows[target.rowIndex];
  const currentAgent = currentRow?.agent;
  if (currentRow === undefined || currentAgent === undefined) {
    return unprojected(input.snapshot);
  }
  if (shouldPreserveCurrentAgent(currentAgent, status)) {
    return unprojected(input.snapshot);
  }

  const nextAgent = projectAgent(currentAgent, status);
  const nextRow = projectRow(currentRow, nextAgent, status);
  const agentStateValueChanged = currentAgent.state !== nextAgent.state;
  const rowChanged = !agentsEqual(currentAgent, nextAgent) || !displayEqual(currentRow, nextRow);
  const sessionProjection = projectSession(input.snapshot.sessions, nextAgent, status);
  const snapshotChanged = rowChanged || sessionProjection.changed;
  if (!snapshotChanged) {
    return unprojected(input.snapshot);
  }

  const rows = input.snapshot.rows.map((row, index) => (index === target.rowIndex ? nextRow : row));
  const sortedRows = sortRows(rows, input.snapshot.projects);
  const snapshot = rebuildSnapshot({
    snapshot: input.snapshot,
    rows: sortedRows,
    sessions: sessionProjection.sessions,
    generatedAt: input.projectedAt,
  });

  const events: StationEvent[] = [];
  if (agentStateValueChanged) {
    const event: StationEvent = {
      type: "worktree.agentStateChanged",
      worktreeId: nextRow.id,
      agent: nextAgent,
      changeSource: "harness_event_report",
      harnessEventType: input.report.eventType,
      reportId: input.report.reportId,
    };
    const sessionTitle = sessionTitleForAgent(sessionProjection.sessions, nextAgent);
    if (sessionTitle !== undefined) {
      event.sessionTitle = sessionTitle;
    }
    events.push(event);
  }
  if (sessionProjection.event !== undefined) {
    events.push(sessionProjection.event);
  }

  const result: StatusProjectionResult = {
    projected: true,
    snapshot,
    events,
    worktreeId: nextRow.id,
    correlatedBy: target.correlatedBy,
  };
  if (sessionProjection.sessionId !== undefined) {
    result.sessionId = sessionProjection.sessionId;
  }
  return result;
}

function sessionTitleForAgent(
  sessions: readonly SessionView[],
  agent: WorktreeAgent,
): string | undefined {
  if (agent.sessionId === undefined) {
    return undefined;
  }
  return sessions.find((session) => session.id === agent.sessionId)?.title;
}

function unprojected(snapshot: StationSnapshot): StatusProjectionResult {
  return {
    projected: false,
    snapshot,
    events: [],
  };
}

function findProjectionTarget(
  snapshot: StationSnapshot,
  report: HarnessEventReport,
): ProjectionTarget | undefined {
  const rows = snapshot.rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.agent?.harness === report.provider);

  if (report.correlation?.harnessRunId !== undefined) {
    return singleTarget(
      rows.filter(({ row }) => row.agent?.runId === report.correlation?.harnessRunId),
      "harnessRunId",
    );
  }

  if (report.correlation?.sessionId !== undefined) {
    return singleTarget(
      rows.filter(({ row }) => row.agent?.sessionId === report.correlation?.sessionId),
      "sessionId",
    );
  }

  if (report.correlation?.worktreeId !== undefined) {
    return singleTarget(
      rows.filter(
        ({ row }) => row.id === report.correlation?.worktreeId && row.agent !== undefined,
      ),
      "worktreeId",
    );
  }

  return undefined;
}

function singleTarget(
  matches: Array<{ row: WorktreeRow; index: number }>,
  correlatedBy: CorrelatedBy,
): ProjectionTarget | undefined {
  const match = matches[0];
  if (matches.length !== 1 || match === undefined) {
    return undefined;
  }
  return {
    rowIndex: match.index,
    correlatedBy,
  };
}

function shouldPreserveCurrentAgent(agent: WorktreeAgent, status: ObservedStatus): boolean {
  if (agent.state !== "exited" || agent.confidence !== "high") {
    return false;
  }
  return Date.parse(status.updatedAt) < Date.parse(agent.updatedAt);
}

function projectAgent(agent: WorktreeAgent, status: ObservedStatus): WorktreeAgent {
  const nextAgent: WorktreeAgent = {
    harness: agent.harness,
    state: status.value,
    confidence: status.confidence,
    reason: status.reason,
    updatedAt: status.updatedAt,
  };
  if (status.attention !== undefined) nextAgent.attention = status.attention;
  if (agent.pid !== undefined) nextAgent.pid = agent.pid;
  if (agent.runId !== undefined) nextAgent.runId = agent.runId;
  if (agent.sessionId !== undefined) nextAgent.sessionId = agent.sessionId;
  if (status.value === "idle" && agent.turnReadiness !== undefined) {
    nextAgent.turnReadiness = agent.turnReadiness;
  }
  return nextAgent;
}

function projectRow(row: WorktreeRow, agent: WorktreeAgent, status: ObservedStatus): WorktreeRow {
  const nextRow: WorktreeRow = {
    id: row.id,
    projectId: row.projectId,
    projectLabel: row.projectLabel,
    branch: row.branch,
    path: row.path,
    worktree: row.worktree,
    display: displayForStatus(status),
    agent,
  };
  if (row.terminal !== undefined) nextRow.terminal = row.terminal;
  return nextRow;
}

function displayForStatus(status: ObservedStatus): WorktreeRow["display"] {
  const policy = statusPolicy[status.value];
  const display: WorktreeRow["display"] = {
    statusLabel: policy.label,
    sortPriority: policy.priority,
    alert: policy.alert,
  };
  if (policy.warning) {
    display.warning = true;
  }
  if (status.value === "needs_attention" || status.value === "stuck" || policy.warning) {
    display.reason = status.reason;
  }
  return display;
}

function projectSession(
  sessions: readonly SessionView[],
  agent: WorktreeAgent,
  status: ObservedStatus,
): {
  sessions: SessionView[];
  changed: boolean;
  event?: StationEvent;
  sessionId?: string;
} {
  const sessionId = agent.sessionId;
  if (sessionId === undefined) {
    return {
      sessions: [...sessions],
      changed: false,
    };
  }

  let changed = false;
  let event: StationEvent | undefined;
  const nextSessions = sessions.map((session) => {
    if (session.id !== sessionId) {
      return session;
    }
    const nextSession: SessionView = {
      ...session,
      updatedAt: status.updatedAt,
      status: {
        value: status.value,
        confidence: status.confidence,
        reason: status.reason,
        source: status.source,
        updatedAt: status.updatedAt,
        ...(status.attention === undefined ? {} : { attention: status.attention }),
      },
    };
    changed = !sessionStatusEqual(session, nextSession);
    if (changed) {
      event = {
        type: "session.updated",
        sessionId,
        patch: {
          updatedAt: nextSession.updatedAt,
          status: nextSession.status,
        },
      };
    }
    return nextSession;
  });

  return {
    sessions: nextSessions,
    changed,
    ...(event === undefined ? {} : { event }),
    sessionId,
  };
}

function rebuildSnapshot(input: {
  snapshot: StationSnapshot;
  rows: WorktreeRow[];
  sessions: SessionView[];
  generatedAt: string;
}): StationSnapshot {
  const projects = input.snapshot.projects.map((project) => {
    const nextProject: ProjectView = {
      ...project,
      counts: countsForRows(input.rows.filter((row) => row.projectId === project.id)),
    };
    return nextProject;
  });
  return {
    ...input.snapshot,
    generatedAt: input.generatedAt,
    projects,
    rows: input.rows,
    sessions: input.sessions,
    counts: {
      projects: projects.length,
      ...countsForRows(input.rows),
    },
  };
}

function sortRows(rows: WorktreeRow[], projects: readonly ProjectView[]): WorktreeRow[] {
  const projectOrder = new Map(projects.map((project, index) => [project.id, index]));
  return [...rows].sort(
    (left, right) =>
      (projectOrder.get(left.projectId) ?? Number.MAX_SAFE_INTEGER) -
        (projectOrder.get(right.projectId) ?? Number.MAX_SAFE_INTEGER) ||
      left.display.sortPriority - right.display.sortPriority ||
      left.branch.localeCompare(right.branch) ||
      left.id.localeCompare(right.id),
  );
}

function agentsEqual(left: WorktreeAgent, right: WorktreeAgent): boolean {
  return (
    left.harness === right.harness &&
    left.state === right.state &&
    left.pid === right.pid &&
    left.runId === right.runId &&
    left.sessionId === right.sessionId &&
    left.confidence === right.confidence &&
    left.reason === right.reason &&
    left.updatedAt === right.updatedAt &&
    left.attention === right.attention &&
    readinessEqual(left.turnReadiness, right.turnReadiness)
  );
}

function readinessEqual(
  left: WorktreeAgent["turnReadiness"],
  right: WorktreeAgent["turnReadiness"],
): boolean {
  return (
    left?.state === right?.state &&
    left?.token === right?.token &&
    left?.completedAt === right?.completedAt
  );
}

function displayEqual(left: WorktreeRow, right: WorktreeRow): boolean {
  return (
    left.display.statusLabel === right.display.statusLabel &&
    left.display.sortPriority === right.display.sortPriority &&
    left.display.alert === right.display.alert &&
    left.display.warning === right.display.warning &&
    left.display.reason === right.display.reason
  );
}

function sessionStatusEqual(left: SessionView, right: SessionView): boolean {
  return (
    left.updatedAt === right.updatedAt &&
    left.status.value === right.status.value &&
    left.status.attention === right.status.attention &&
    left.status.confidence === right.status.confidence &&
    left.status.reason === right.status.reason &&
    left.status.source === right.status.source &&
    left.status.updatedAt === right.status.updatedAt
  );
}
