import type {
  ObserverStartupEvidence,
  SafeError,
  UpdateArtifact,
  UpdateArtifactApplication,
  UpdateCommandReport,
  UpdateConvergenceResult,
  UpdateEvidencePlan,
} from "@station/contracts";
import type { UpdateCommandArgv } from "./updateChannel.js";

export type PublicUpdateReportInput = {
  selected: { channel: UpdateCommandReport["channel"] };
  current: UpdateArtifact;
  target: UpdateArtifact;
  artifactApplication: UpdateArtifactApplication;
  initial: UpdateEvidencePlan;
  result: UpdateConvergenceResult;
  warnings?: SafeError[];
  recoveryCommands?: UpdateCommandArgv[];
  error?: SafeError;
  cause?: SafeError;
  startupEvidence?: ObserverStartupEvidence;
};

/**
 * DRIVEN PORT
 *
 * Defines the strict redaction-safe public report projection required by update convergence.
 */
export interface UpdatePublicReportPort {
  create(input: PublicUpdateReportInput): UpdateCommandReport;
}
