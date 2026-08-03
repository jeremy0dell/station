import type { StationClientConnectionState, StationClientStateSource } from "@station/client";
import type { StationSnapshot } from "@station/contracts";
import {
  createDashboardRuntime,
  legacySearchExperience,
  type DashboardRuntime,
  type DashboardRuntimeOptions,
  type DashboardSearchExperience,
  type TuiFolderService,
} from "@station/dashboard-core";
import { manyProjectsSnapshot } from "../../fixtures/scenarios.js";
import { FakeStationSource } from "./fakeStationSource.js";
import { FakeTuiObserverService } from "./fakeObserverService.js";

export type MakeStationTestRuntimeOptions = {
  /** Source snapshot; `null` exercises the no-snapshot states. Default: manyProjectsSnapshot(). */
  snapshot?: StationSnapshot | null | undefined;
  connection?: StationClientConnectionState | undefined;
  /** Seed the store synchronously instead of waiting for the source mirror. Default: true. */
  seedInitialSnapshot?: boolean | undefined;
  terminalRows?: number | undefined;
  initialState?: DashboardRuntimeOptions["initialState"];
  folderService?: TuiFolderService | undefined;
  dashboardSearchExperience?: DashboardSearchExperience | undefined;
};

export type StationTestDashboardRuntime = DashboardRuntime & {
  clientState: StationClientStateSource;
};

export type CreateStationTestDashboardRuntimeOptions = Omit<DashboardRuntimeOptions, "source"> & {
  source?: StationClientStateSource;
  initialSnapshot?: StationSnapshot;
};

/** Dashboard test runtime with an explicit canonical source attached to the test facade. */
export function createStationTestDashboardRuntime(
  options: CreateStationTestDashboardRuntimeOptions,
): StationTestDashboardRuntime {
  const { initialSnapshot, ...runtimeOptions } = options;
  const clientState = options.source ?? new FakeStationSource(initialSnapshot);
  const runtime = createDashboardRuntime({ ...runtimeOptions, source: clientState });
  return { ...runtime, clientState };
}

export type StationTestRuntime = {
  runtime: StationTestDashboardRuntime;
  input: Pick<StationTestDashboardRuntime, "state" | "actions" | "clientState">;
  source: FakeStationSource;
  service: FakeTuiObserverService;
};

/**
 * Dashboard runtime builder using production source, service, and popup wiring.
 */
export function makeStationTestRuntime(
  options: MakeStationTestRuntimeOptions = {},
): StationTestRuntime {
  const snapshot =
    options.snapshot === null ? undefined : (options.snapshot ?? manyProjectsSnapshot());
  const initialSourceSnapshot = options.seedInitialSnapshot === false ? undefined : snapshot;
  const source = new FakeStationSource(initialSourceSnapshot, options.connection);
  const service = new FakeTuiObserverService(snapshot ?? manyProjectsSnapshot());
  const runtime = createStationTestDashboardRuntime({
    source,
    service,
    dashboardSearchExperience:
      options.dashboardSearchExperience ?? legacySearchExperience,
    persistentPopup: true,
    onDismiss: async () => {},
    initialState: {
      ...(options.initialState ?? {}),
      ...(options.terminalRows === undefined ? {} : { terminalRows: options.terminalRows }),
    },
    ...(options.folderService === undefined ? {} : { folderService: options.folderService }),
  });
  if (snapshot !== undefined && options.seedInitialSnapshot === false) {
    // Preserve loading-state fixtures: the source gains truth before start,
    // while the dashboard projection first observes it during start().
    source.setSnapshot(snapshot);
  }
  return {
    runtime,
    input: { state: runtime.state, actions: runtime.actions, clientState: source },
    source,
    service,
  };
}
