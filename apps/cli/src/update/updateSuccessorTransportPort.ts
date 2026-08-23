import type {
  HostHandoffFidelity,
  UpdateArtifact,
  UpdateCommandArgv,
  UpdateCommandReport,
} from "@station/contracts";
import type { ExecutableArgv } from "../selfExec.js";
import type { UpdateChannelId } from "./updateChannel.js";

export type UpdateSuccessorTransportInput = {
  launcher: ExecutableArgv;
  channel: UpdateChannelId;
  target: UpdateArtifact;
  managerCommand?: UpdateCommandArgv;
  handoff?: HostHandoffFidelity;
};

/**
 * DRIVEN PORT
 *
 * Executes one pinned successor evaluator and returns a current strict report only after exact selected
 * channel, exact install owner command, artifact, immutable build, evaluator, result-kind, and
 * exit-status validation.
 */
export interface UpdateSuccessorTransportPort {
  run(input: UpdateSuccessorTransportInput): Promise<UpdateCommandReport>;
}
