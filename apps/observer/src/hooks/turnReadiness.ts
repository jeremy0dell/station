import type { HarnessEventObservation } from "@station/contracts";
import type { SessionStore } from "../persistence/index.js";

export async function persistTurnReadinessFromHarnessObservation(input: {
  persistence: SessionStore;
  observation: HarnessEventObservation;
  updatedAt: string;
}): Promise<boolean> {
  const { observation } = input;
  if (observation.sessionId === undefined) {
    return false;
  }

  if (observation.turn?.kind === "turn_completed" && observation.status?.value === "idle") {
    if (
      observation.reportId === undefined ||
      observation.projectId === undefined ||
      observation.worktreeId === undefined
    ) {
      return false;
    }
    await input.persistence.upsertSessionTurnReadiness({
      sessionId: observation.sessionId,
      projectId: observation.projectId,
      worktreeId: observation.worktreeId,
      token: observation.reportId,
      completedAt: observation.status.updatedAt,
      updatedAt: input.updatedAt,
    });
    return true;
  }

  // Readiness is an interval: a session that is active again (new turn, or a
  // request for the user mid-turn) makes ready_to_read stale. Without this
  // closing edge the badge survives on a working agent, and it cannot be
  // acknowledged because snapshots only expose readiness on idle agents.
  const status = observation.status?.value;
  if (status === "working" || status === "starting" || status === "needs_attention") {
    await input.persistence.deleteSessionTurnReadiness({ sessionId: observation.sessionId });
  }
  return false;
}
