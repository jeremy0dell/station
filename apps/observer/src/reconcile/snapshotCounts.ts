import type { ProjectView, SessionView, WorktreeRow } from "@station/contracts";

/**
 * POLICY
 *
 * Derives session and activity totals from canonical sessions while retaining worktree inventory.
 */
export function countsForSnapshot(
  rows: readonly WorktreeRow[],
  sessions: readonly SessionView[],
): ProjectView["counts"] {
  return sessions.reduce(
    (counts, session) => {
      counts.sessions += 1;
      if (session.status.value !== "none") {
        counts.agents += 1;
        if (session.status.value === "working") counts.working += 1;
        if (session.status.value === "idle") counts.idle += 1;
        if (session.status.value === "needs_attention") counts.attention += 1;
        if (session.status.value === "unknown") counts.unknown += 1;
      }
      return counts;
    },
    {
      sessions: 0,
      worktrees: rows.length,
      agents: 0,
      working: 0,
      idle: 0,
      attention: 0,
      unknown: 0,
    },
  );
}
