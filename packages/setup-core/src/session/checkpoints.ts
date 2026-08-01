import type { SetupOperation } from "../model/operations.js";
import type { SetupOperationCommit } from "../ports.js";

export type SetupOperationCheckpoint = {
  readonly operationId: SetupOperation["id"];
  readonly commit: SetupOperationCommit;
};

export type SetupOperationCheckpoints = readonly SetupOperationCheckpoint[];

export const emptySetupOperationCheckpoints: SetupOperationCheckpoints = [];

export function hasCompletedSetupOperation(
  checkpoints: SetupOperationCheckpoints,
  operationId: SetupOperation["id"],
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
