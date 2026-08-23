import type {
  HostHandoffFidelity,
  UpdateArtifact,
  UpdateHostConvergenceCommandResult,
  UpdateHostConvergenceCommitment,
  UpdateReapHostEvidence,
} from "@station/contracts";

/**
 * DRIVEN PORT
 *
 * Supplies one update-owned Host inspection and phase-constrained mutations bound to the selected
 * build and exact immutable terminal inventory.
 */
export interface UpdateHostRuntimePort {
  inspect(artifacts: {
    installed: UpdateArtifact;
    target: UpdateArtifact;
  }): Promise<UpdateReapHostEvidence>;
  replaceIdleHost(
    commitment: UpdateHostConvergenceCommitment,
  ): Promise<UpdateHostConvergenceCommandResult>;
  handoffHost(
    fidelity: HostHandoffFidelity,
    commitment: UpdateHostConvergenceCommitment,
  ): Promise<UpdateHostConvergenceCommandResult>;
}
