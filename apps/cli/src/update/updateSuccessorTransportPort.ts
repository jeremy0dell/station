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
 * Executes one pinned successor evaluator and returns its strict public v4 update report.
 */
export interface UpdateSuccessorTransportPort {
  run(input: UpdateSuccessorTransportInput): Promise<UpdateCommandReport>;
}
