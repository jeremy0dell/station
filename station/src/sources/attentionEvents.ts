import { AGENT_STATUS, type StationEvent } from "@station/contracts";

type AgentStateChangedEvent = Extract<StationEvent, { type: "worktree.agentStateChanged" }>;
export type StationAttentionEvent = AgentStateChangedEvent & {
  agent: NonNullable<AgentStateChangedEvent["agent"]>;
};

// Canonical display alerts also drive the attention sound, including harness errors without a kind.
export function isStationAttentionEvent(event: StationEvent): event is StationAttentionEvent {
  return (
    event.type === "worktree.agentStateChanged" &&
    event.agent !== undefined &&
    AGENT_STATUS[event.agent.state].alert
  );
}
