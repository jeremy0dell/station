import type { AgentState, ProjectView, SessionView, WorktreeRow } from "@station/contracts";

export const statusPolicy: Record<
  AgentState | "no_agent",
  {
    label: WorktreeRow["display"]["statusLabel"];
    priority: number;
    alert: boolean;
    warning: boolean;
  }
> = {
  needs_attention: {
    label: "needs attention",
    priority: 10,
    alert: true,
    warning: false,
  },
  stuck: {
    label: "stuck",
    priority: 20,
    alert: true,
    warning: true,
  },
  working: {
    label: "working",
    priority: 30,
    alert: false,
    warning: false,
  },
  starting: {
    label: "starting",
    priority: 35,
    alert: false,
    warning: false,
  },
  idle: {
    label: "idle",
    priority: 40,
    alert: false,
    warning: false,
  },
  unknown: {
    label: "unknown",
    priority: 50,
    alert: false,
    warning: false,
  },
  exited: {
    label: "exited",
    priority: 60,
    alert: false,
    warning: false,
  },
  none: {
    label: "no agent",
    priority: 70,
    alert: false,
    warning: false,
  },
  no_agent: {
    label: "no agent",
    priority: 70,
    alert: false,
    warning: false,
  },
};

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
