import type { SetupOperationCheckpoint, SetupOperationCheckpoints } from "../model/session.js";

export const emptySetupOperationCheckpoints: SetupOperationCheckpoints = [];

export function hasCompletedSetupOperation(
  checkpoints: SetupOperationCheckpoints,
  operationId: SetupOperationCheckpoint["operationId"],
): boolean {
  return checkpoints.some((checkpoint) => checkpoint.operationId === operationId);
}

export function recordCompletedSetupOperation(
  checkpoints: SetupOperationCheckpoints,
  checkpoint: SetupOperationCheckpoint,
): SetupOperationCheckpoints {
  return hasCompletedSetupOperation(checkpoints, checkpoint.operationId)
    ? checkpoints
    : [...checkpoints, checkpoint];
}
