import {
  compareCodeUnitStrings,
  compareUpdateReapTerminalIdentity,
  type ProviderHookHealth,
  ProviderHookHealthSchema,
  type ProviderId,
  type SafeError,
  type UpdateArtifact,
  type UpdateReapHostEvidence,
  type UpdateReapObserverEvidence,
  type UpdateReapRecoveryPreflight,
  UpdateReapRecoveryPreflightSchema,
  updateReapEvidenceIsComplete,
} from "@station/contracts";
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
};

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
  const terminalDispositions = deriveUpdateRecoveryTerminalDispositions({ host, observer });
  const evidence = {
    observer,
    host,
    hookProviderIds,
    hooks,
    terminalDispositions,
  };
  return UpdateReapRecoveryPreflightSchema.parse({
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
    const host = await ports.inspectHost(artifacts);
    return host.status === "inspected"
      ? { ...host, terminals: [...host.terminals].sort(compareUpdateReapTerminalIdentity) }
      : host;
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
