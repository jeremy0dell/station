import type { StationEvent } from "@station/contracts";

type AgentStateChangedEvent = Extract<StationEvent, { type: "worktree.agentStateChanged" }>;
export type StationAttentionEvent = AgentStateChangedEvent & {
  agent: NonNullable<AgentStateChangedEvent["agent"]>;
};

export function isUserInputRequestAttentionEvent(
  event: StationEvent,
): event is StationAttentionEvent {
  return (
    event.type === "worktree.agentStateChanged" &&
    event.agent?.state === "needs_attention" &&
    event.agent.attention !== undefined
  );
}
