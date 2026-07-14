import type { HarnessEventObservation } from "@station/contracts";
import type { SessionTurnReadinessMutation } from "../persistence/index.js";

/**
 * POLICY
 *
 * Converts normalized harness status into the durable readiness mutation owned by ingress completion.
 */
export function sessionTurnReadinessMutationFromHarnessObservation(input: {
  observation: HarnessEventObservation;
  updatedAt: string;
}): SessionTurnReadinessMutation | undefined {
  const { observation } = input;
  if (observation.sessionId === undefined) {
    return undefined;
  }

  if (observation.turn?.kind === "turn_completed" && observation.status?.value === "idle") {
    if (
      observation.reportId === undefined ||
      observation.projectId === undefined ||
      observation.worktreeId === undefined
    ) {
      return undefined;
    }
    return {
      action: "upsert",
      value: {
        sessionId: observation.sessionId,
        projectId: observation.projectId,
        worktreeId: observation.worktreeId,
        token: observation.reportId,
        completedAt: observation.status.updatedAt,
        updatedAt: input.updatedAt,
      },
    };
  }

  const status = observation.status?.value;
  if (status === "working" || status === "starting" || status === "needs_attention") {
    return { action: "delete", sessionId: observation.sessionId };
  }
  return undefined;
}
