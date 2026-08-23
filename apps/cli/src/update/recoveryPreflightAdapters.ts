import type { StationConfig } from "@station/config";
import {
  compareCodeUnitStrings,
  type ObserverProcessIdentity,
  type ObserverRecoveryAssessment,
  type UpdateArtifact,
  type UpdateReapObserverEvidence,
  type UpdateReapRecoveryAssessment,
} from "@station/contracts";
import {
  createLocalObserverProcessEvidence,
  type ObserverProcessIdentityEvidenceSource,
  type ProviderRegistry,
  readHarnessHookHealth,
  verifyObserverProcessIdentity,
} from "@station/observer/internal";
import { createObserverClient, type ExpectedObserverIdentity } from "@station/protocol";
import { parseStationObserverBuildVersion, stationObserverBuildVersion } from "@station/runtime";
import { classifyObserverHealth } from "../observerProcess/health.js";
import { getObserverStatus, type ObserverProcessDeps } from "../observerProcess.js";
import type { UpdateRecoveryPreflightPorts } from "./recoveryPreflight.js";
import {
  redactedPreflightError,
  type UpdateConvergencePrivateEvidence,
} from "./recoveryPreflight.js";
import { classifyUpdateRuntimeBuildRelation } from "./runtimeBuildRelation.js";
import type { UpdateHostRuntimePort } from "./updateHostRuntimePort.js";

export type CreateUpdateRecoveryPreflightPortsOptions = {
  config: StationConfig;
  configPath?: string;
  inspectHost: UpdateHostRuntimePort["inspect"];
  observerDeps?: ObserverProcessDeps;
  observerIdentitySource?: ObserverProcessIdentityEvidenceSource;
  readObserverIdentity?: (socketPath: string) => Promise<ObserverProcessIdentity | undefined>;
  providers: ProviderRegistry;
  observerStatus?: typeof getObserverStatus;
  /** Test seam for the exact current Observer selector. */
  currentObserverBuildVersion?: string;
};

/**
 * COMPOSITION ROOT
 *
 * Binds recovery preflight to read-only local process evidence, Observer protocol queries, strict
 * Host inventory, and the provider-neutral hook-health use case. Observer public evidence and its
 * CLI-private ownership sidecar are captured together. No lifecycle or repair capability is
 * exposed through these ports.
 */
export function createUpdateRecoveryPreflightPorts(
  options: CreateUpdateRecoveryPreflightPortsOptions,
): UpdateRecoveryPreflightPorts {
  const localObserverEvidence = createLocalObserverProcessEvidence();
  const observerIdentitySource = options.observerIdentitySource ?? localObserverEvidence;
  const readIdentity = options.readObserverIdentity ?? localObserverEvidence.readProcessIdentity;
  const providers = options.providers;
  const currentObserverBuildVersion =
    options.currentObserverBuildVersion ?? stationObserverBuildVersion();
  return {
    inspectObserver: (artifacts) =>
      inspectObserverRecoveryEvidence({
        config: options.config,
        artifacts,
        currentObserverBuildVersion,
        observerIdentitySource,
        readIdentity,
        readStatus: options.observerStatus ?? getObserverStatus,
        ...(options.observerDeps === undefined ? {} : { observerDeps: options.observerDeps }),
      }),
    inspectHost: options.inspectHost,
    readHookHealth: (providerId) => {
      const hookOptions: Parameters<typeof readHarnessHookHealth>[0] = { providers, providerId };
      if (options.configPath !== undefined) hookOptions.stationConfigPath = options.configPath;
      return readHarnessHookHealth(hookOptions);
    },
    hookProviderIds: Array.from(providers.harnesses.keys()).sort(compareCodeUnitStrings),
  };
}

async function inspectObserverRecoveryEvidence(input: {
  config: StationConfig;
  artifacts: { installed: UpdateArtifact; target: UpdateArtifact };
  currentObserverBuildVersion: string;
  observerIdentitySource: ObserverProcessIdentityEvidenceSource;
  readIdentity: (socketPath: string) => Promise<ObserverProcessIdentity | undefined>;
  readStatus: typeof getObserverStatus;
  observerDeps?: ObserverProcessDeps;
}): Promise<{
  evidence: UpdateReapObserverEvidence;
  privateEvidence: UpdateConvergencePrivateEvidence;
}> {
  const status = await input.readStatus({ config: input.config }, input.observerDeps);
  if (status.status !== "running") {
    switch (status.status) {
      case "stopped":
        return {
          evidence: await inspectStoppedObserverEvidence(input, status.paths.socketPath),
          privateEvidence: { selectedRecoveryHandles: [] },
        };
      case "stale":
        return publicOnlyObserver(
          observerUnknown(
            "stale-socket",
            "UPDATE_PREFLIGHT_OBSERVER_STALE",
            "Observer socket evidence is stale.",
          ),
        );
      case "unhealthy":
        return publicOnlyObserver(
          observerUnknown(
            "unhealthy",
            "UPDATE_PREFLIGHT_OBSERVER_UNHEALTHY",
            "Observer health could not be established.",
            status.error,
          ),
        );
    }
  }

  const { health, paths } = status;
  if (
    health.pid === undefined ||
    health.startedAt === undefined ||
    health.version === undefined ||
    (health.socketPath !== undefined && health.socketPath !== paths.socketPath)
  ) {
    return publicOnlyObserver(
      observerUnknown(
        "identity-missing",
        "UPDATE_PREFLIGHT_OBSERVER_IDENTITY_MISSING",
        "Observer health did not provide complete process identity.",
      ),
    );
  }

  let identity: ObserverProcessIdentity | undefined;
  try {
    identity = await input.readIdentity(paths.socketPath);
  } catch (error) {
    return publicOnlyObserver(
      observerUnknown(
        "identity-unavailable",
        "UPDATE_PREFLIGHT_OBSERVER_IDENTITY_UNAVAILABLE",
        "Observer process identity evidence could not be read.",
        error,
      ),
    );
  }
  if (identity === undefined) {
    return publicOnlyObserver(
      observerUnknown(
        "identity-missing",
        "UPDATE_PREFLIGHT_OBSERVER_IDENTITY_MISSING",
        "Observer process identity evidence is missing.",
      ),
    );
  }
  if (
    identity.pid !== health.pid ||
    identity.version !== health.version ||
    identity.socketPath !== paths.socketPath
  ) {
    return publicOnlyObserver(
      observerUnknown(
        "identity-mismatch",
        "UPDATE_PREFLIGHT_OBSERVER_IDENTITY_MISMATCH",
        "Observer health and process identity evidence disagree.",
      ),
    );
  }
  const before = verifyObserverProcessIdentity(
    { source: "pidfile", identity },
    input.observerIdentitySource,
  );
  if (before.status !== "exact") {
    const restartable = restartableInstalledPathReplacement(input, health, identity, before);
    if (restartable !== undefined) return restartable;
    return publicOnlyObserver(observerVerificationUnknown(before.status));
  }

  const expectedObserverIdentity: ExpectedObserverIdentity = {
    pid: health.pid,
    startedAt: health.startedAt,
    version: health.version,
    socketPath: paths.socketPath,
  };
  let assessment:
    | Awaited<ReturnType<ReturnType<typeof createObserverClient>["getSessionRecoveryAssessment"]>>
    | undefined;
  let inspectionFailure: unknown;
  try {
    const client =
      input.observerDeps?.clientFactory?.(paths.socketPath, {
        expectedObserverIdentity,
        timeoutMs: 5_000,
      }) ??
      createObserverClient({
        socketPath: paths.socketPath,
        expectedObserverIdentity,
        timeoutMs: 5_000,
      });
    assessment = await client.getSessionRecoveryAssessment();
  } catch (error) {
    inspectionFailure = error;
  }

  const after = verifyObserverProcessIdentity(
    { source: "pidfile", identity },
    input.observerIdentitySource,
  );
  if (after.status !== "exact") {
    return publicOnlyObserver(
      observerUnknown(
        after.status === "unavailable" ? "identity-unavailable" : "identity-mismatch",
        "UPDATE_PREFLIGHT_OBSERVER_IDENTITY_DRIFT",
        "Observer process identity changed while recovery evidence was captured.",
        after.status === "unavailable" ? after.cause : undefined,
      ),
    );
  }

  const exact: Extract<UpdateReapObserverEvidence, { status: "exact" }> = {
    status: "exact",
    buildVersion: health.version,
    relation: classifyUpdateRuntimeBuildRelation({
      runningDisplayVersion: parseStationObserverBuildVersion(health.version).version,
      runningBuildIdentity: health.version,
      currentBuildIdentity: input.currentObserverBuildVersion,
      artifacts: input.artifacts,
    }),
    health: health.status,
    recovery:
      assessment === undefined
        ? {
            status: "unknown",
            reason: "inspection-failed",
            error: redactedPreflightError(inspectionFailure, {
              code: "UPDATE_PREFLIGHT_RECOVERY_API_FAILED",
              message: "Observer recovery assessment could not be read.",
            }),
          }
        : { status: "assessed", assessment: publicRecoveryAssessment(assessment) },
  };
  return {
    evidence: exact,
    privateEvidence: {
      observer: {
        pid: identity.pid,
        osStartTime: identity.osStartTime,
        processToken: identity.processToken,
        buildSelector: identity.version,
      },
      selectedRecoveryHandles:
        assessment === undefined ? [] : selectedStationRecoveryHandles(assessment),
    },
  };
}

function restartableInstalledPathReplacement(
  input: Pick<Parameters<typeof inspectObserverRecoveryEvidence>[0], "currentObserverBuildVersion">,
  health: Extract<Awaited<ReturnType<typeof getObserverStatus>>, { status: "running" }>["health"],
  identity: ObserverProcessIdentity,
  verification: ReturnType<typeof verifyObserverProcessIdentity>,
):
  | {
      evidence: UpdateReapObserverEvidence;
      privateEvidence: UpdateConvergencePrivateEvidence;
    }
  | undefined {
  if (verification.status !== "installed-path-replaced") return undefined;
  const decision = classifyObserverHealth(health, input.currentObserverBuildVersion);
  if (
    decision.action !== "replace" &&
    !(decision.action === "attach" && decision.reason === "exact-build")
  ) {
    return undefined;
  }
  // Atomic installation replacement invalidates path provenance for the still-running image.
  // Only the existing health-pinned explicit restart may consume this narrow evidence state.
  return {
    evidence: observerUnknown(
      "restartable-executable-drift",
      "UPDATE_PREFLIGHT_OBSERVER_EXECUTABLE_DRIFT_RESTARTABLE",
      "Observer executable provenance changed, but its stable identity admits an explicit same- or higher-build restart.",
      undefined,
      identity.version,
    ),
    privateEvidence: {
      observer: {
        pid: identity.pid,
        osStartTime: identity.osStartTime,
        processToken: identity.processToken,
        buildSelector: identity.version,
      },
      selectedRecoveryHandles: [],
    },
  };
}

function publicOnlyObserver(evidence: UpdateReapObserverEvidence): {
  evidence: UpdateReapObserverEvidence;
  privateEvidence: UpdateConvergencePrivateEvidence;
} {
  return { evidence, privateEvidence: { selectedRecoveryHandles: [] } };
}

function selectedStationRecoveryHandles(
  assessment: ObserverRecoveryAssessment,
): UpdateConvergencePrivateEvidence["selectedRecoveryHandles"] {
  return assessment.sessions.flatMap((session) =>
    session.handleResolution.kind === "selected"
      ? [
          {
            sessionId: session.sessionId,
            selectedHandleId: session.handleResolution.selectedHandleId,
          },
        ]
      : [],
  );
}

async function inspectStoppedObserverEvidence(
  input: Pick<
    Parameters<typeof inspectObserverRecoveryEvidence>[0],
    "readIdentity" | "observerIdentitySource"
  >,
  socketPath: string,
): Promise<UpdateReapObserverEvidence> {
  let identity: ObserverProcessIdentity | undefined;
  try {
    identity = await input.readIdentity(socketPath);
  } catch (error) {
    return observerUnknown(
      "identity-unavailable",
      "UPDATE_PREFLIGHT_OBSERVER_IDENTITY_UNAVAILABLE",
      "Observer process identity evidence could not be read.",
      error,
    );
  }
  if (identity === undefined) return { status: "absent" };
  if (identity.socketPath !== socketPath) {
    return observerUnknown(
      "identity-mismatch",
      "UPDATE_PREFLIGHT_OBSERVER_IDENTITY_MISMATCH",
      "Observer pidfile identity does not match the configured socket.",
    );
  }
  const verification = verifyObserverProcessIdentity(
    { source: "pidfile", identity },
    input.observerIdentitySource,
  );
  if (verification.status !== "exact") return observerVerificationUnknown(verification.status);
  return observerUnknown(
    "process-without-socket",
    "UPDATE_PREFLIGHT_OBSERVER_PROCESS_WITHOUT_SOCKET",
    "An exact live Observer process exists without a reachable socket.",
  );
}

function publicRecoveryAssessment(
  assessment: ObserverRecoveryAssessment,
): UpdateReapRecoveryAssessment {
  const sessions: UpdateReapRecoveryAssessment["sessions"] = assessment.sessions.map((session) => {
    const handleResolution = session.handleResolution;
    const publicHandleResolution =
      handleResolution.kind === "selected"
        ? {
            kind: "selected" as const,
            eligibleHandleCount: handleResolution.eligibleHandleCount,
            rejectedHandleCount: handleResolution.rejectedHandleCount,
            rejectedReasons: handleResolution.rejectedReasons,
          }
        : handleResolution;
    const projected: UpdateReapRecoveryAssessment["sessions"][number] = {
      sessionId: session.sessionId,
      projectId: session.projectId,
      worktreeId: session.worktreeId,
      lifecycle: session.lifecycle,
      disposition: session.disposition,
      reasons: session.reasons,
      handleResolution: publicHandleResolution,
    };
    if (session.harnessProvider !== undefined) {
      projected.harnessProvider = session.harnessProvider;
    }
    return projected;
  });
  return {
    schemaVersion: 1,
    resumeEnabled: assessment.resumeEnabled,
    providerCapabilities: assessment.providerCapabilities,
    sessions,
  };
}

function observerVerificationUnknown(
  status: "installed-path-replaced" | "mismatch" | "unavailable",
): UpdateReapObserverEvidence {
  const mismatch = status !== "unavailable";
  return observerUnknown(
    mismatch ? "identity-mismatch" : "identity-unavailable",
    mismatch
      ? "UPDATE_PREFLIGHT_OBSERVER_IDENTITY_MISMATCH"
      : "UPDATE_PREFLIGHT_OBSERVER_IDENTITY_UNAVAILABLE",
    mismatch
      ? "Observer process identity does not match current operating-system evidence."
      : "Observer process identity could not be verified from operating-system evidence.",
  );
}

function observerUnknown(
  reason: Extract<UpdateReapObserverEvidence, { status: "unknown" }>["reason"],
  code: string,
  message: string,
  error?: unknown,
  buildVersion?: string,
): UpdateReapObserverEvidence {
  const evidence: Extract<UpdateReapObserverEvidence, { status: "unknown" }> = {
    status: "unknown",
    reason,
    error: redactedPreflightError(error, { code, message }),
  };
  if (buildVersion !== undefined) evidence.buildVersion = buildVersion;
  return evidence;
}
