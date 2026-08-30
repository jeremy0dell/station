import type { StationConfig } from "@station/config";
import {
  compareCodeUnitStrings,
  type ObserverRecoveryAssessment,
  ObserverRecoveryAssessmentSchema,
  type ObserverSessionRecoveryAssessment,
  type ProviderResumeCapability,
  type SessionRecoveryAssessmentReason,
  type StationSnapshot,
} from "@station/contracts";
import type { SessionStore } from "../persistence/ports.js";
import type {
  ObserverRecoveryInventoryPersistenceSnapshot,
  PersistedSession,
} from "../persistence/types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import {
  type SessionRecoveryEligibility,
  type SessionRecoveryEligibilityInput,
  sessionRecoveryEligibility,
} from "./eligibility.js";
import { observerRecoveryInventoryFromPersistence } from "./inventory.js";
import { selectNewestSessionRecoveryCandidate } from "./selection.js";

type RecoveryAssessmentProviders = Pick<ProviderRegistry, "harnesses">;
type RecoveryAssessmentConfig = Pick<StationConfig, "featureFlags" | "harness">;

/**
 * USE CASE
 *
 * Assesses all retained sessions from exactly one coherent persistence inventory against one
 * caller-captured Observer graph. Eligibility and newest-candidate selection remain delegated to
 * their canonical policies; the result is redacted evidence only and grants no resume authority.
 */
export async function inspectObserverRecoveryAssessment(input: {
  graph: StationSnapshot;
  persistence: Pick<SessionStore, "readRecoveryInventory">;
  providers?: RecoveryAssessmentProviders;
  config?: RecoveryAssessmentConfig;
}): Promise<ObserverRecoveryAssessment> {
  const persistenceSnapshot = await input.persistence.readRecoveryInventory();
  return assessObserverRecovery({
    graph: input.graph,
    persistenceSnapshot,
    ...(input.providers === undefined ? {} : { providers: input.providers }),
    ...(input.config === undefined ? {} : { config: input.config }),
  });
}

/** Pure assessment over already captured graph and persistence evidence. */
export function assessObserverRecovery(input: {
  graph: StationSnapshot;
  persistenceSnapshot: ObserverRecoveryInventoryPersistenceSnapshot;
  providers?: RecoveryAssessmentProviders;
  config?: RecoveryAssessmentConfig;
}): ObserverRecoveryAssessment {
  const inventory = observerRecoveryInventoryFromPersistence(input.persistenceSnapshot);
  const resumeEnabled = input.config?.featureFlags?.sessionResumeAgent === true;
  const providerIds = new Set<string>();
  for (const session of input.persistenceSnapshot.sessions) {
    if (session.harness !== undefined) providerIds.add(session.harness);
  }
  for (const handle of input.persistenceSnapshot.recoveryHandles) providerIds.add(handle.provider);
  const providerCapabilities = Array.from(providerIds)
    .sort(compareCodeUnitStrings)
    .map((provider) => normalizeProviderCapability(input, provider));
  const sessions = input.persistenceSnapshot.sessions
    .map((session) => assessSession(input, session, resumeEnabled))
    .sort((left, right) => compareCodeUnitStrings(left.sessionId, right.sessionId));
  return ObserverRecoveryAssessmentSchema.parse({
    schemaVersion: 1,
    inventory,
    resumeEnabled,
    providerCapabilities,
    sessions,
  });
}

function assessSession(
  input: Parameters<typeof assessObserverRecovery>[0],
  session: PersistedSession,
  resumeEnabled: boolean,
): ObserverSessionRecoveryAssessment {
  const handles = input.persistenceSnapshot.recoveryHandles.filter(
    (handle) => handle.projectId === session.projectId && handle.worktreeId === session.worktreeId,
  );
  const base = sessionAssessmentBase(session);
  if (session.lifecycle === "ended" || session.endedAt !== undefined) {
    return {
      ...base,
      disposition: "not-applicable",
      reasons: ["station_session_ended"],
      handleResolution: {
        kind: "none",
        eligibleHandleCount: 0,
        rejectedHandleCount: handles.length,
        reasons: sortedReasons([
          "station_session_ended",
          ...(handles.length === 0 ? (["no_recovery_handles"] as const) : []),
        ]),
      },
    };
  }

  const worktree = input.graph.rows.find(
    (row) => row.id === session.worktreeId && row.projectId === session.projectId,
  );
  if (worktree === undefined) {
    return {
      ...base,
      disposition: "unknown",
      reasons: ["worktree_evidence_missing"],
      handleResolution: { kind: "unknown", reasons: ["worktree_evidence_missing"] },
    };
  }

  if (session.harness === undefined) {
    return {
      ...base,
      disposition: "non-resumable",
      reasons: ["harness_mismatch"],
      handleResolution: {
        kind: "none",
        eligibleHandleCount: 0,
        rejectedHandleCount: handles.length,
        reasons: sortedReasons([
          "harness_mismatch",
          ...(handles.length === 0 ? (["no_recovery_handles"] as const) : []),
        ]),
      },
    };
  }
  const harnessProvider = session.harness;

  const evaluated = handles.map((handle) => ({
    handle,
    eligibility: evaluateHandle(input.providers, input.persistenceSnapshot.sessions, {
      handle,
      projectId: session.projectId,
      worktreeId: session.worktreeId,
      worktreePath: worktree.path,
      expectedSession: { id: session.id, harness: harnessProvider },
    }),
  }));
  const eligible = evaluated.flatMap((candidate) =>
    candidate.eligibility.kind === "eligible" ? [candidate] : [],
  );
  const rejectedReasons = sortedReasons(
    evaluated.flatMap((candidate) =>
      candidate.eligibility.kind === "ineligible" ? [candidate.eligibility.reason] : [],
    ),
  );
  const selected = selectNewestSessionRecoveryCandidate(eligible);
  const capabilityReason = capabilityReasonFor(normalizeProviderCapability(input, harnessProvider));
  const blockingReasons = sortedReasons([
    ...(!resumeEnabled ? (["global_resume_disabled"] as const) : []),
    ...(capabilityReason === undefined ? [] : [capabilityReason]),
    ...(selected === undefined
      ? rejectedReasons.length === 0
        ? (["no_recovery_handles"] as const)
        : rejectedReasons
      : []),
  ]);
  if (selected === undefined) {
    return {
      ...base,
      disposition: "non-resumable",
      reasons: blockingReasons,
      handleResolution: {
        kind: "none",
        eligibleHandleCount: 0,
        rejectedHandleCount: evaluated.length,
        reasons: rejectedReasons.length === 0 ? ["no_recovery_handles"] : rejectedReasons,
      },
    };
  }
  return {
    ...base,
    disposition: blockingReasons.length === 0 ? "recoverable" : "non-resumable",
    reasons: blockingReasons,
    handleResolution: {
      kind: "selected",
      selectedHandleId: selected.handle.id,
      eligibleHandleCount: eligible.length,
      rejectedHandleCount: evaluated.length - eligible.length,
      rejectedReasons,
    },
  };
}

function sessionAssessmentBase(
  session: PersistedSession,
): Pick<
  ObserverSessionRecoveryAssessment,
  "sessionId" | "projectId" | "worktreeId" | "lifecycle" | "harnessProvider"
> {
  const result: ReturnType<typeof sessionAssessmentBase> = {
    sessionId: session.id,
    projectId: session.projectId,
    worktreeId: session.worktreeId,
    lifecycle: session.lifecycle,
  };
  if (session.harness !== undefined) result.harnessProvider = session.harness;
  return result;
}

function evaluateHandle(
  providers: RecoveryAssessmentProviders | undefined,
  sessions: readonly PersistedSession[],
  input: Pick<
    SessionRecoveryEligibilityInput,
    "handle" | "projectId" | "worktreeId" | "worktreePath" | "expectedSession"
  >,
): SessionRecoveryEligibility {
  const registeredProvider = providers?.harnesses.get(input.handle.provider);
  const eligibilityInput: SessionRecoveryEligibilityInput = {
    ...input,
    stationSessions: sessions,
    allowNoLocalSession: false,
  };
  if (registeredProvider !== undefined) {
    eligibilityInput.registeredHarness = {
      id: registeredProvider.id,
      canResume: registeredProvider.capabilities().canResume,
    };
  }
  return sessionRecoveryEligibility(eligibilityInput);
}

function normalizeProviderCapability(
  input: Parameters<typeof assessObserverRecovery>[0],
  providerId: string,
): ProviderResumeCapability {
  const provider = input.providers?.harnesses.get(providerId);
  if (provider === undefined) return { provider: providerId, status: "missing" };
  const configuredResume = input.config?.harness?.[providerId]?.resume;
  if (configuredResume === false) return { provider: providerId, status: "disabled" };
  if (!provider.capabilities().canResume) {
    return {
      provider: providerId,
      status: configuredResume === true ? "unsupported" : "disabled",
    };
  }
  return { provider: providerId, status: "enabled" };
}

function capabilityReasonFor(
  capability: ProviderResumeCapability,
): SessionRecoveryAssessmentReason | undefined {
  switch (capability.status) {
    case "enabled":
      return undefined;
    case "disabled":
      return "provider_resume_disabled";
    case "unsupported":
      return "harness_resume_unsupported";
    case "missing":
      return "harness_provider_missing";
  }
}

function sortedReasons(
  reasons: readonly SessionRecoveryAssessmentReason[],
): SessionRecoveryAssessmentReason[] {
  return Array.from(new Set(reasons)).sort(compareCodeUnitStrings);
}
