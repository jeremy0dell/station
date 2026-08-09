import type { SessionId, StationSnapshot, WorktreeId } from "@station/contracts";
import {
  isReadyToRead,
  selectDashboardSessionRows,
  selectFleetSummary,
  sessionRowDisplayTitle,
 } from "@station/dashboard-core/selectors";
import type { DashboardSessionRow } from "@station/dashboard-core/selectors";
import type { DashboardStateView } from "@station/dashboard-core/state";
import { STATION_STATUS_UI, type ProjectRollupStatus } from "../station/statusUi.js";
import { attentionKey } from "../state/attentionDismissal.js";

export type { ProjectRollupStatus } from "../station/statusUi.js";

export type ProjectRollupEntry = {
  projectId: string;
  name: string;
  status: ProjectRollupStatus;
};

// Flat scalars so the memoized useSyncExternalStore snapshot can compare fields
// (a fresh object each read would loop the subscription).
export type StationButtonStatus = {
  attention: boolean;
  /** Sessions asking for the user (needs-attention OR stuck) — the queue depth. */
  needsYouCount: number;
  workingCount: number;
  readyCount: number;
  /** Disjoint from ready; the totals summary shows ready + idle as "idle". */
  idleCount: number;
  sessionName?: string;
  /** The canonical session behind the attention state. */
  attentionSessionId?: SessionId;
  /** The worktree behind the attention state, so a click can focus its pane. */
  attentionWorktreeId?: WorktreeId;
  /** Worst status per project, in row display order; built only when requested. */
  projectRollup?: readonly ProjectRollupEntry[];
};

const EMPTY_STATUS: StationButtonStatus = {
  attention: false,
  needsYouCount: 0,
  workingCount: 0,
  readyCount: 0,
  idleCount: 0,
};

/** The row is asking for the user (needs-attention or stuck) — the island's alert predicate. */
export function rowNeedsUser(row: DashboardSessionRow["presentation"]): boolean {
  return row.display.alert;
}

/** The attention keys of every session currently asking for the user. */
export function attentionKeysFromSnapshot(
  snapshot: DashboardStateView["snapshot"],
): readonly string[] {
  if (snapshot === undefined) {
    return [];
  }
  return selectDashboardSessionRows(snapshot)
    .filter((row) => rowNeedsUser(row.presentation))
    .map((row) => attentionKey(row.session.id, row.worktree.id));
}

// Counts come from the client-side fleet breakdown, not snapshot.counts: the
// contract folds ready into idle and its attention count excludes stuck.
export function selectStationButtonStatus(
  snapshot: StationSnapshot | undefined,
  localRows: DashboardStateView["localRows"],
  options?: { projectRollup?: boolean },
): StationButtonStatus {
  if (snapshot === undefined) {
    return EMPTY_STATUS;
  }
  const fleet = selectFleetSummary(snapshot);
  const sessionRows = selectDashboardSessionRows(snapshot);
  const attentionRow = sessionRows.find((row) => rowNeedsUser(row.presentation));
  const status: StationButtonStatus = {
    attention: attentionRow !== undefined,
    needsYouCount: fleet.needsYou,
    workingCount: fleet.working,
    readyCount: fleet.ready,
    idleCount: fleet.idle,
  };
  if (attentionRow !== undefined) {
    status.sessionName = sessionRowDisplayTitle(attentionRow, localRows);
    status.attentionSessionId = attentionRow.session.id;
    status.attentionWorktreeId = attentionRow.worktree.id;
  }
  if (options?.projectRollup === true) {
    status.projectRollup = rollupProjects(sessionRows);
  }
  return status;
}

function rowRollupStatus(row: DashboardSessionRow): ProjectRollupStatus {
  const state = row.session.status.value;
  if (row.presentation.display.alert) {
    return "needsYou";
  }
  if (state === "working") {
    return "working";
  }
  if (isReadyToRead(row.presentation)) {
    return "ready";
  }
  // Calm lanes (idle/starting/exited/unknown/no agent) all read as idle here;
  // the island roll-up is a triage summary, not a full state readout.
  return "idle";
}

function rollupProjects(rows: readonly DashboardSessionRow[]): readonly ProjectRollupEntry[] {
  const byProject = new Map<string, ProjectRollupEntry>();
  for (const row of rows) {
    const status = rowRollupStatus(row);
    const existing = byProject.get(row.worktree.projectId);
    if (existing === undefined) {
      byProject.set(row.worktree.projectId, {
        projectId: row.worktree.projectId,
        name: row.worktree.projectLabel,
        status,
      });
    } else if (
      STATION_STATUS_UI[status].projectPriority >
      STATION_STATUS_UI[existing.status].projectPriority
    ) {
      existing.status = status;
    }
  }
  return [...byProject.values()];
}

/** Field-wise equality so the memoized snapshot keeps a stable reference. */
export function stationButtonStatusEqual(a: StationButtonStatus, b: StationButtonStatus): boolean {
  return (
    a.attention === b.attention &&
    a.needsYouCount === b.needsYouCount &&
    a.workingCount === b.workingCount &&
    a.readyCount === b.readyCount &&
    a.idleCount === b.idleCount &&
    a.sessionName === b.sessionName &&
    a.attentionSessionId === b.attentionSessionId &&
    a.attentionWorktreeId === b.attentionWorktreeId &&
    rollupEqual(a.projectRollup, b.projectRollup)
  );
}

function rollupEqual(
  a: readonly ProjectRollupEntry[] | undefined,
  b: readonly ProjectRollupEntry[] | undefined,
): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return (
    a.length === b.length &&
    a.every((entry, i) => {
      const other = b[i];
      return (
        other !== undefined &&
        entry.projectId === other.projectId &&
        entry.name === other.name &&
        entry.status === other.status
      );
    })
  );
}
