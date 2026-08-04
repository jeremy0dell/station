import type { StationClientConnectionState } from "@station/client";
import type { StationSnapshot } from "@station/contracts";
import {
  createDashboardRuntime,
  type DashboardRuntime,
  type DashboardRuntimeOptions,
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
};

export type StationTestRuntime = {
  runtime: DashboardRuntime;
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
  const source = new FakeStationSource(snapshot, options.connection);
  const service = new FakeTuiObserverService(snapshot ?? manyProjectsSnapshot());
  const runtime = createDashboardRuntime({
    source,
    service,
    ...(snapshot === undefined || options.seedInitialSnapshot === false
      ? {}
      : { initialSnapshot: snapshot }),
    persistentPopup: true,
    onDismiss: async () => {},
    initialState: {
      ...(options.initialState ?? {}),
      ...(options.terminalRows === undefined ? {} : { terminalRows: options.terminalRows }),
    },
    ...(options.folderService === undefined ? {} : { folderService: options.folderService }),
  });
  return { runtime, source, service };
}
