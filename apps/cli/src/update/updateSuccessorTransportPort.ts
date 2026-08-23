import type { HostHandoffFidelity, UpdateArtifact, UpdateCommandReport } from "@station/contracts";
import type { ExecutableArgv } from "../selfExec.js";
import type { UpdateChannelId } from "./updateChannel.js";

export type UpdateSuccessorTransportInput = {
  launcher: ExecutableArgv;
  channel: UpdateChannelId;
  target: UpdateArtifact;
  handoff?: HostHandoffFidelity;
};

/**
 * DRIVEN PORT
 *
 * Executes one pinned successor evaluator and returns a strict v4 report only after exact selected
 * channel, artifact, immutable build, evaluator, result-kind, and exit-status validation.
 */
export interface UpdateSuccessorTransportPort {
  run(input: UpdateSuccessorTransportInput): Promise<UpdateCommandReport>;
}
