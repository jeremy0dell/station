import type { WorktreeId, WorktreeRow } from "@station/contracts";
import { type TuiState, worktreeRowDisplayTitle } from "@station/dashboard-core";

// Flat scalars so the memoized useSyncExternalStore snapshot can compare fields
// (a fresh object each read would loop the subscription).
export type StationButtonStatus = {
  attention: boolean;
  workingCount: number;
  idleCount: number;
  sessionName?: string;
  /** The worktree behind the attention state, so a click can focus its pane. */
  attentionWorktreeId?: WorktreeId;
};

const EMPTY_STATUS: StationButtonStatus = {
  attention: false,
  workingCount: 0,
  idleCount: 0,
};

function needsUser(row: WorktreeRow): boolean {
  return row.display.statusLabel === "needs attention" || row.display.statusLabel === "stuck";
}

// Totals come from the snapshot's pre-aggregated counts; the attention identity
// is the first row asking for the user (rows are already in display order).
export function selectStationButtonStatus(state: TuiState): StationButtonStatus {
  const snapshot = state.snapshot;
  if (snapshot === undefined) {
    return EMPTY_STATUS;
  }
  // Derive from the flagged row (needs-attention OR stuck), not snapshot.counts.attention: that
  // count excludes stuck, which would leave a stuck session showing no alert.
  const attentionRow = snapshot.rows.find(needsUser);
  const status: StationButtonStatus = {
    attention: attentionRow !== undefined,
    workingCount: snapshot.counts.working,
    idleCount: snapshot.counts.idle,
  };
  if (attentionRow !== undefined) {
    status.sessionName = worktreeRowDisplayTitle(attentionRow, snapshot.sessions, state.localRows);
    status.attentionWorktreeId = attentionRow.id;
  }
  return status;
}

/** Field-wise equality so the memoized snapshot keeps a stable reference. */
export function stationButtonStatusEqual(a: StationButtonStatus, b: StationButtonStatus): boolean {
  return (
    a.attention === b.attention &&
    a.workingCount === b.workingCount &&
    a.idleCount === b.idleCount &&
    a.sessionName === b.sessionName &&
    a.attentionWorktreeId === b.attentionWorktreeId
  );
}
