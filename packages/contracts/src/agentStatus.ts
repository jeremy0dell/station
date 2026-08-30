import { z } from "zod";
import type { AgentState } from "./observations.js";
import type { WorktreeRow } from "./snapshot.js";

export const AgentStatusLabelSchema = z.enum([
  "no agent",
  "starting",
  "idle",
  "working",
  "needs attention",
  "stuck",
  "exited",
  "unknown",
]);

export type AgentStatusLabel = z.infer<typeof AgentStatusLabelSchema>;

export type AgentStatusDefinition = {
  label: AgentStatusLabel;
  priority: number;
  alert: boolean;
  warning: boolean;
};

/**
 * POLICY
 *
 * Owns canonical agent display semantics; readiness and view rollups remain consumer-derived.
 */
export const AGENT_STATUS = {
  needs_attention: { label: "needs attention", priority: 10, alert: true, warning: false },
  stuck: { label: "stuck", priority: 20, alert: true, warning: true },
  working: { label: "working", priority: 30, alert: false, warning: false },
  starting: { label: "starting", priority: 35, alert: false, warning: false },
  idle: { label: "idle", priority: 40, alert: false, warning: false },
  unknown: { label: "unknown", priority: 50, alert: false, warning: false },
  exited: { label: "exited", priority: 60, alert: false, warning: false },
  none: { label: "no agent", priority: 70, alert: false, warning: false },
} as const satisfies Record<AgentState, AgentStatusDefinition>;

/** Projects canonical agent display semantics while leaving readiness and view rollups derived. */
export function worktreeDisplayForAgentState(
  state: AgentState | undefined,
): WorktreeRow["display"] {
  const definition = AGENT_STATUS[state ?? "none"];
  const display: WorktreeRow["display"] = {
    statusLabel: definition.label,
    sortPriority: definition.priority,
    alert: definition.alert,
  };
  if (definition.warning) display.warning = true;
  return display;
}
