import { invokeCleanup, type CleanupStep } from "../lifecycle/cleanup.js";

export type StationHotDisposalSlots = typeof globalThis & {
  __stationHotDisposal?: Promise<void>;
};

/** Await only the settlement ordering of the current HMR cleanup generation. */
export function waitForHotDisposal(slots: StationHotDisposalSlots): Promise<void> {
  return slots.__stationHotDisposal ?? Promise.resolve();
}

/**
 * Publish a settlement-only HMR barrier before cleanup starts so failure cannot
 * block replacement startup or leave the generation unpublished.
 */
export function beginHotDisposal(
  slots: StationHotDisposalSlots,
  dispose: CleanupStep,
  reportFailure: (error: unknown) => void,
): Promise<void> {
  let settle!: () => void;
  const barrier = new Promise<void>((resolve) => {
    settle = resolve;
  });
  slots.__stationHotDisposal = barrier;

  const clear = (): void => {
    // A stale disposer must not erase a newer generation's settlement barrier.
    if (slots.__stationHotDisposal === barrier) {
      delete slots.__stationHotDisposal;
    }
  };
  void barrier.then(clear);

  void invokeCleanup(dispose).then(settle, (error: unknown) => {
    try {
      reportFailure(error);
    } catch {
      // Failure reporting is separate from the ordering barrier and cannot block replacement.
    }
    settle();
  });
  return barrier;
}
