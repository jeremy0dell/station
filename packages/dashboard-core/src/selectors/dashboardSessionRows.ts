import type { SessionId, SessionView, StationSnapshot, WorktreeRow } from "@station/contracts";
import { pendingRenameTitles, type TuiLocalRows } from "../state/localRows.js";
import type { TuiViewState } from "../state/types.js";
import { matchesDashboardSessionSearch } from "./dashboardSearchProjection.js";

export type DashboardSessionRow = {
  /** Dashboard identity is the canonical session id, never the checkout id. */
  id: SessionId;
  session: SessionView;
  worktree: WorktreeRow;
  presentation: WorktreeRow;
};

export type SelectProjectGroupsOptions = {
  /** Includes canonical children while preserving the stored collapsed marker. */
  includeCollapsedRows?: boolean;
  /** Defaults to the legacy dashboard search projection. */
  applySearch?: boolean;
};

export function selectProjectGroups(
  snapshot: StationSnapshot,
  state: TuiViewState,
  options: SelectProjectGroupsOptions = {},
) {
  const sessionRows = selectDashboardSessionRows(snapshot);
  return snapshot.projects.map((project) => {
    const collapsed = state.collapsedProjectIds.has(project.id);
    const matchingRows = sessionRows
      .filter((row) => row.worktree.projectId === project.id)
      .filter(
        (row) =>
          options.applySearch === false ||
          matchesDashboardSessionSearch(
            {
              displayTitle: sessionRowDisplayTitle(row, state.localRows),
              branch: row.worktree.branch,
              projectLabel: project.label,
              statusValue: row.session.status.value,
              statusReason: row.session.status.reason,
              harnessProvider: row.session.harness.provider,
              terminalProvider: row.session.terminal?.provider,
            },
            state.searchQuery,
          ),
      )
      .sort((left, right) => compareRows(left, right, state.localRows));
    return {
      project,
      rows: collapsed && options.includeCollapsedRows !== true ? [] : matchingRows,
      collapsed,
    };
  });
}

export function selectDashboardSessionRows(snapshot: StationSnapshot): DashboardSessionRow[] {
  const worktreesById = new Map(snapshot.rows.map((row) => [row.id, row]));
  return snapshot.sessions.flatMap((session) => {
    const source = worktreesById.get(session.worktreeId);
    if (source === undefined || source.projectId !== session.projectId) {
      return [];
    }
    return [dashboardSessionRow(session, source)];
  });
}

export function selectDashboardSessionRow(
  snapshot: StationSnapshot,
  sessionId: SessionId,
): DashboardSessionRow | undefined {
  return selectDashboardSessionRows(snapshot).find((row) => row.id === sessionId);
}

export function sessionForWorktreeRow(
  row: WorktreeRow,
  sessions: readonly SessionView[],
): SessionView | undefined {
  const sessionId = row.agent?.sessionId;
  if (sessionId !== undefined) {
    const direct = sessions.find(
      (session) => session.origin === "station" && session.id === sessionId,
    );
    if (direct !== undefined) {
      return direct;
    }
  }
  const runId = row.agent?.runId;
  if (runId !== undefined) {
    const external = sessions.find(
      (session) => session.origin === "external" && session.harness.runId === runId,
    );
    if (external !== undefined) return external;
  }
  return sessions.find((session) => session.worktreeId === row.id);
}

export function sessionRowDisplayTitle(
  row: Pick<DashboardSessionRow, "session" | "worktree">,
  localRows: TuiLocalRows,
): string {
  return pendingRenameTitles(localRows)[row.session.id]?.title ?? row.worktree.title;
}

function compareRows(
  left: DashboardSessionRow,
  right: DashboardSessionRow,
  localRows: TuiLocalRows,
): number {
  return (
    sessionRowDisplayTitle(left, localRows).localeCompare(
      sessionRowDisplayTitle(right, localRows),
    ) ||
    left.worktree.branch.localeCompare(right.worktree.branch) ||
    left.worktree.path.localeCompare(right.worktree.path) ||
    left.id.localeCompare(right.id)
  );
}

function dashboardSessionRow(session: SessionView, source: WorktreeRow): DashboardSessionRow {
  return {
    id: session.id,
    session,
    worktree: source,
    presentation: sessionPresentation(session, source),
  };
}

function sessionPresentation(session: SessionView, source: WorktreeRow): WorktreeRow {
  const {
    terminal: _sourceTerminal,
    recovery: sourceRecovery,
    ...sourceWithoutRuntimeState
  } = source;
  const row: WorktreeRow = {
    ...sourceWithoutRuntimeState,
    display: sessionDisplay(session),
    agent: sessionAgent(session, source),
  };
  if (session.terminal !== undefined) {
    row.terminal = session.terminal;
  }
  if (session.origin !== "external" && sourceRecovery !== undefined) {
    row.recovery = sourceRecovery;
  }
  return row;
}

function sessionAgent(
  session: SessionView,
  source: WorktreeRow,
): NonNullable<WorktreeRow["agent"]> {
  const agent: NonNullable<WorktreeRow["agent"]> = {
    harness: session.harness.provider,
    state: session.status.value,
    confidence: session.status.confidence,
    reason: session.status.reason,
    updatedAt: session.status.updatedAt,
  };
  if (session.harness.pid !== undefined) agent.pid = session.harness.pid;
  if (session.harness.runId !== undefined) agent.runId = session.harness.runId;
  if (session.origin === "station") agent.sessionId = session.id;
  if (session.status.attention !== undefined) agent.attention = session.status.attention;
  if (sourceAgentMatchesSession(source, session) && source.agent?.turnReadiness !== undefined) {
    agent.turnReadiness = source.agent.turnReadiness;
  }
  return agent;
}

function sourceAgentMatchesSession(source: WorktreeRow, session: SessionView): boolean {
  if (session.origin === "station") {
    return source.agent?.sessionId === session.id;
  }
  return session.harness.runId !== undefined && source.agent?.runId === session.harness.runId;
}

function sessionDisplay(session: SessionView): WorktreeRow["display"] {
  const value = session.status.value;
  const display: WorktreeRow["display"] = {
    statusLabel: sessionStatusLabel(value),
    sortPriority: sessionStatusPriority(value),
    alert: value === "needs_attention" || value === "stuck",
    reason: session.status.reason,
  };
  if (value === "stuck") display.warning = true;
  return display;
}

function sessionStatusLabel(
  value: SessionView["status"]["value"],
): WorktreeRow["display"]["statusLabel"] {
  if (value === "needs_attention") return "needs attention";
  if (value === "none") return "no agent";
  return value;
}

function sessionStatusPriority(value: SessionView["status"]["value"]): number {
  switch (value) {
    case "needs_attention":
      return 10;
    case "stuck":
      return 20;
    case "working":
      return 30;
    case "starting":
      return 35;
    case "idle":
      return 40;
    case "unknown":
      return 50;
    case "exited":
      return 60;
    case "none":
      return 70;
    default:
      return assertNever(value);
  }
}

function assertNever(_value: never): never {
  throw new Error("Unhandled session status.");
}
