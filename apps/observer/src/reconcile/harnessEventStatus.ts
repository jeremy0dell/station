import type {
  HarnessEventObservation,
  HarnessRunObservation,
  ObservedStatus,
} from "@station/contracts";
import { HarnessEventObservationSchema } from "@station/contracts";
import type { PersistedProviderObservation } from "../persistence/index.js";

export type ObserverHarnessRun = {
  run: HarnessRunObservation;
  status: ObservedStatus;
};

type CorrelatedBy = "harnessRunId" | "sessionId" | "worktreeId";

type StatusOverlay = {
  status: ObservedStatus;
  rawEventType?: string;
  correlatedBy: CorrelatedBy;
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

export function applyHarnessEventStatusOverlays(input: {
  runs: ObserverHarnessRun[];
  observations: PersistedProviderObservation[];
}): ObserverHarnessRun[] {
  const latestByRunId = new Map<string, StatusOverlay>();

  for (const observation of input.observations) {
    if (observation.expired || observation.entityKind !== "harness_event") {
      continue;
    }

    const event = parseHarnessEventObservation(observation);
    if (event === undefined || event.provider !== observation.provider) {
      continue;
    }
    if (event.status === undefined || event.status.value === "unknown") {
      continue;
    }

    const match = correlateHarnessEvent(event, input.runs);
    if (match === undefined || shouldPreserveLiveStatus(match.run, event.status)) {
      continue;
    }

    const overlay: StatusOverlay = {
      status: event.status,
      correlatedBy: match.correlatedBy,
      observedAt: observation.observedAt,
      observationId: observation.id,
    };
    if (event.rawEventType !== undefined) {
      overlay.rawEventType = event.rawEventType;
    }

    const previous = latestByRunId.get(match.run.run.id);
    if (previous === undefined || compareOverlays(overlay, previous) >= 0) {
      latestByRunId.set(match.run.run.id, overlay);
    }
  }

  return input.runs.map((run) => {
    const overlay = latestByRunId.get(run.run.id);
    if (overlay === undefined) {
      return run;
    }
    return applyStatusOverlay(run, overlay);
  });
}

function parseHarnessEventObservation(
  observation: PersistedProviderObservation,
): HarnessEventObservation | undefined {
  const result = HarnessEventObservationSchema.safeParse(observation.payload);
  if (!result.success) {
    return undefined;
  }
  return result.data;
}

function correlateHarnessEvent(
  event: HarnessEventObservation,
  runs: ObserverHarnessRun[],
): { run: ObserverHarnessRun; correlatedBy: CorrelatedBy } | undefined {
  const providerRuns = runs.filter((run) => run.run.provider === event.provider);

  if (event.harnessRunId !== undefined) {
    const matches = providerRuns.filter((run) => run.run.id === event.harnessRunId);
    return singleCorrelation(matches, "harnessRunId");
  }

  if (event.sessionId !== undefined) {
    const matches = providerRuns.filter((run) => run.run.sessionId === event.sessionId);
    return singleCorrelation(matches, "sessionId");
  }

  if (event.worktreeId !== undefined) {
    const matches = providerRuns.filter((run) => run.run.worktreeId === event.worktreeId);
    return singleCorrelation(matches, "worktreeId");
  }

  return undefined;
}

function singleCorrelation(
  matches: ObserverHarnessRun[],
  correlatedBy: CorrelatedBy,
): { run: ObserverHarnessRun; correlatedBy: CorrelatedBy } | undefined {
  const run = matches[0];
  if (matches.length !== 1 || run === undefined) {
    return undefined;
  }
  return { run, correlatedBy };
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
