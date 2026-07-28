import type { HarnessRunObservation, ObservedStatus } from "@station/contracts";

export type ObserverHarnessRunFixture = {
  run: HarnessRunObservation;
  status: ObservedStatus;
};

export function observerHarnessRunFromRun(run: HarnessRunObservation): ObserverHarnessRunFixture {
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
