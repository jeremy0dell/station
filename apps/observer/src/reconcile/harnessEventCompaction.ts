import type { HarnessEventObservation } from "@station/contracts";
import type { PersistedProviderObservation } from "../persistence/index.js";

/**
 * POLICY
 *
 * Selects admitted `working` harness events that the next admitted event of the same session
 * repeats with identical evidence, an equal or newer status time, and a strictly newer ordinal.
 * Replay, status overlays, and external run synthesis produce the same result without them, so
 * reconcile may delete them.
 *
 * `observations` must be admitted, unexpired events in replay order (observedAt, then id).
 */
export function supersededWorkingHarnessEventIds(
  observations: readonly PersistedProviderObservation[],
): string[] {
  const previousByScope = new Map<string, { id: string; event: HarnessEventObservation }>();
  const superseded: string[] = [];
  for (const observation of observations) {
    if (observation.entityKind !== "harness_event" || observation.expired) continue;
    const event = observation.payload;
    const scope = replayScope(observation.provider, event);
    const previous = previousByScope.get(scope);
    if (
      previous !== undefined &&
      event.status?.value === "working" &&
      previous.event.status?.value === "working" &&
      Date.parse(event.status.updatedAt) >= Date.parse(previous.event.status.updatedAt) &&
      // External run synthesis keeps the earlier of two events with equal ordinals.
      eventOrdinal(event) > eventOrdinal(previous.event) &&
      evidenceKey(observation.provider, event) === evidenceKey(observation.provider, previous.event)
    ) {
      superseded.push(previous.id);
    }
    previousByScope.set(scope, { id: observation.id, event });
  }
  return superseded;
}

// Replay folds events per provider and Station session; events without one are folded per evidence.
function replayScope(provider: string, event: HarnessEventObservation): string {
  return event.sessionId === undefined
    ? `evidence\u0000${evidenceKey(provider, event)}`
    : `session\u0000${provider}\u0000${event.sessionId}`;
}

// Every field that binding, readiness, recovery, or correlation reads, except report identity and times.
function evidenceKey(provider: string, event: HarnessEventObservation): string {
  return JSON.stringify([
    provider,
    event.provider,
    event.projectId,
    event.sessionId,
    event.worktreeId,
    event.terminalTargetId,
    event.harnessRunId,
    event.nativeSessionId,
    event.nativeSessionFile,
    event.cwd,
    event.pid,
    event.status?.value,
    event.status?.confidence,
    event.status?.source,
    event.turn,
  ]);
}

function eventOrdinal(event: HarnessEventObservation): number {
  const updatedAt = event.status === undefined ? 0 : Date.parse(event.status.updatedAt);
  return Math.max(updatedAt, Date.parse(event.observedAt));
}
