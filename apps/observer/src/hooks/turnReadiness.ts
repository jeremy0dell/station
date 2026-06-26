import type { HarnessEventObservation } from "@station/contracts";
import type { ObserverPersistence } from "../persistence/index.js";

export async function persistTurnReadinessFromHarnessObservation(input: {
  persistence: ObserverPersistence;
  observation: HarnessEventObservation;
  updatedAt: string;
}): Promise<boolean> {
  const { observation } = input;
  if (observation.turn?.kind !== "turn_completed" || observation.status?.value !== "idle") {
    return false;
  }
  if (
    observation.reportId === undefined ||
    observation.sessionId === undefined ||
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
