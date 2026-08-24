import {
  createLocalObserverProcessEvidence,
  type ExactObserverInspectionPorts,
  inspectExactObserverOwner,
} from "@station/observer/internal";
import { createObserverClient } from "@station/protocol";
import { getObserverStatus } from "../observerProcess.js";
import { resolveObserverPaths } from "../paths.js";
import type { ObserverProcessOptions } from "./types.js";

/**
 * COMPOSITION ROOT
 *
 * Binds local status, identity, process, and pinned recovery inspection adapters.
 */
export async function inspectExactObserverOwnerWithLocalAdapters(
  options: ObserverProcessOptions = {},
  overrides: Partial<ExactObserverInspectionPorts> = {},
) {
  const paths = options.paths ?? resolveObserverPaths(options.config);
  const localEvidence = createLocalObserverProcessEvidence();
  return inspectExactObserverOwner(
    { socketPath: paths.socketPath },
    {
      readStatus: () => getObserverStatus({ ...options, paths }),
      readPidfileIdentity: localEvidence.readProcessIdentity,
      processEvidence: {
        readCooperativeObserverProcess: localEvidence.readCooperativeObserverProcess,
        processStartToken: localEvidence.processStartToken,
      },
      readRecoveryAssessment: (identity) =>
        createObserverClient({
          socketPath: identity.socketPath,
          expectedObserverIdentity: identity,
          timeoutMs: options.timeoutMs ?? 5_000,
        }).getSessionRecoveryAssessment(),
      ...overrides,
    },
  );
}
