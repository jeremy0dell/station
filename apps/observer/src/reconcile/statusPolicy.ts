import type { AgentState, ProjectView, WorktreeRow } from "@station/contracts";

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

export function countsForRows(rows: readonly WorktreeRow[]): ProjectView["counts"] {
  return rows.reduce(
    (counts, row) => {
      counts.worktrees += 1;
      if (row.agent !== undefined) {
        counts.agents += 1;
        if (row.agent.state === "working") counts.working += 1;
        if (row.agent.state === "idle") counts.idle += 1;
        if (row.agent.state === "needs_attention") counts.attention += 1;
        if (row.agent.state === "unknown") counts.unknown += 1;
      }
      return counts;
    },
    {
      worktrees: 0,
      agents: 0,
      working: 0,
      idle: 0,
      attention: 0,
      unknown: 0,
    },
  );
}
