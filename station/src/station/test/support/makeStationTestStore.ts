import type { StationClientConnectionState } from "@station/client";
import type { StationSnapshot } from "@station/contracts";
import type { StoreApi } from "zustand/vanilla";
import { createTuiStore, type TuiFolderService, type TuiStore } from "@station/dashboard-core";
import { manyProjectsSnapshot } from "../../fixtures/scenarios.js";
import { FakeStationSource } from "./fakeStationSource.js";
import { FakeTuiObserverService } from "./fakeObserverService.js";

export type MakeStationTestStoreOptions = {
  /** Source snapshot; `null` exercises the no-snapshot states. Default: manyProjectsSnapshot(). */
  snapshot?: StationSnapshot | null | undefined;
  connection?: StationClientConnectionState | undefined;
  /** Seed the store synchronously instead of waiting for the source mirror. Default: true. */
  seedInitialSnapshot?: boolean | undefined;
  terminalRows?: number | undefined;
  folderService?: TuiFolderService | undefined;
};

export type StationTestStore = {
  store: StoreApi<TuiStore>;
  source: FakeStationSource;
  service: FakeTuiObserverService;
};

/**
 * STATION view store builder: production wiring (source + service + persistent popup).
 */
export function makeStationTestStore(options: MakeStationTestStoreOptions = {}): StationTestStore {
  const snapshot =
    options.snapshot === null ? undefined : (options.snapshot ?? manyProjectsSnapshot());
  const source = new FakeStationSource(snapshot, options.connection);
  const service = new FakeTuiObserverService(snapshot ?? manyProjectsSnapshot());
  const store = createTuiStore({
    source,
    service,
    ...(snapshot === undefined || options.seedInitialSnapshot === false
      ? {}
      : { initialSnapshot: snapshot }),
    persistentPopup: true,
    onDismiss: async () => {},
    ...(options.terminalRows === undefined
      ? {}
      : { initialState: { terminalRows: options.terminalRows } }),
    ...(options.folderService === undefined ? {} : { folderService: options.folderService }),
  });
  return { store, source, service };
}
