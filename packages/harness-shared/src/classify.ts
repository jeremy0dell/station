import type {
  HarnessRunObservation,
  HarnessStatusObservation,
  ProviderId,
} from "@station/contracts";

export type ClassifyHarnessRunStatusOptions = {
  provider: ProviderId;
  fallbackReason: string;
  exitedSource?: "harness_event" | "harness_process";
  needsAttention?: boolean;
};

export function classifyHarnessRunStatus(
  run: HarnessRunObservation,
  options: ClassifyHarnessRunStatusOptions,
): HarnessStatusObservation {
  if (
    options.needsAttention !== false &&
    run.state === "needs_attention" &&
    run.confidence === "high"
  ) {
    return buildObservation(run, options.provider, {
      value: "needs_attention",
      confidence: "high",
      reason: run.reason,
      source: "harness_event",
      updatedAt: run.observedAt,
    });
  }

  if (run.state === "exited" && run.confidence === "high") {
    return buildObservation(run, options.provider, {
      value: "exited",
      confidence: "high",
      reason: run.reason,
      source: options.exitedSource ?? "harness_process",
      updatedAt: run.observedAt,
    });
  }

  return buildObservation(run, options.provider, {
    value: "unknown",
    confidence: "low",
    reason: options.fallbackReason,
    source: "harness_process",
    updatedAt: run.observedAt,
  });
}

function buildObservation(
  run: HarnessRunObservation,
  provider: ProviderId,
  status: HarnessStatusObservation["status"],
): HarnessStatusObservation {
  const observation: HarnessStatusObservation = {
    provider,
    runId: run.id,
    status,
    observedAt: status.updatedAt,
  };
  if (run.projectId !== undefined) {
    observation.projectId = run.projectId;
  }
  if (run.worktreeId !== undefined) {
    observation.worktreeId = run.worktreeId;
  }
  if (run.sessionId !== undefined) {
    observation.sessionId = run.sessionId;
  }
  if (run.providerData !== undefined) {
    observation.providerData = run.providerData;
  }
  return observation;
}
