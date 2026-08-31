import type {
  HarnessEventObservation,
  HarnessRunObservation,
  SessionRecoveryHandle,
} from "@station/contracts";
import {
  bindHarnessRunsToSessionExecutions,
  decideSessionHarnessExecution,
  sessionHarnessExecutionEvidenceFromObservation,
} from "../harnessExecutionIdentity.js";
import { sessionRecoveryHandleFromObservation } from "../harnessRecoveryHandle.js";
import { sessionTurnReadinessMutationFromHarnessObservation } from "../hooks/turnReadiness.js";
import type {
  ObservationStore,
  PersistedProviderObservation,
  PersistedSessionHarnessExecution,
  PersistedSessionTurnReadiness,
  SessionHarnessDerivedStateRepair,
  SessionStore,
} from "../persistence/index.js";
import type { ProviderRegistry } from "../providers/registry.js";
import {
  applyHarnessEventStatusOverlays,
  synthesizeExternalHarnessRuns,
} from "./harnessEventStatus.js";

type ReconcileHarnessPersistence = ObservationStore & SessionStore;

/**
 * Applies admitted persisted harness events to discovered runs after durable bindings are attached.
 */
export async function harnessRunsWithPersistedEventStatus(input: {
  persistence?: ReconcileHarnessPersistence;
  providers: ProviderRegistry;
  harnessRuns: HarnessRunObservation[];
  now: string;
}): Promise<HarnessRunObservation[]> {
  if (input.persistence === undefined) {
    return input.harnessRuns;
  }

  const persisted = await input.persistence.listProviderObservations({
    entityKind: "harness_event",
    now: input.now,
  });
  const { observations } = admitPersistedHarnessEvents(input.providers, persisted);
  const bindings = await input.persistence.listSessionHarnessExecutions();
  const runsWithBindings = bindHarnessRunsToSessionExecutions({
    runs: input.harnessRuns,
    bindings,
  });
  return applyHarnessEventStatusOverlays({
    runs: synthesizeExternalHarnessRuns({ runs: runsWithBindings, observations }),
    observations,
  });
}

/**
 * Repairs provider-incompatible histories and provisional startup ownership before current
 * reconcile state is assembled.
 */
export async function repairPersistedHarnessDerivedState(input: {
  persistence: ReconcileHarnessPersistence;
  providers: ProviderRegistry;
  now: string;
}): Promise<void> {
  const [persisted, bindings, readiness] = await Promise.all([
    input.persistence.listProviderObservations({
      entityKind: "harness_event",
      includeExpired: true,
      now: input.now,
    }),
    input.persistence.listSessionHarnessExecutions(),
    input.persistence.listSessionTurnReadiness(),
  ]);
  const { observations, rejectedBySession } = admitPersistedHarnessEvents(
    input.providers,
    persisted,
  );
  const currentObservations = observations.filter((observation) => !observation.expired);
  const repairTargets = new Map<string, HarnessDerivedStateRepairTarget>();
  for (const rejected of rejectedBySession.values()) {
    const currentBinding = bindings.find(
      (binding) =>
        binding.provider === rejected.provider && binding.sessionId === rejected.sessionId,
    );
    const currentReadiness = readiness.find(
      (candidate) => candidate.sessionId === rejected.sessionId,
    );
    if (
      derivedStateSupersedesRejectedEvent({
        binding: currentBinding,
        readiness: currentReadiness,
        rejectedAt: rejected.latestStatusUpdatedAt,
      })
    ) {
      continue;
    }
    const key = sessionRepairKey(rejected.provider, rejected.sessionId);
    repairTargets.set(key, {
      provider: rejected.provider,
      sessionId: rejected.sessionId,
      repairCompatibility: true,
    });
  }
  for (const binding of bindings) {
    if (binding.state !== "starting") continue;
    const key = sessionRepairKey(binding.provider, binding.sessionId);
    const current = repairTargets.get(key);
    repairTargets.set(key, {
      provider: binding.provider,
      sessionId: binding.sessionId,
      repairCompatibility: current?.repairCompatibility ?? false,
      provisionalBinding: binding,
    });
  }
  for (const target of repairTargets.values()) {
    const replay = replayAcceptedSessionState({
      observations: currentObservations,
      provider: target.provider,
      sessionId: target.sessionId,
    });
    const promotesProvisionalBinding =
      target.provisionalBinding !== undefined &&
      replay.harnessExecution !== undefined &&
      replay.harnessExecution.nativeSessionId !== target.provisionalBinding.nativeSessionId;
    if (!target.repairCompatibility && !promotesProvisionalBinding) continue;

    // Recovery evidence is additive and idempotent. Persist it first so an interrupted repair
    // leaves the provisional binding eligible for the same replay on the next reconcile.
    if (replay.recoveryHandle !== undefined) {
      await input.persistence.upsertSessionRecoveryHandle(replay.recoveryHandle);
    }
    const repair: SessionHarnessDerivedStateRepair = {
      provider: target.provider,
      sessionId: target.sessionId,
    };
    if (replay.harnessExecution !== undefined) {
      repair.harnessExecution = replay.harnessExecution;
    }
    if (replay.turnReadiness !== undefined) {
      repair.turnReadiness = replay.turnReadiness;
    }
    await input.persistence.repairSessionHarnessDerivedState(repair);
  }
}

/**
 * Admits legacy observations except provider-explicitly rejected events and records their repair keys.
 */
export function admitPersistedHarnessEvents(
  providers: ProviderRegistry,
  observations: PersistedProviderObservation[],
): {
  observations: PersistedProviderObservation[];
  rejectedBySession: Map<string, RejectedPersistedSession>;
} {
  const accepted: PersistedProviderObservation[] = [];
  const rejectedBySession = new Map<string, RejectedPersistedSession>();
  for (const observation of observations) {
    if (observation.entityKind !== "harness_event") continue;
    const provider = providers.harnesses.get(observation.provider);
    if (provider?.acceptsPersistedEvent?.(observation.payload) !== false) {
      accepted.push(observation);
      continue;
    }
    const sessionId = observation.payload.sessionId;
    if (sessionId === undefined) continue;
    const key = `${observation.provider}\u0000${sessionId}`;
    const latestStatusUpdatedAt = observation.payload.status?.updatedAt ?? observation.observedAt;
    const current = rejectedBySession.get(key);
    if (
      current === undefined ||
      Date.parse(latestStatusUpdatedAt) >= Date.parse(current.latestStatusUpdatedAt)
    ) {
      rejectedBySession.set(key, {
        provider: observation.provider,
        sessionId,
        latestStatusUpdatedAt,
      });
    }
  }
  return { observations: accepted, rejectedBySession };
}

export type RejectedPersistedSession = {
  provider: string;
  sessionId: string;
  latestStatusUpdatedAt: string;
};

/**
 * Determines whether newer durable binding or readiness state supersedes a rejected event repair.
 */
export function derivedStateSupersedesRejectedEvent(input: {
  binding: PersistedSessionHarnessExecution | undefined;
  readiness: PersistedSessionTurnReadiness | undefined;
  rejectedAt: string;
}): boolean {
  const rejectedAt = Date.parse(input.rejectedAt);
  if (!Number.isFinite(rejectedAt)) return false;
  return [input.binding?.statusUpdatedAt, input.readiness?.completedAt].some((value) => {
    if (value === undefined) return false;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && timestamp > rejectedAt;
  });
}

/**
 * Replays admitted session events into the durable binding and readiness states used for repair.
 */
export function replayAcceptedSessionState(input: {
  observations: PersistedProviderObservation[];
  provider: string;
  sessionId: string;
}): {
  harnessExecution?: PersistedSessionHarnessExecution;
  recoveryHandle?: SessionRecoveryHandle;
  turnReadiness?: PersistedSessionTurnReadiness;
} {
  let harnessExecution: PersistedSessionHarnessExecution | undefined;
  let recoveryHandle: SessionRecoveryHandle | undefined;
  let turnReadiness: PersistedSessionTurnReadiness | undefined;
  for (const observation of input.observations) {
    if (
      observation.entityKind !== "harness_event" ||
      observation.provider !== input.provider ||
      observation.payload.sessionId !== input.sessionId
    ) {
      continue;
    }
    const event: HarnessEventObservation = observation.payload;
    const decision = decideSessionHarnessExecution({
      current: harnessExecution,
      evidence: sessionHarnessExecutionEvidenceFromObservation(event),
    });
    if (decision.binding !== undefined) {
      harnessExecution = decision.binding;
    }
    if (!decision.mayDeriveState) continue;
    const observedRecoveryHandle = sessionRecoveryHandleFromObservation(event, observation.id);
    if (observedRecoveryHandle !== undefined) {
      recoveryHandle = observedRecoveryHandle;
    }
    const mutation = sessionTurnReadinessMutationFromHarnessObservation({
      observation: event,
      updatedAt: observation.observedAt,
    });
    if (mutation?.action === "upsert") {
      turnReadiness = {
        ...mutation.value,
        createdAt: observation.observedAt,
      };
    } else if (mutation?.action === "delete") {
      turnReadiness = undefined;
    }
  }
  const replay: {
    harnessExecution?: PersistedSessionHarnessExecution;
    recoveryHandle?: SessionRecoveryHandle;
    turnReadiness?: PersistedSessionTurnReadiness;
  } = {};
  if (harnessExecution !== undefined) replay.harnessExecution = harnessExecution;
  if (harnessExecution !== undefined && recoveryHandle !== undefined) {
    replay.recoveryHandle = recoveryHandle;
  }
  if (turnReadiness !== undefined) replay.turnReadiness = turnReadiness;
  return replay;
}

type HarnessDerivedStateRepairTarget = {
  provider: string;
  sessionId: string;
  repairCompatibility: boolean;
  provisionalBinding?: PersistedSessionHarnessExecution;
};

function sessionRepairKey(provider: string, sessionId: string): string {
  return `${provider}\u0000${sessionId}`;
}
