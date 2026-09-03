import type { StationHostExactEvidence } from "@station/contracts";
import {
  compareCodeUnitStrings,
  type ProviderHookHealth,
  ProviderHookHealthSchema,
  type ProviderHookReconciliationResult,
  type ProviderId,
  type SafeError,
  type UpdateArtifact,
  type UpdateReapHostEvidence,
  type UpdateReapObserverEvidence,
  type UpdateReapParkedBridgeEvidence,
  type UpdateReapRecoveryPreflight,
  UpdateReapRecoveryPreflightSchema,
  updateReapEvidenceIsComplete,
} from "@station/contracts";
import type { ExactObserverOwnershipEvidence } from "@station/observer/internal";
import { publicSafeErrorFromUnknown } from "@station/runtime";
import { deriveUpdateRecoveryTerminalDispositions } from "./recoveryTerminalDispositions.js";

/**
 * DRIVEN PORT
 *
 * Supplies already normalized, read-only runtime and provider evidence. Implementations must not
 * start, stop, signal, install, reconcile, resume, or otherwise mutate the inspected system.
 */
export type UpdateRecoveryPreflightPorts = {
  inspectObserver(artifacts: UpdateRecoveryArtifacts): Promise<UpdateReapObserverEvidence>;
  inspectHost(artifacts: UpdateRecoveryArtifacts): Promise<UpdateReapHostEvidence>;
  readHookHealth(provider: ProviderId): Promise<ProviderHookHealth>;
  hookProviderIds: readonly ProviderId[];
  /** Read-only parked-bridge viability; production composition always binds this capability. */
  preflightParkedBridges?: (
    artifacts: UpdateRecoveryArtifacts,
    host: UpdateReapHostEvidence,
  ) => Promise<UpdateReapParkedBridgeEvidence>;
  /** Keeps exact inspection facts private for the immediately following action commitment. */
  captureActionCommitments?: () => UpdateRecoveryPreflightActionCommitments;
};

export const updateRecoveryPreflightCommitments = Symbol("station.update.preflight.commitments");
export type UpdateRecoveryPreflightActionCommitments = Readonly<{
  observer?: ExactObserverOwnershipEvidence;
  host?: StationHostExactEvidence;
}>;

export type UpdateRecoveryArtifacts = {
  installed: UpdateArtifact;
  target: UpdateArtifact;
};

/**
 * USE CASE
 *
 * Aggregates read-only Observer, Host, retained-session, capability, handle, and hook facts while
 * settling every evidence source. It computes dispositions only; executable actions, authorization,
 * digests, and mutation remain downstream responsibilities.
 */
export async function runUpdateRecoveryPreflight(input: {
  installed: UpdateArtifact;
  target: UpdateArtifact;
  ports: UpdateRecoveryPreflightPorts;
}): Promise<UpdateReapRecoveryPreflight> {
  const artifacts = { installed: input.installed, target: input.target };
  const [observer, host] = await Promise.all([
    inspectObserver(input.ports, artifacts),
    inspectHost(input.ports, artifacts),
  ]);
  const hookProviderIds = providersForHookInspection(input.ports.hookProviderIds, observer);
  const hooks = await Promise.all(
    hookProviderIds.map((provider) => inspectHook(input.ports, provider)),
  );
  const parkedBridges = await inspectParkedBridges(input.ports, artifacts, host);
  const terminalDispositions = deriveUpdateRecoveryTerminalDispositions({ host, observer });
  const evidence = {
    observer,
    host,
    hookProviderIds,
    hooks,
    terminalDispositions,
    parkedBridges,
  };
  const preflight = UpdateReapRecoveryPreflightSchema.parse({
    schemaVersion: 1,
    boundary: {
      authorization: "none",
      actions: "not-included",
      digest: "not-included",
    },
    installed: input.installed,
    target: input.target,
    ...evidence,
    evidenceComplete: updateReapEvidenceIsComplete(evidence),
  });
  const commitments = input.ports.captureActionCommitments?.();
  if (commitments !== undefined) {
    Object.defineProperty(preflight, updateRecoveryPreflightCommitments, {
      value: commitments,
      enumerable: false,
    });
  }
  return preflight;
}

async function inspectParkedBridges(
  ports: UpdateRecoveryPreflightPorts,
  artifacts: UpdateRecoveryArtifacts,
  host: UpdateReapHostEvidence,
): Promise<UpdateReapParkedBridgeEvidence> {
  if (ports.preflightParkedBridges === undefined) {
    return {
      status: "assessed",
      totalParkedCount: 0,
      unownedParkedCount: 0,
      adoptionRequiredCount: 0,
    };
  }
  try {
    return await ports.preflightParkedBridges(artifacts, host);
  } catch (error) {
    return {
      status: "unknown",
      reason: "inspection-failed",
      error: redactedPreflightError(error, {
        code: "UPDATE_PREFLIGHT_PARKED_BRIDGE_INSPECTION_FAILED",
        message: "Parked bridge recovery viability could not be inspected.",
      }),
    };
  }
}

async function inspectObserver(
  ports: UpdateRecoveryPreflightPorts,
  artifacts: UpdateRecoveryArtifacts,
): Promise<UpdateReapObserverEvidence> {
  try {
    return await ports.inspectObserver(artifacts);
  } catch (error) {
    return {
      status: "unknown",
      reason: "inspection-failed",
      error: redactedPreflightError(error, {
        code: "UPDATE_PREFLIGHT_OBSERVER_INSPECTION_FAILED",
        message: "Observer recovery evidence could not be inspected.",
      }),
    };
  }
}

async function inspectHost(
  ports: UpdateRecoveryPreflightPorts,
  artifacts: UpdateRecoveryArtifacts,
): Promise<UpdateReapHostEvidence> {
  try {
    return await ports.inspectHost(artifacts);
  } catch (error) {
    return {
      status: "unknown",
      reason: "health-failed",
      error: redactedPreflightError(error, {
        code: "UPDATE_PREFLIGHT_HOST_INSPECTION_FAILED",
        message: "Host and terminal evidence could not be inspected.",
      }),
    };
  }
}

async function inspectHook(
  ports: UpdateRecoveryPreflightPorts,
  provider: ProviderId,
): Promise<ProviderHookHealth> {
  try {
    const health = ProviderHookHealthSchema.parse(await ports.readHookHealth(provider));
    if (health.provider !== provider) {
      throw new Error("Hook evidence provider did not match the requested provider.");
    }
    return health;
  } catch (error) {
    return {
      provider,
      status: "inspection-failed",
      error: redactedPreflightError(error, {
        code: "UPDATE_PREFLIGHT_HOOK_INSPECTION_FAILED",
        message: "Configured provider hooks could not be inspected.",
        provider,
      }),
      followUp: { action: "run-doctor" },
    };
  }
}

function providersForHookInspection(
  configured: readonly ProviderId[],
  observer: UpdateReapObserverEvidence,
): ProviderId[] {
  const providers = new Set<ProviderId>(configured);
  if (observer.status === "exact" && observer.recovery.status === "assessed") {
    for (const capability of observer.recovery.assessment.providerCapabilities) {
      providers.add(capability.provider);
    }
  }
  return Array.from(providers).sort(compareCodeUnitStrings);
}

export function redactedPreflightError(
  error: unknown,
  fallback: { code: string; message: string; provider?: ProviderId },
): SafeError {
  const normalized = publicSafeErrorFromUnknown(error, {
    tag: "UpdatePreflightError",
    code: fallback.code,
    message: fallback.message,
    ...(fallback.provider === undefined ? {} : { provider: fallback.provider }),
  });
  const safe: SafeError = {
    tag: "UpdatePreflightError",
    code: fallback.code,
    message: fallback.message,
  };
  if (fallback.provider !== undefined) safe.provider = fallback.provider;
  if (normalized.traceId !== undefined) safe.traceId = normalized.traceId;
  if (normalized.diagnosticId !== undefined) safe.diagnosticId = normalized.diagnosticId;
  return safe;
}

export function updateRecoveryActionCommitments(
  preflight: UpdateReapRecoveryPreflight,
): UpdateRecoveryPreflightActionCommitments {
  return (
    (
      preflight as UpdateReapRecoveryPreflight & {
        [updateRecoveryPreflightCommitments]?: UpdateRecoveryPreflightActionCommitments;
      }
    )[updateRecoveryPreflightCommitments] ?? {}
  );
}

export function updateHookSuccessFromHealth(
  health: ProviderHookHealth,
): ProviderHookReconciliationResult {
  switch (health.status) {
    case "configured-disabled":
      return {
        provider: health.provider,
        status: health.status,
        changed: false,
        verified: false,
        followUp: health.followUp,
      };
    case "unsupported":
      return { provider: health.provider, status: health.status, changed: false, verified: false };
    case "healthy":
      return { provider: health.provider, status: health.status, changed: false, verified: true };
    case "needs-repair":
      throw new Error(`Provider hook ${health.provider} still needs repair.`);
    case "ownership-conflict":
    case "inspection-failed":
      throw updateHookError(health);
  }
}

export function updateHookError(
  value: ProviderHookHealth | ProviderHookReconciliationResult | undefined,
): Error {
  if (value === undefined) return new Error("Provider hook evidence is missing.");
  switch (value.status) {
    case "ownership-conflict":
      return new Error(`Provider hook ${value.provider} is owned by another installation.`);
    case "inspection-failed":
    case "write-failed":
    case "post-write-doctor-failed":
      return new Error(value.error.message);
    case "needs-repair":
      return new Error(`Provider hook ${value.provider} needs repair.`);
    default:
      return new Error(`Provider hook ${value.provider} reconciliation failed.`);
  }
}
