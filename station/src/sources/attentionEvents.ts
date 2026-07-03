import type { StationEvent } from "@station/contracts";

type AgentStateChangedEvent = Extract<StationEvent, { type: "worktree.agentStateChanged" }>;
export type StationAttentionEvent = AgentStateChangedEvent & {
  agent: NonNullable<AgentStateChangedEvent["agent"]>;
};

// Some harness error states (cursor turn error, opencode session error) reach
// needs_attention with no typed attention kind; they must still alert.
export function isNeedsAttentionEvent(event: StationEvent): event is StationAttentionEvent {
  return event.type === "worktree.agentStateChanged" && event.agent?.state === "needs_attention";
}
