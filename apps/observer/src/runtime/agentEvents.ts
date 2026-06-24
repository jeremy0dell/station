import type { StationEvent, StationSnapshot } from "@station/contracts";

export function agentStateChangedEventsFromReconcile(
  before: StationSnapshot,
  after: StationSnapshot,
): StationEvent[] {
  const previousAgents = new Map(before.rows.map((row) => [row.id, row.agent]));
  const events: StationEvent[] = [];
  for (const row of after.rows) {
    const previous = previousAgents.get(row.id);
    if (!agentStateChanged(previous, row.agent)) {
      continue;
    }
    const event: StationEvent = {
      type: "worktree.agentStateChanged",
      worktreeId: row.id,
      changeSource: "reconcile",
    };
    if (row.agent !== undefined) event.agent = row.agent;
    events.push(event);
  }
  return events;
}

function agentStateChanged(
  left: StationSnapshot["rows"][number]["agent"],
  right: StationSnapshot["rows"][number]["agent"],
): boolean {
  return left !== undefined && left.state !== right?.state;
}
