import { type StationConfig, stationHostSocketPath } from "@station/config";
import type {
  ObserverRecoveryAssessment,
  StationBuildIdentity,
  StationHostTerminalLifetime,
  UpdateArtifact,
  UpdateReapHostEvidence,
  UpdateReapObserverEvidence,
  UpdateReapRecoveryAssessment,
  UpdateReapTerminalEvidence,
} from "@station/contracts";
import { compareCodeUnitStrings } from "@station/contracts";
import {
  type ExactObserverInspectionFailureReason,
  type ExactObserverOwnershipEvidence,
  type ProviderRegistry,
  readHarnessHookHealth,
} from "@station/observer/internal";
import {
  parseStationObserverBuildVersion,
  type StationBuildInfo,
  stationObserverBuildVersion,
} from "@station/runtime";
import { type InspectStationHostDeps, inspectStationHost } from "@station/terminal";
import { inspectExactObserverOwnerWithLocalAdapters } from "../observerProcess/inspectExactObserverOwner.js";
import type { UpdateRecoveryPreflightPorts } from "./recoveryPreflight.js";
import { redactedPreflightError } from "./recoveryPreflight.js";

export type CreateUpdateRecoveryPreflightPortsOptions = {
  config: StationConfig;
  configPath?: string;
  hostInspectionDeps?: InspectStationHostDeps;
  inspectObserverOwner?: () => Promise<ExactObserverOwnershipEvidence>;
  providers: ProviderRegistry;
  inspectHost?: typeof inspectStationHost;
  /** Immutable identity captured once by update command composition. */
  currentBuildInfo: StationBuildInfo;
};

/**
 * COMPOSITION ROOT
 *
 * Binds exact Observer inspection, strict Host inventory, and provider-neutral hook health.
 */
export function createUpdateRecoveryPreflightPorts(
  options: CreateUpdateRecoveryPreflightPortsOptions,
): UpdateRecoveryPreflightPorts {
  const providers = options.providers;
  const currentBuildIdentity = options.currentBuildInfo.buildIdentity;
  const currentObserverBuildVersion = stationObserverBuildVersion(options.currentBuildInfo);
  const inspectObserverOwner =
    options.inspectObserverOwner ??
    (() =>
      inspectExactObserverOwnerWithLocalAdapters({ config: options.config, timeoutMs: 5_000 }));
  return {
    inspectObserver: (artifacts) =>
      inspectObserverRecoveryEvidence({
        artifacts,
        currentObserverBuildVersion,
        inspectObserverOwner,
      }),
    inspectHost: (artifacts) =>
      inspectHostRecoveryEvidence({
        config: options.config,
        artifacts,
        currentBuildIdentity,
        inspectHost: options.inspectHost ?? inspectStationHost,
        ...(options.hostInspectionDeps === undefined
          ? {}
          : { inspectionDeps: options.hostInspectionDeps }),
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
  artifacts: { installed: UpdateArtifact; target: UpdateArtifact };
  currentObserverBuildVersion: string;
  inspectObserverOwner: () => Promise<ExactObserverOwnershipEvidence>;
}): Promise<UpdateReapObserverEvidence> {
  const inspection = await input.inspectObserverOwner();
  if (inspection.status === "absent") return { status: "absent" };
  if (inspection.status === "blocked") {
    return observerInspectionUnknown(inspection.reason, inspection.error);
  }

  const runningObserverBuild = parseStationObserverBuildVersion(inspection.processIdentity.version);
  const exact: Extract<UpdateReapObserverEvidence, { status: "exact" }> = {
    status: "exact",
    buildVersion: inspection.processIdentity.version,
    relation: runtimeBuildRelation({
      runningDisplayVersion: runningObserverBuild.version,
      runningBuildIdentity:
        runningObserverBuild.buildIdentity === undefined
          ? undefined
          : inspection.processIdentity.version,
      currentBuildIdentity: input.currentObserverBuildVersion,
      artifacts: input.artifacts,
    }),
    health: inspection.health.status,
    recovery:
      inspection.recovery.status === "unknown"
        ? {
            status: "unknown",
            reason: "inspection-failed",
            error: redactedPreflightError(inspection.recovery.error, {
              code: "UPDATE_PREFLIGHT_RECOVERY_API_FAILED",
              message: "Observer recovery assessment could not be read.",
            }),
          }
        : {
            status: "assessed",
            assessment: publicRecoveryAssessment(inspection.recovery.assessment),
          },
  };
  return exact;
}

function observerInspectionUnknown(
  reason: ExactObserverInspectionFailureReason,
  error?: unknown,
): UpdateReapObserverEvidence {
  if (reason === "identity-drift") {
    return observerUnknown(
      "identity-mismatch",
      "UPDATE_PREFLIGHT_OBSERVER_IDENTITY_DRIFT",
      "Observer process identity changed while recovery evidence was captured.",
      error,
    );
  }
  const details = {
    "stale-socket": ["UPDATE_PREFLIGHT_OBSERVER_STALE", "Observer socket evidence is stale."],
    unhealthy: ["UPDATE_PREFLIGHT_OBSERVER_UNHEALTHY", "Observer health could not be established."],
    "identity-missing": [
      "UPDATE_PREFLIGHT_OBSERVER_IDENTITY_MISSING",
      "Observer process identity evidence is missing.",
    ],
    "identity-unavailable": [
      "UPDATE_PREFLIGHT_OBSERVER_IDENTITY_UNAVAILABLE",
      "Observer process identity evidence could not be read.",
    ],
    "identity-mismatch": [
      "UPDATE_PREFLIGHT_OBSERVER_IDENTITY_MISMATCH",
      "Observer health and process identity evidence disagree.",
    ],
    "process-without-socket": [
      "UPDATE_PREFLIGHT_OBSERVER_PROCESS_WITHOUT_SOCKET",
      "An exact live Observer process exists without a reachable socket.",
    ],
  } as const;
  const [code, message] = details[reason];
  return observerUnknown(reason, code, message, error);
}

async function inspectHostRecoveryEvidence(input: {
  config: StationConfig;
  artifacts: { installed: UpdateArtifact; target: UpdateArtifact };
  currentBuildIdentity: StationBuildIdentity;
  inspectHost: typeof inspectStationHost;
  inspectionDeps?: InspectStationHostDeps;
}): Promise<UpdateReapHostEvidence> {
  const inspection = await input.inspectHost(
    {
      socketPath: stationHostSocketPath(input.config),
      expectedBuildVersion: input.artifacts.target.version,
    },
    input.inspectionDeps,
  );
  if (inspection.status === "absent") return { status: "absent" };
  if (inspection.status === "stale") {
    return hostUnknown(
      "stale-socket",
      "UPDATE_PREFLIGHT_HOST_STALE",
      "Host socket evidence is stale.",
    );
  }
  if (inspection.status === "inaccessible") {
    return hostUnknown(
      "inaccessible",
      "UPDATE_PREFLIGHT_HOST_INACCESSIBLE",
      "Host socket ownership is inaccessible.",
      inspection.error,
    );
  }
  if (inspection.status === "unknown") {
    if (inspection.reason === "inventory-failed") {
      return hostUnknown(
        "inventory-failed",
        "UPDATE_PREFLIGHT_HOST_INVENTORY_FAILED",
        "Host terminal inventory could not be read.",
        inspection.error,
      );
    }
    if (inspection.reason === "endpoint-drift") {
      return hostUnknown(
        "inaccessible",
        "UPDATE_PREFLIGHT_HOST_INACCESSIBLE",
        "Host socket ownership changed during inspection.",
        inspection.error,
      );
    }
    return hostUnknown(
      "health-failed",
      "UPDATE_PREFLIGHT_HOST_HEALTH_FAILED",
      "Host health could not be established exactly.",
      inspection.error,
    );
  }
  const { health, buildIdentity, terminals: privateTerminals } = inspection.evidence;
  return {
    status: "inspected",
    buildVersion: health.buildVersion,
    buildIdentity,
    protocolVersion: health.protocolVersion,
    relation: runtimeBuildRelation({
      runningDisplayVersion: health.buildVersion,
      runningBuildIdentity: buildIdentity,
      currentBuildIdentity: input.currentBuildIdentity,
      artifacts: input.artifacts,
    }),
    compatibility: health.buildVersion === input.artifacts.target.version ? "reuse" : "replace",
    terminals: privateTerminals.map(redactedHostTerminal),
  };
}

function redactedHostTerminal(terminal: StationHostTerminalLifetime): UpdateReapTerminalEvidence {
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
    handoffSupport: terminal.handoffSupport.kind,
  };
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
  error?: unknown,
): UpdateReapHostEvidence {
  return {
    status: "unknown",
    reason,
    error: redactedPreflightError(error, { code, message }),
  };
}
