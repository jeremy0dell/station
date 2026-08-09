import type { WorktreeRow } from "@station/contracts";

/** Readiness decorates only idle agents; stale readiness on any other state is ignored. */
export function isReadyToRead(row: WorktreeRow): boolean {
  return row.agent?.state === "idle" && row.agent.turnReadiness?.state === "ready_to_read";
}
