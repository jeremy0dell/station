import type { SessionId } from "@station/contracts";
import { pendingRenameTitles } from "../state/localRows.js";
import type { DashboardSnapshotView, DashboardViewState } from "../state/types.js";

type DashboardWorktreeRowView = DashboardSnapshotView["rows"][number];
type DashboardSessionView = DashboardSnapshotView["sessions"][number];
type DashboardLocalRowsView = DashboardViewState["localRows"];
type Mutable<T> = { -readonly [TKey in keyof T]: T[TKey] };

export type DashboardSessionRow = {
  /** Dashboard identity is the canonical session id, never the checkout id. */
  id: SessionId;
  session: DashboardSessionView;
  worktree: DashboardWorktreeRowView;
  presentation: DashboardWorktreeRowView;
};

export type SelectProjectGroupsOptions = {
  /** Includes canonical children while preserving the stored collapsed marker. */
  includeCollapsedRows?: boolean;
};

export function selectProjectGroups(
  snapshot: DashboardSnapshotView,
  state: DashboardViewState,
  options: SelectProjectGroupsOptions = {},
) {
  const sessionRows = selectDashboardSessionRows(snapshot);
  return snapshot.projects.map((project) => {
    const collapsed = state.collapsedProjectIds.has(project.id);
    const matchingRows = sessionRows
      .filter((row) => row.worktree.projectId === project.id)
      .sort((left, right) => compareRows(left, right, state.localRows));
    return {
      project,
      rows: collapsed && options.includeCollapsedRows !== true ? [] : matchingRows,
      collapsed,
    };
  });
}

export function selectDashboardSessionRows(snapshot: DashboardSnapshotView): DashboardSessionRow[] {
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
  snapshot: DashboardSnapshotView,
  sessionId: SessionId,
): DashboardSessionRow | undefined {
  return selectDashboardSessionRows(snapshot).find((row) => row.id === sessionId);
}

export function sessionForWorktreeRow(
  row: DashboardWorktreeRowView,
  sessions: readonly DashboardSessionView[],
): DashboardSessionView | undefined {
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
  localRows: DashboardLocalRowsView,
): string {
  return pendingRenameTitles(localRows)[row.session.id]?.title ?? row.worktree.title;
}

function compareRows(
  left: DashboardSessionRow,
  right: DashboardSessionRow,
  localRows: DashboardLocalRowsView,
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

function dashboardSessionRow(
  session: DashboardSessionView,
  source: DashboardWorktreeRowView,
): DashboardSessionRow {
  return {
    id: session.id,
    session,
    worktree: source,
    presentation: sessionPresentation(session, source),
  };
}

function sessionPresentation(
  session: DashboardSessionView,
  source: DashboardWorktreeRowView,
): DashboardWorktreeRowView {
  const row: Mutable<DashboardWorktreeRowView> = {
    ...source,
    display: sessionDisplay(session),
  };
  row.agent = sessionAgent(session, source);
  if (session.terminal === undefined) {
    delete row.terminal;
  } else {
    row.terminal = session.terminal;
  }
  if (session.origin === "external") {
    delete row.recovery;
  }
  return row;
}

function sessionAgent(
  session: DashboardSessionView,
  source: DashboardWorktreeRowView,
): NonNullable<DashboardWorktreeRowView["agent"]> {
  const agent: Mutable<NonNullable<DashboardWorktreeRowView["agent"]>> = {
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

function sourceAgentMatchesSession(
  source: DashboardWorktreeRowView,
  session: DashboardSessionView,
): boolean {
  if (session.origin === "station") {
    return source.agent?.sessionId === session.id;
  }
  return session.harness.runId !== undefined && source.agent?.runId === session.harness.runId;
}

function sessionDisplay(session: DashboardSessionView): DashboardWorktreeRowView["display"] {
  const value = session.status.value;
  const display: Mutable<DashboardWorktreeRowView["display"]> = {
    statusLabel: sessionStatusLabel(value),
    sortPriority: sessionStatusPriority(value),
    alert: value === "needs_attention" || value === "stuck",
    reason: session.status.reason,
  };
  if (value === "stuck") display.warning = true;
  return display;
}

function sessionStatusLabel(
  value: DashboardSessionView["status"]["value"],
): DashboardWorktreeRowView["display"]["statusLabel"] {
  if (value === "needs_attention") return "needs attention";
  if (value === "none") return "no agent";
  return value;
}

function sessionStatusPriority(value: DashboardSessionView["status"]["value"]): number {
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
