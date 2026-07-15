import type {
  HarnessEventObservation,
  HarnessRunObservation,
  ObservedStatus,
} from "@station/contracts";
import { correlateHarnessExecution } from "../harnessExecutionIdentity.js";
import type { PersistedProviderObservation } from "../persistence/index.js";

export type ObserverHarnessRun = {
  run: HarnessRunObservation;
  status: ObservedStatus;
};

type StatusOverlay = {
  status: ObservedStatus;
  observedAt: string;
  observationId: string;
};

export function observerHarnessRunFromRun(run: HarnessRunObservation): ObserverHarnessRun {
  return {
    run,
    status: {
      value: run.state,
      confidence: run.confidence,
      reason: run.reason,
      source: "harness_process",
      updatedAt: run.observedAt,
    },
  };
}

export function externalHarnessRunId(provider: string, nativeSessionId: string): string {
  // nativeSessionId is untrusted (straight from the hook payload); encode both
  // parts so a value containing ':' or 'external:' cannot collide with another
  // session's id or shadow it.
  return `${encodeURIComponent(provider)}:external:${encodeURIComponent(nativeSessionId)}`;
}

/**
 * Mint runs for sessions Station did not launch. Their hook events carry only
 * native identity plus a cwd-resolved worktree — no station sessionId and no
 * harnessRunId — so provider discovery never surfaces them and their status
 * had nowhere to land. One run per (provider, native session), carrying the
 * newest observed status; ended sessions (exited) synthesize nothing, so an
 * external run disappears from rows once its session ends.
 */
export function synthesizeExternalHarnessRuns(input: {
  runs: ObserverHarnessRun[];
  observations: PersistedProviderObservation[];
}): ObserverHarnessRun[] {
  const existingIds = new Set(input.runs.map((run) => run.run.id));
  const latestById = new Map<string, HarnessEventObservation>();
  // Any exited observation retires the session for good; tracked separately so
  // event reordering (updatedAt vs ingest observedAt divergence, out-of-order
  // delivery) can't let a surviving `working` event resurrect an ended run.
  const endedIds = new Set<string>();

  for (const observation of input.observations) {
    if (observation.expired || observation.entityKind !== "harness_event") {
      continue;
    }
    const event = observation.payload;
    if (event.provider !== observation.provider) {
      continue;
    }
    // Station-launched sessions carry station identity (session, run, or
    // terminal target); their runs come from provider discovery and must not
    // be duplicated here.
    if (
      event.sessionId !== undefined ||
      event.harnessRunId !== undefined ||
      event.terminalTargetId !== undefined
    ) {
      continue;
    }
    if (event.nativeSessionId === undefined || event.worktreeId === undefined) {
      continue;
    }
    if (event.status === undefined) {
      continue;
    }
    const id = externalHarnessRunId(event.provider, event.nativeSessionId);
    if (event.status.value === "exited") {
      endedIds.add(id);
      continue;
    }
    if (event.status.value === "unknown") {
      continue;
    }
    if (existingIds.has(id)) {
      continue;
    }
    const previous = latestById.get(id);
    // Rank by the strongest available timestamp so a freshly-ingested but
    // clock-lagged event is not passed over.
    if (previous?.status !== undefined && eventOrdinal(previous) >= eventOrdinal(event)) {
      continue;
    }
    latestById.set(id, event);
  }

  const synthesized: ObserverHarnessRun[] = [];
  for (const [id, event] of latestById) {
    const status = event.status;
    const worktreeId = event.worktreeId;
    const nativeSessionId = event.nativeSessionId;
    if (status === undefined || worktreeId === undefined || nativeSessionId === undefined) {
      continue;
    }
    if (endedIds.has(id)) {
      continue;
    }
    synthesized.push({
      run: {
        id,
        provider: event.provider,
        worktreeId,
        nativeSessionId,
        state: status.value,
        confidence: status.confidence,
        reason: status.reason,
        observedAt: event.observedAt,
      },
      status,
    });
  }
  return [...input.runs, ...synthesized];
}

// A busy status is a claim that signals are still flowing. A run whose newest
// signal is older than this window has gone dark — harness killed mid-turn,
// hooks undelivered, stale ingress — and must not read as active forever;
// unknown is the honest projection and the next real event restores truth.
// Attention states are exempt: a question legitimately waits on the user.
const BUSY_STATUS_DECAY_MS = 15 * 60 * 1000;
const BUSY_STATUS_VALUES = new Set<ObservedStatus["value"]>(["working", "starting"]);

export function decayStaleBusyStatuses(input: {
  runs: ObserverHarnessRun[];
  now: string;
}): ObserverHarnessRun[] {
  const cutoff = Date.parse(input.now) - BUSY_STATUS_DECAY_MS;
  if (!Number.isFinite(cutoff)) {
    return input.runs;
  }
  return input.runs.map((run) => {
    if (!BUSY_STATUS_VALUES.has(run.status.value)) {
      return run;
    }
    const updatedAt = Date.parse(run.status.updatedAt);
    if (!Number.isFinite(updatedAt) || updatedAt >= cutoff) {
      return run;
    }
    const decayed: ObservedStatus = {
      value: "unknown",
      confidence: "low",
      reason: `No ${run.run.provider} signals since ${run.status.updatedAt}; the run may have ended without reporting.`,
      source: "reconcile",
      // Keep the last-signal timestamp so repeated reconciles project this
      // exact status instead of minting a fresh one per pass.
      updatedAt: run.status.updatedAt,
    };
    return {
      run: runObservationWithStatus(run.run, decayed),
      status: decayed,
    };
  });
}

export function applyHarnessEventStatusOverlays(input: {
  runs: ObserverHarnessRun[];
  observations: PersistedProviderObservation[];
}): ObserverHarnessRun[] {
  const latestByRunId = new Map<string, StatusOverlay>();

  for (const observation of input.observations) {
    if (observation.expired || observation.entityKind !== "harness_event") {
      continue;
    }

    const event = observation.payload;
    if (event.provider !== observation.provider) continue;
    if (event.status === undefined || event.status.value === "unknown") continue;

    const match = correlateHarnessExecution({
      evidence: event,
      runs: input.runs.map((run) => run.run),
      allowNativeBinding: false,
    });
    if (match === undefined) continue;

    const currentRun = input.runs.find((run) => run.run.id === match.run.id);
    if (currentRun === undefined || shouldPreserveLiveStatus(currentRun, event.status)) continue;

    const overlay: StatusOverlay = {
      status: event.status,
      observedAt: observation.observedAt,
      observationId: observation.id,
    };
    const previous = latestByRunId.get(match.run.id);
    if (previous === undefined || compareOverlays(overlay, previous) >= 0) {
      latestByRunId.set(match.run.id, overlay);
    }
  }

  return input.runs.map((run) => {
    const overlay = latestByRunId.get(run.run.id);
    return overlay === undefined ? run : applyStatusOverlay(run, overlay);
  });
}

// The strongest available ordering timestamp: the harness-assigned status time,
// or the ingest time when that is later, so a clock-lagged event is not ranked
// behind an older one.
function eventOrdinal(event: HarnessEventObservation): number {
  const updated = event.status === undefined ? 0 : Date.parse(event.status.updatedAt);
  const observed = Date.parse(event.observedAt);
  return Math.max(Number.isFinite(updated) ? updated : 0, Number.isFinite(observed) ? observed : 0);
}

function shouldPreserveLiveStatus(run: ObserverHarnessRun, status: ObservedStatus): boolean {
  if (run.status.value !== "exited" || run.status.confidence !== "high") {
    return false;
  }
  return Date.parse(status.updatedAt) < Date.parse(run.status.updatedAt);
}

function applyStatusOverlay(run: ObserverHarnessRun, overlay: StatusOverlay): ObserverHarnessRun {
  const nextRun = runObservationWithStatus(run.run, overlay.status);
  return {
    run: nextRun,
    status: overlay.status,
  };
}

function runObservationWithStatus(
  run: HarnessRunObservation,
  status: ObservedStatus,
): HarnessRunObservation {
  const nextRun: HarnessRunObservation = {
    id: run.id,
    provider: run.provider,
    state: status.value,
    confidence: status.confidence,
    reason: status.reason,
    observedAt: run.observedAt,
  };
  if (run.projectId !== undefined) nextRun.projectId = run.projectId;
  if (run.worktreeId !== undefined) nextRun.worktreeId = run.worktreeId;
  if (run.sessionId !== undefined) nextRun.sessionId = run.sessionId;
  if (run.nativeSessionId !== undefined) nextRun.nativeSessionId = run.nativeSessionId;
  if (run.pid !== undefined) nextRun.pid = run.pid;
  if (run.cwd !== undefined) nextRun.cwd = run.cwd;
  if (run.providerData !== undefined) nextRun.providerData = run.providerData;
  return nextRun;
}

function compareOverlays(left: StatusOverlay, right: StatusOverlay): number {
  return (
    Date.parse(left.status.updatedAt) - Date.parse(right.status.updatedAt) ||
    Date.parse(left.observedAt) - Date.parse(right.observedAt) ||
    left.observationId.localeCompare(right.observationId)
  );
}
