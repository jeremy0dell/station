import type { StationConfig } from "@station/config";
import type {
  ObserverProcessIdentity,
  ObserverRecoveryAssessment,
  UpdateArtifact,
  UpdateReapHostEvidence,
  UpdateReapObserverEvidence,
  UpdateReapRecoveryAssessment,
  UpdateReapTerminalEvidence,
} from "@station/contracts";
import { compareCodeUnitStrings } from "@station/contracts";
import {
  createLocalObserverProcessEvidence,
  type ObserverProcessIdentityEvidenceSource,
  type ProviderRegistry,
  readHarnessHookHealth,
  verifyObserverProcessIdentity,
} from "@station/observer/internal";
import { createObserverClient, type ExpectedObserverIdentity } from "@station/protocol";
import {
  parseStationObserverBuildVersion,
  type StationBuildInfo,
  stationObserverBuildVersion,
} from "@station/runtime";
import { type HostCommandDeps, runHostCommand } from "../commands/host/index.js";
import { getObserverStatus, type ObserverProcessDeps } from "../observerProcess.js";
import type { UpdateRecoveryPreflightPorts } from "./recoveryPreflight.js";
import { redactedPreflightError } from "./recoveryPreflight.js";

export type CreateUpdateRecoveryPreflightPortsOptions = {
  config: StationConfig;
  configPath?: string;
  hostDeps?: HostCommandDeps;
  observerDeps?: ObserverProcessDeps;
  observerIdentitySource?: ObserverProcessIdentityEvidenceSource;
  readObserverIdentity?: (socketPath: string) => Promise<ObserverProcessIdentity | undefined>;
  providers: ProviderRegistry;
  observerStatus?: typeof getObserverStatus;
  hostStatus?: typeof runHostCommand;
  /** Immutable identity captured once by update command composition. */
  currentBuildInfo: StationBuildInfo;
};

/**
 * COMPOSITION ROOT
 *
 * Binds recovery preflight to read-only local process evidence, Observer protocol queries, strict
 * Host inventory, and the provider-neutral hook-health use case. Both runtime selectors derive from
 * one composition-captured build identity; no lifecycle or repair capability is exposed.
 */
export function createUpdateRecoveryPreflightPorts(
  options: CreateUpdateRecoveryPreflightPortsOptions,
): UpdateRecoveryPreflightPorts {
  const localObserverEvidence = createLocalObserverProcessEvidence();
  const observerIdentitySource = options.observerIdentitySource ?? localObserverEvidence;
  const readIdentity = options.readObserverIdentity ?? localObserverEvidence.readProcessIdentity;
  const providers = options.providers;
  const currentBuildIdentity = options.currentBuildInfo.buildIdentity;
  const currentObserverBuildVersion = stationObserverBuildVersion(options.currentBuildInfo);
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
    inspectHost: (artifacts) =>
      inspectHostRecoveryEvidence({
        config: options.config,
        artifacts,
        currentBuildIdentity,
        readStatus: options.hostStatus ?? runHostCommand,
        ...(options.hostDeps === undefined ? {} : { hostDeps: options.hostDeps }),
      }),
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
}): Promise<UpdateReapObserverEvidence> {
  const status = await input.readStatus({ config: input.config }, input.observerDeps);
  if (status.status !== "running") {
    switch (status.status) {
      case "stopped":
        return inspectStoppedObserverEvidence(input, status.paths.socketPath);
      case "stale":
        return observerUnknown(
          "stale-socket",
          "UPDATE_PREFLIGHT_OBSERVER_STALE",
          "Observer socket evidence is stale.",
        );
      case "unhealthy":
        return observerUnknown(
          "unhealthy",
          "UPDATE_PREFLIGHT_OBSERVER_UNHEALTHY",
          "Observer health could not be established.",
          status.error,
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
    return observerUnknown(
      "identity-missing",
      "UPDATE_PREFLIGHT_OBSERVER_IDENTITY_MISSING",
      "Observer health did not provide complete process identity.",
    );
  }

  let identity: ObserverProcessIdentity | undefined;
  try {
    identity = await input.readIdentity(paths.socketPath);
  } catch (error) {
    return observerUnknown(
      "identity-unavailable",
      "UPDATE_PREFLIGHT_OBSERVER_IDENTITY_UNAVAILABLE",
      "Observer process identity evidence could not be read.",
      error,
    );
  }
  if (identity === undefined) {
    return observerUnknown(
      "identity-missing",
      "UPDATE_PREFLIGHT_OBSERVER_IDENTITY_MISSING",
      "Observer process identity evidence is missing.",
    );
  }
  if (
    identity.pid !== health.pid ||
    identity.version !== health.version ||
    identity.socketPath !== paths.socketPath
  ) {
    return observerUnknown(
      "identity-mismatch",
      "UPDATE_PREFLIGHT_OBSERVER_IDENTITY_MISMATCH",
      "Observer health and process identity evidence disagree.",
    );
  }
  const before = verifyObserverProcessIdentity(
    { source: "pidfile", identity },
    input.observerIdentitySource,
  );
  if (before.status !== "exact") return observerVerificationUnknown(before.status);

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
    return observerUnknown(
      after.status === "mismatch" ? "identity-mismatch" : "identity-unavailable",
      "UPDATE_PREFLIGHT_OBSERVER_IDENTITY_DRIFT",
      "Observer process identity changed while recovery evidence was captured.",
      after.status === "unavailable" ? after.cause : undefined,
    );
  }

  const runningObserverBuild = parseStationObserverBuildVersion(health.version);
  const exact: Extract<UpdateReapObserverEvidence, { status: "exact" }> = {
    status: "exact",
    buildVersion: health.version,
    relation: runtimeBuildRelation({
      runningDisplayVersion: runningObserverBuild.version,
      runningBuildIdentity:
        runningObserverBuild.buildIdentity === undefined ? undefined : health.version,
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
  return exact;
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

async function inspectHostRecoveryEvidence(input: {
  config: StationConfig;
  artifacts: { installed: UpdateArtifact; target: UpdateArtifact };
  currentBuildIdentity: string;
  readStatus: typeof runHostCommand;
  hostDeps?: HostCommandDeps;
}): Promise<UpdateReapHostEvidence> {
  const deps: HostCommandDeps = {
    ...input.hostDeps,
    expectedBuildVersion: input.artifacts.target.version,
  };
  const status = await input.readStatus(["status"], { config: input.config }, deps);
  if (status.action !== "status") {
    return hostUnknown(
      "health-failed",
      "UPDATE_PREFLIGHT_HOST_HEALTH_FAILED",
      "Host status returned an invalid result.",
    );
  }
  if (status.probe === "absent") return { status: "absent" };
  if (status.probe === "stale") {
    return hostUnknown(
      "stale-socket",
      "UPDATE_PREFLIGHT_HOST_STALE",
      "Host socket evidence is stale.",
    );
  }
  if (status.probe === "inaccessible") {
    return hostUnknown(
      "inaccessible",
      "UPDATE_PREFLIGHT_HOST_INACCESSIBLE",
      "Host socket ownership is inaccessible.",
    );
  }
  if (status.health === undefined || status.compatibility === undefined) {
    return hostUnknown(
      "health-failed",
      "UPDATE_PREFLIGHT_HOST_HEALTH_FAILED",
      "Host health and compatibility could not be established.",
    );
  }
  if (status.ptys === undefined) {
    return hostUnknown(
      "inventory-failed",
      "UPDATE_PREFLIGHT_HOST_INVENTORY_FAILED",
      "Host terminal inventory could not be read.",
    );
  }
  const terminals = status.ptys.map(redactedHostTerminal).sort(compareHostTerminal);
  const evidence: Extract<UpdateReapHostEvidence, { status: "inspected" }> = {
    status: "inspected",
    protocolVersion: status.health.protocolVersion,
    relation: runtimeBuildRelation({
      runningDisplayVersion: status.health.buildVersion,
      runningBuildIdentity: status.buildIdentity,
      currentBuildIdentity: input.currentBuildIdentity,
      artifacts: input.artifacts,
    }),
    compatibility: status.compatibility.action,
    terminals,
  };
  if (status.health.buildVersion !== undefined) evidence.buildVersion = status.health.buildVersion;
  if (status.buildIdentity !== undefined) evidence.buildIdentity = status.buildIdentity;
  return evidence;
}

function redactedHostTerminal(
  terminal: NonNullable<
    Extract<Awaited<ReturnType<typeof runHostCommand>>, { action: "status" }>["ptys"]
  >[number],
): UpdateReapTerminalEvidence {
  return {
    kind: terminal.kind,
    terminalTargetId: terminal.terminalTargetId,
    ptyId: terminal.ptyId,
    ptyInstanceId: terminal.ptyInstanceId,
    projectId: terminal.projectId,
    worktreeId: terminal.worktreeId,
    sessionId: terminal.sessionId,
    harnessProvider: terminal.harnessProvider,
    alive: terminal.alive,
    handoffSupport: terminal.handoffSupport?.kind ?? "unknown",
  };
}

function compareHostTerminal(
  left: UpdateReapTerminalEvidence,
  right: UpdateReapTerminalEvidence,
): number {
  return (
    compareCodeUnitStrings(left.terminalTargetId, right.terminalTargetId) ||
    compareCodeUnitStrings(left.ptyId, right.ptyId) ||
    compareCodeUnitStrings(left.ptyInstanceId, right.ptyInstanceId)
  );
}

function runtimeBuildRelation(input: {
  runningDisplayVersion: string | undefined;
  runningBuildIdentity: string | undefined;
  currentBuildIdentity: string;
  artifacts: { installed: UpdateArtifact; target: UpdateArtifact };
}): "matching-target" | "different" | "unknown" {
  if (input.runningDisplayVersion === undefined) return "unknown";
  if (input.runningDisplayVersion !== input.artifacts.target.version) return "different";
  if (input.runningBuildIdentity === undefined) return "unknown";
  // Display equality never substitutes for the immutable identity of an already-installed target.
  if (input.runningBuildIdentity === input.currentBuildIdentity) {
    return updateArtifactsMatch(input.artifacts.installed, input.artifacts.target)
      ? "matching-target"
      : "different";
  }
  return updateArtifactsMatch(input.artifacts.installed, input.artifacts.target)
    ? "different"
    : "unknown";
}

function updateArtifactsMatch(left: UpdateArtifact, right: UpdateArtifact): boolean {
  return left.version === right.version && left.revision === right.revision;
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
  status: "mismatch" | "unavailable",
): UpdateReapObserverEvidence {
  return observerUnknown(
    status === "mismatch" ? "identity-mismatch" : "identity-unavailable",
    status === "mismatch"
      ? "UPDATE_PREFLIGHT_OBSERVER_IDENTITY_MISMATCH"
      : "UPDATE_PREFLIGHT_OBSERVER_IDENTITY_UNAVAILABLE",
    status === "mismatch"
      ? "Observer process identity does not match current operating-system evidence."
      : "Observer process identity could not be verified from operating-system evidence.",
  );
}

function observerUnknown(
  reason: Extract<UpdateReapObserverEvidence, { status: "unknown" }>["reason"],
  code: string,
  message: string,
  error?: unknown,
): UpdateReapObserverEvidence {
  return {
    status: "unknown",
    reason,
    error: redactedPreflightError(error, { code, message }),
  };
}

function hostUnknown(
  reason: Extract<UpdateReapHostEvidence, { status: "unknown" }>["reason"],
  code: string,
  message: string,
): UpdateReapHostEvidence {
  return {
    status: "unknown",
    reason,
    error: redactedPreflightError(undefined, { code, message }),
  };
}
