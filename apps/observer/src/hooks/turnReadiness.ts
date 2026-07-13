import type { HarnessEventObservation } from "@station/contracts";
import type { SessionStore, SessionTurnReadinessMutation } from "../persistence/index.js";

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

export async function persistTurnReadinessFromHarnessObservation(input: {
  persistence: SessionStore;
  observation: HarnessEventObservation;
  updatedAt: string;
}): Promise<boolean> {
  const mutation = sessionTurnReadinessMutationFromHarnessObservation(input);
  if (mutation === undefined) {
    return false;
  }
  if (mutation.action === "upsert") {
    await input.persistence.upsertSessionTurnReadiness(mutation.value);
    return true;
  }

  // Readiness is an interval: a session that is active again (new turn, or a
  // request for the user mid-turn) makes ready_to_read stale. Without this
  // closing edge the badge survives on a working agent, and it cannot be
  // acknowledged because snapshots only expose readiness on idle agents.
  await input.persistence.deleteSessionTurnReadiness({ sessionId: mutation.sessionId });
  return false;
}
