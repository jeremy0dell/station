// Mock-mode observer: dispatched commands show genuine pending visuals, then reject
// with mock-mode SafeError (so production code paths run, not bespoke demo state).
import type { CommandId, SafeError, StationEvent } from "@station/contracts";
import type { StationStateSource } from "../../sources/types.js";
import type { TuiObserverService } from "@station/dashboard-core";

export const STUB_DISPATCH_DELAY_MS = 900;

export type StationStubObserverServiceOptions = {
  /** Shortened in tests so pending-row visuals don't slow the suite. */
  dispatchDelayMs?: number;
};

export function createStationStubObserverService(
  source: StationStateSource,
  options: StationStubObserverServiceOptions = {},
): TuiObserverService {
  const dispatchDelayMs = options.dispatchDelayMs ?? STUB_DISPATCH_DELAY_MS;
  let stubCommandCounter = 0;

  return {
    loadSnapshot: async () => {
      const snapshot = source.getState().snapshot;
      if (snapshot === undefined) {
        throw stubError("Snapshot load", "No observer snapshot is available yet.");
      }
      return snapshot;
    },
    subscribeEvents: () => neverEvents(),
    dispatch: async (command) => {
      await delay(dispatchDelayMs);
      stubCommandCounter += 1;
      return {
        commandId: stubCommandId(stubCommandCounter),
        accepted: false,
        status: "rejected",
        error: stubError(command.type),
      };
    },
    waitForCommandCompletion: async (commandId) => ({
      status: "failed",
      commandId,
      error: stubError("Command completion"),
    }),
    reconcile: async () => {
      throw stubError("observer.reconcile");
    },
    getHarnessReadiness: async (params) => ({
      readiness: {
        provider: params.provider,
        label: params.provider,
        kind: "built_in",
        configuration: "unknown",
        cli: "unknown",
        authentication: "unknown",
        launchability: "unknown",
        trackingSetup: "unknown",
        tracking: "unknown",
        freshness: "failed",
        decision: "unknown",
        revision: "station-stub-readiness",
        explanation: "Harness readiness is unavailable in mock mode.",
        actions: ["technical_details"],
        technicalDetails: [
          {
            code: "STATION_MOCK_OBSERVER",
            message: "Harness readiness is unavailable without an observer connection.",
          },
        ],
      },
    }),
    prepareExternalLaunch: async () => {
      throw stubError("agent.prepareExternalLaunch");
    },
    reportExternalExit: async () => {
      throw stubError("agent.reportExternalExit");
    },
  };
}

function stubError(what: string, message?: string): SafeError {
  return {
    tag: "CommandDispatchError",
    code: "STATION_MOCK_OBSERVER",
    message: message ?? `${what} is unavailable in mock mode (no observer connection).`,
  };
}

function stubCommandId(counter: number): CommandId {
  return `station-stub-${counter}` as CommandId;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function* neverEvents(): AsyncIterable<StationEvent> {
  await new Promise<never>(() => {});
}
