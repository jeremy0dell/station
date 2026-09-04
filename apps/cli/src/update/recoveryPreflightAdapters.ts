import { type StationConfig, stationHostSocketPath } from "@station/config";
import type {
  ObserverRecoveryAssessment,
  StationBuildIdentity,
  StationHostConvergenceCommand,
  StationHostExactEvidence,
  StationHostTargetBuild,
  StationHostTerminalLifetime,
  UpdateArtifact,
  UpdateChannelId,
  UpdateConvergencePlan,
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
  reconcileHarnessHooks,
} from "@station/observer/internal";
import { createObserverClient, readUnixSocketHolderPidsAsync } from "@station/protocol";
import {
  createLocalProcessEvidence,
  parseStationObserverBuildVersion,
  type StationBuildInfo,
} from "@station/runtime";
import {
  convergeStationHost,
  type InspectStationHostDeps,
  inspectStationHost,
  parkedOrphanTerminalEvidence,
  preflightParkedOrphanRecovery,
  recoverExactStationHostOrphans,
} from "@station/terminal";
import type { HostCommandDeps } from "../commands/host/runHostCommand.js";
import { resolveStationHostCommand } from "../commands/host/runHostCommand.js";
import { createExactObserverBuildCapability } from "../observerProcess/convergeExactObserverBuild.js";
import { inspectExactObserverOwnerWithLocalAdapters } from "../observerProcess/inspectExactObserverOwner.js";
import { resolveObserverPaths } from "../paths.js";
import {
  reconcilePersistedState,
  requireCurrentObserverIdentity,
} from "../persistedStateReconcile.js";
import type { UpdateConvergenceExecutionDeps } from "./convergenceExecution.js";
import {
  deriveUpdateReapAuthorization,
  type UpdateReapAuthorization,
  UpdateReapAuthorizationEvidenceError,
} from "./reapPlan.js";
import {
  exactUpdateReapProcessGroup,
  UpdateReapProcessGroupEvidenceError,
  type UpdateReapProcessGroupPort,
} from "./reapProcessGroups.js";
import type { UpdateRecoveryPreflightPorts } from "./recoveryPreflight.js";
import { redactedPreflightError, updateRecoveryActionCommitments } from "./recoveryPreflight.js";

export type CreateUpdateRecoveryPreflightPortsOptions = {
  config: StationConfig;
  configPath?: string;
  hostInspectionDeps?: InspectStationHostDeps;
  inspectObserverOwner?: () => Promise<ExactObserverOwnershipEvidence>;
  providers: ProviderRegistry;
  inspectHost?: typeof inspectStationHost;
  preflightParkedBridges?: typeof preflightParkedOrphanRecovery;
  /** Artifact represented by the update command process that supplied `currentBuildInfo`. */
  currentBuildArtifact: UpdateArtifact;
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
  const currentBuildArtifact = options.currentBuildArtifact;
  const currentBuildIdentity = options.currentBuildInfo.buildIdentity;
  const stateDir = resolveObserverPaths(options.config).stateDir;
  let lastObserverEvidence: ExactObserverOwnershipEvidence | undefined;
  let lastHostEvidence: StationHostExactEvidence | undefined;
  let lastParkedTerminals: ReturnType<typeof parkedOrphanTerminalEvidence> | undefined;
  const inspectObserverOwner =
    options.inspectObserverOwner ??
    (() =>
      inspectExactObserverOwnerWithLocalAdapters({ config: options.config, timeoutMs: 5_000 }));
  const captureObserverOwner = async (): Promise<ExactObserverOwnershipEvidence> => {
    lastObserverEvidence = undefined;
    const evidence = await inspectObserverOwner();
    lastObserverEvidence = evidence.status === "exact" ? evidence : undefined;
    return evidence;
  };
  return {
    inspectObserver: (artifacts) =>
      inspectObserverRecoveryEvidence({
        artifacts,
        currentBuildArtifact,
        currentBuildIdentity,
        inspectObserverOwner: captureObserverOwner,
      }),
    inspectHost: async (artifacts) => {
      lastHostEvidence = undefined;
      const inspection = await (options.inspectHost ?? inspectStationHost)(
        {
          socketPath: stationHostSocketPath(options.config),
          expectedBuildVersion: options.currentBuildInfo.version,
        },
        options.hostInspectionDeps,
      );
      lastHostEvidence = inspection.status === "exact" ? inspection.evidence : undefined;
      return projectHostInspection(
        inspection,
        artifacts,
        currentBuildArtifact,
        currentBuildIdentity,
      );
    },
    preflightParkedBridges: async () => {
      lastParkedTerminals = undefined;
      const result = await (options.preflightParkedBridges ?? preflightParkedOrphanRecovery)({
        stateDir,
        ...(lastHostEvidence === undefined ? {} : { currentHostEvidence: lastHostEvidence }),
      });
      lastParkedTerminals = parkedOrphanTerminalEvidence(result);
      return { status: "assessed" as const, ...result };
    },
    captureActionCommitments: () => {
      const commitments: {
        observer?: ExactObserverOwnershipEvidence;
        host?: StationHostExactEvidence;
        parkedTerminals?: ReturnType<typeof parkedOrphanTerminalEvidence>;
      } = {};
      if (lastObserverEvidence !== undefined) {
        commitments.observer = lastObserverEvidence;
      }
      if (lastHostEvidence !== undefined) commitments.host = lastHostEvidence;
      if (lastParkedTerminals !== undefined) commitments.parkedTerminals = lastParkedTerminals;
      return commitments;
    },
    readHookHealth: (providerId) => {
      const hookOptions: Parameters<typeof readHarnessHookHealth>[0] = { providers, providerId };
      if (options.configPath !== undefined) hookOptions.stationConfigPath = options.configPath;
      return readHarnessHookHealth(hookOptions);
    },
    hookProviderIds: Array.from(providers.harnesses.keys()).sort(compareCodeUnitStrings),
  };
}

export type CreateUpdateRuntimeCapabilitiesOptions = {
  config: StationConfig;
  configPath?: string;
  providers?: ProviderRegistry;
  hostDeps?: HostCommandDeps;
  convergeObserver?: UpdateConvergenceExecutionDeps["convergeObserver"];
  reconcileHook?: UpdateConvergenceExecutionDeps["reconcileHook"];
  convergeHost?: UpdateConvergenceExecutionDeps["convergeHost"];
  reconcilePersisted?: UpdateConvergenceExecutionDeps["reconcilePersisted"];
};

/**
 * COMPOSITION ROOT
 *
 * Captures the exact Host socket owner and every live terminal process group for one private reap
 * authorization. The returned SHA-256 digest does not enter the public convergence plan.
 */
export async function deriveLocalUpdateReapAuthorization(input: {
  channel: UpdateChannelId;
  selectedArtifact: UpdateArtifact;
  installedScopeDigest: string;
  preflight: import("@station/contracts").UpdateReapRecoveryPreflight;
  plan: UpdateConvergencePlan;
  processGroups: UpdateReapProcessGroupPort;
  signal?: AbortSignal;
}): Promise<UpdateReapAuthorization> {
  const commitments = updateRecoveryActionCommitments(input.preflight);
  const host = commitments.host;
  if (host === undefined) {
    throw new UpdateReapAuthorizationEvidenceError(
      "Exact Host evidence was unavailable for update reap.",
    );
  }
  const holderPids = await readUnixSocketHolderPidsAsync(host.endpoint.socketPath, {
    deadlineMs: Date.now() + 5_000,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  }).catch(() => {
    throw new UpdateReapAuthorizationEvidenceError(
      "The exact Host socket owner could not be inspected for update reap.",
    );
  });
  if (holderPids.length !== 1) {
    throw new UpdateReapAuthorizationEvidenceError(
      "The exact Host socket did not have one process owner.",
    );
  }
  const hostProcess = createLocalProcessEvidence().read(holderPids[0] ?? 0);
  if (hostProcess === undefined) {
    throw new UpdateReapAuthorizationEvidenceError(
      "The Host process identity was unavailable for update reap.",
    );
  }
  const processGroupObservations = await Promise.all(
    host.terminals
      .filter((terminal) => terminal.alive)
      .map((terminal) => input.processGroups.read(terminal.pid)),
  ).catch((error) => {
    throw new UpdateReapAuthorizationEvidenceError(
      error instanceof UpdateReapProcessGroupEvidenceError
        ? error.message
        : "Terminal process-group evidence could not be inspected for update reap.",
    );
  });
  const processGroups = processGroupObservations.map(exactUpdateReapProcessGroup);
  if (processGroups.some((group) => group === undefined)) {
    throw new UpdateReapAuthorizationEvidenceError(
      "A terminal process-group identity was unavailable for update reap.",
    );
  }
  return deriveUpdateReapAuthorization({
    channel: input.channel,
    selectedArtifact: input.selectedArtifact,
    installedScopeDigest: input.installedScopeDigest,
    preflight: input.preflight,
    plan: input.plan,
    commitments,
    hostProcess: { pid: hostProcess.pid, startToken: hostProcess.startToken },
    processGroups: processGroups.filter((group) => group !== undefined),
  });
}

/**
 * COMPOSITION ROOT
 *
 * Binds the provider-neutral update executor to exact local Observer, Host, hook, and persisted
 * state capabilities. The executor receives only these narrow calls and cannot spawn commands.
 */
export function createUpdateRuntimeCapabilities(
  options: CreateUpdateRuntimeCapabilitiesOptions,
): Pick<
  UpdateConvergenceExecutionDeps,
  "convergeObserver" | "reconcileHook" | "convergeHost" | "reconcilePersisted"
> {
  const convergeObserver = options.convergeObserver ?? createExactObserverBuildCapability();
  const reconcileHook =
    options.reconcileHook ??
    (async (provider, providers, configPath) =>
      reconcileHarnessHooks({
        providers,
        providerId: provider as Parameters<typeof reconcileHarnessHooks>[0]["providerId"],
        ...(configPath === undefined ? {} : { stationConfigPath: configPath }),
      }));
  const convergeHost = options.convergeHost ?? createHostConvergenceCapability(options);
  const reconcilePersisted =
    options.reconcilePersisted ??
    (async (health, socketPath) => {
      const observerIdentity = requireCurrentObserverIdentity(health, socketPath);
      await reconcilePersistedState({ observerIdentity }, (request) => {
        const client = createObserverClient({
          socketPath: request.observerIdentity.socketPath,
          expectedObserverIdentity: request.observerIdentity,
          timeoutMs: request.timeoutMs,
        });
        return { reconcile: (reason) => client.reconcile(reason) };
      });
    });
  return { convergeObserver, reconcileHook, convergeHost, reconcilePersisted };
}

function createHostConvergenceCapability(
  options: CreateUpdateRuntimeCapabilitiesOptions,
): NonNullable<UpdateConvergenceExecutionDeps["convergeHost"]> {
  return async ({ phase, config, buildInfo, expected }) => {
    const targetBuild: StationHostTargetBuild = {
      buildVersion: buildInfo.version,
      buildIdentity: buildInfo.buildIdentity,
    };
    const socketPath = stationHostSocketPath(config);
    const stateDir = resolveObserverPaths(config).stateDir;
    const hostCommand = options.hostDeps?.resolveHostCommand?.() ?? resolveStationHostCommand();
    if (phase.action === "recover-parked") {
      await (options.hostDeps?.recoverHostOrphans ?? recoverExactStationHostOrphans)({
        socketPath,
        stateDir,
        targetBuild,
        hostCommand,
      });
      return;
    }
    if (phase.action !== "replace-idle" && phase.action !== "handoff") {
      throw new Error(`Host convergence action ${phase.action} is not executable.`);
    }
    const expectedEvidence =
      expected ??
      (await (async () => {
        const inspection = await (options.hostDeps?.inspectHost ?? inspectStationHost)({
          socketPath,
          expectedBuildVersion: targetBuild.buildVersion,
        });
        if (inspection.status !== "exact") {
          throw new Error("Host evidence changed before exact convergence.");
        }
        return inspection.evidence;
      })());
    const command: StationHostConvergenceCommand =
      phase.action === "handoff"
        ? {
            action: "handoff",
            targetBuild,
            socketPath,
            expected: expectedEvidence,
            deadlineMs: Date.now() + 12_000,
            fidelity: phase.fidelity,
          }
        : {
            action: "replace-idle",
            targetBuild,
            socketPath,
            expected: expectedEvidence,
            deadlineMs: Date.now() + 12_000,
          };
    const result = await (options.hostDeps?.convergeHost ?? convergeStationHost)({
      command,
      targetBuild,
      socketPath,
      stateDir,
      hostCommand,
    });
    if (result.status === "failed") throw result.error;
    await (options.hostDeps?.recoverHostOrphans ?? recoverExactStationHostOrphans)({
      socketPath,
      stateDir,
      targetBuild,
      hostCommand,
    });
  };
}

async function inspectObserverRecoveryEvidence(input: {
  artifacts: { installed: UpdateArtifact; target: UpdateArtifact };
  currentBuildArtifact: UpdateArtifact;
  currentBuildIdentity: string;
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
      runningBuildIdentity: runningObserverBuild.buildIdentity,
      currentBuildArtifact: input.currentBuildArtifact,
      currentBuildIdentity: input.currentBuildIdentity,
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

function projectHostInspection(
  inspection: Awaited<ReturnType<typeof inspectStationHost>>,
  artifacts: { installed: UpdateArtifact; target: UpdateArtifact },
  currentBuildArtifact: UpdateArtifact,
  currentBuildIdentity: StationBuildIdentity,
): UpdateReapHostEvidence {
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
  const { health, buildIdentity, terminals } = inspection.evidence;
  const relation = runtimeBuildRelation({
    runningDisplayVersion: health.buildVersion,
    runningBuildIdentity: buildIdentity,
    currentBuildArtifact,
    currentBuildIdentity,
    artifacts,
  });
  return {
    status: "inspected",
    buildVersion: health.buildVersion,
    buildIdentity,
    protocolVersion: health.protocolVersion,
    relation,
    compatibility: health.buildVersion === artifacts.target.version ? "reuse" : "replace",
    terminals: terminals.map(redactedHostTerminal),
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
  currentBuildArtifact: UpdateArtifact;
  currentBuildIdentity: string;
  artifacts: { installed: UpdateArtifact; target: UpdateArtifact };
}): "matching-target" | "different" | "unknown" {
  if (input.runningDisplayVersion === undefined) return "unknown";
  if (input.runningDisplayVersion !== input.artifacts.target.version) return "different";
  if (input.runningBuildIdentity === undefined) return "unknown";
  if (!updateArtifactsMatch(input.currentBuildArtifact, input.artifacts.installed))
    return "unknown";
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
