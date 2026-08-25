import {
  createLocalObserverProcessEvidence,
  type ExactObserverInspectionPorts,
  inspectExactObserverOwner,
} from "@station/observer/internal";
import { createObserverClient, type ExactObserverLifecycleSession } from "@station/protocol";
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
  session?: ExactObserverLifecycleSession,
) {
  const paths = options.paths ?? resolveObserverPaths(options.config);
  const localEvidence = createLocalObserverProcessEvidence(
    options.startupDeadlineMs === undefined
      ? {}
      : { evidenceDeadlineMs: options.startupDeadlineMs },
  );
  const timeoutMs = () => {
    const maximum = options.timeoutMs ?? 5_000;
    if (options.startupDeadlineMs === undefined) return maximum;
    const remaining = Math.floor(options.startupDeadlineMs - Date.now());
    if (remaining <= 0) throw new Error("Exact Observer inspection deadline expired.");
    return Math.min(maximum, remaining);
  };
  return inspectExactObserverOwner(
    { socketPath: paths.socketPath },
    {
      readStatus: session
        ? async () => ({ status: "running", health: await session.health() })
        : () => getObserverStatus({ ...options, paths, timeoutMs: timeoutMs() }),
      readPidfileIdentity: localEvidence.readProcessIdentity,
      processEvidence: {
        readCooperativeObserverProcess: localEvidence.readCooperativeObserverProcess,
        processStartToken: localEvidence.processStartToken,
      },
      readRecoveryAssessment: session
        ? () => session.getSessionRecoveryAssessment()
        : (identity) =>
            createObserverClient({
              socketPath: identity.socketPath,
              expectedObserverIdentity: identity,
              timeoutMs: timeoutMs(),
            }).getSessionRecoveryAssessment(),
      ...overrides,
    },
  );
}
