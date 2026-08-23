import type {
  HostHandoffFidelity,
  UpdateArtifact,
  UpdateCommandArgv,
  UpdateCommandReport,
} from "@station/contracts";
import type { UpdateChannelId } from "./updateChannel.js";

export type UpdateConvergenceRequest = {
  channel?: UpdateChannelId;
  mode: "preview" | "apply";
  packageManager: "defer" | "drive";
  handoff?: HostHandoffFidelity;
  reap: boolean;
  evaluator: "incumbent-cli" | "successor-cli";
  successorTarget?: UpdateArtifact;
  successorManagerCommand?: UpdateCommandArgv;
};

/**
 * DRIVING PORT
 *
 * Offers exact-target and exact-install-owner convergence to CLI actors without exposing its
 * driven capabilities.
 */
export interface UpdateConvergencePort {
  run(request: UpdateConvergenceRequest): Promise<UpdateCommandReport>;
}
