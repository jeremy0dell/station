import type { StationConfig } from "@station/config";
import type {
  ObserverProcessIdentity,
  UpdateReapHostEvidence,
  UpdateReapObserverEvidence,
  UpdateReapTerminalEvidence,
} from "@station/contracts";
import {
  createLocalObserverProcessEvidence,
  type ObserverProcessIdentityEvidenceSource,
  type ProviderRegistry,
  readHarnessHookHealth,
  verifyObserverProcessIdentity,
} from "@station/observer/internal";
import { createObserverClient, type ExpectedObserverIdentity } from "@station/protocol";
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
};

/**
 * COMPOSITION ROOT
 *
 * Binds recovery preflight to read-only local process evidence, Observer protocol queries, strict
 * Host inventory, and the provider-neutral hook-health use case. No lifecycle or repair capability
 * is exposed through these ports.
 */
export function createUpdateRecoveryPreflightPorts(
  options: CreateUpdateRecoveryPreflightPortsOptions,
): UpdateRecoveryPreflightPorts {
  const localObserverEvidence = createLocalObserverProcessEvidence();
  const observerIdentitySource = options.observerIdentitySource ?? localObserverEvidence;
  const readIdentity = options.readObserverIdentity ?? localObserverEvidence.readProcessIdentity;
  const providers = options.providers;
  return {
    inspectObserver: (targetBuildVersion) =>
      inspectObserverRecoveryEvidence({
        config: options.config,
        targetBuildVersion,
        observerIdentitySource,
        readIdentity,
        readStatus: options.observerStatus ?? getObserverStatus,
        ...(options.observerDeps === undefined ? {} : { observerDeps: options.observerDeps }),
      }),
    inspectHost: (targetBuildVersion) =>
      inspectHostRecoveryEvidence({
        config: options.config,
        targetBuildVersion,
        readStatus: options.hostStatus ?? runHostCommand,
        ...(options.hostDeps === undefined ? {} : { hostDeps: options.hostDeps }),
      }),
    readHookHealth: (providerId) => {
      const hookOptions: Parameters<typeof readHarnessHookHealth>[0] = { providers, providerId };
      if (options.configPath !== undefined) hookOptions.stationConfigPath = options.configPath;
      return readHarnessHookHealth(hookOptions);
    },
    hookProviderIds: Array.from(providers.harnesses.keys()).sort(),
  };
}

async function inspectObserverRecoveryEvidence(input: {
  config: StationConfig;
  targetBuildVersion: string;
  observerIdentitySource: ObserverProcessIdentityEvidenceSource;
  readIdentity: (socketPath: string) => Promise<ObserverProcessIdentity | undefined>;
  readStatus: typeof getObserverStatus;
  observerDeps?: ObserverProcessDeps;
}): Promise<UpdateReapObserverEvidence> {
  const status = await input.readStatus({ config: input.config }, input.observerDeps);
  if (status.status !== "running") {
    switch (status.status) {
      case "stopped":
        return { status: "absent" };
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

  const exact: Extract<UpdateReapObserverEvidence, { status: "exact" }> = {
    status: "exact",
    buildVersion: health.version,
    relation: buildRelation(health.version, input.targetBuildVersion),
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
        : { status: "assessed", assessment },
  };
  return exact;
}

async function inspectHostRecoveryEvidence(input: {
  config: StationConfig;
  targetBuildVersion: string;
  readStatus: typeof runHostCommand;
  hostDeps?: HostCommandDeps;
}): Promise<UpdateReapHostEvidence> {
  const deps: HostCommandDeps = {
    ...input.hostDeps,
    expectedBuildVersion: input.targetBuildVersion,
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
    relation: buildRelation(status.health.buildVersion, input.targetBuildVersion),
    compatibility: status.compatibility.action,
    terminals,
  };
  if (status.health.buildVersion !== undefined) evidence.buildVersion = status.health.buildVersion;
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
    left.terminalTargetId.localeCompare(right.terminalTargetId) ||
    left.ptyId.localeCompare(right.ptyId) ||
    left.ptyInstanceId.localeCompare(right.ptyInstanceId)
  );
}

function buildRelation(
  buildVersion: string | undefined,
  targetBuildVersion: string,
): "matching-target" | "different" | "unknown" {
  if (buildVersion === undefined) return "unknown";
  return buildVersion === targetBuildVersion ? "matching-target" : "different";
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
