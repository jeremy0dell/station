import type { StationClientConnectionState, StationClientStateSource } from "@station/client";
import type { StationSnapshot } from "@station/contracts";
import {
  createDashboardRuntime,
  createObserverActivationCapabilities,
  createObserverManagedSessionCapabilities,
  createObserverWorktreeRemovalCapabilities,
  dashboardExecution,
 } from "@station/dashboard-core/runtime";
import type {
  DashboardCapabilities,
  DashboardFocusTarget,
  DashboardRuntime,
  DashboardRuntimeOptions,
  TuiFolderService,
} from "@station/dashboard-core/runtime";
import { manyProjectsSnapshot } from "../../fixtures/scenarios.js";
import { stationHelpEntryOrder } from "../../helpEntries.js";
import { FakeStationSource } from "./fakeStationSource.js";
import { FakeTuiObserverService } from "./fakeObserverService.js";
import {
  createDashboardScrollController,
  type DashboardScrollController,
} from "../../view/layout/dashboardScrollController.js";

export type MakeStationTestRuntimeOptions = {
  /** Source snapshot; `null` exercises the no-snapshot states. Default: manyProjectsSnapshot(). */
  snapshot?: StationSnapshot | null | undefined;
  connection?: StationClientConnectionState | undefined;
  /** Seed the store synchronously instead of waiting for the source mirror. Default: true. */
  seedInitialSnapshot?: boolean | undefined;
  initialState?: DashboardRuntimeOptions["initialState"];
  capabilities?: DashboardCapabilities;
  folderService?: TuiFolderService | undefined;
};

export type StationTestDashboardRuntime = DashboardRuntime & {
  clientState: StationClientStateSource;
  layout: DashboardScrollController;
};

export type CreateStationTestDashboardRuntimeOptions = Omit<
  DashboardRuntimeOptions,
  "source" | "capabilities"
> & {
  source?: StationClientStateSource;
  initialSnapshot?: StationSnapshot;
  capabilities?: DashboardCapabilities;
  persistentPopup?: boolean;
  focusOrigin?: import("@station/contracts").TerminalFocusOrigin;
  resolveFocusTarget?: () => Promise<DashboardFocusTarget | undefined>;
  onFocusSuccess?: () => Promise<void>;
  onDismiss?: () => Promise<void>;
  onExit?: (code: number) => void;
  exitOnFocusSuccess?: boolean;
};

/** Dashboard test runtime with an explicit canonical source attached to the test facade. */
export function createStationTestDashboardRuntime(
  options: CreateStationTestDashboardRuntimeOptions,
): StationTestDashboardRuntime {
  const {
    initialSnapshot,
    capabilities,
    persistentPopup,
    focusOrigin,
    resolveFocusTarget,
    onFocusSuccess,
    onDismiss,
    onExit,
    exitOnFocusSuccess,
    ...runtimeOptions
  } = options;
  const layout = createDashboardScrollController();
  const clientState = options.source ?? new FakeStationSource(initialSnapshot);
  const resolvedCapabilities =
    capabilities ??
    createStationTestCapabilities({
      clientState,
      service: options.service,
      persistentPopup: persistentPopup === true,
      ...(focusOrigin === undefined ? {} : { focusOrigin }),
      ...(resolveFocusTarget === undefined ? {} : { resolveFocusTarget }),
      ...(onFocusSuccess === undefined ? {} : { onFocusSuccess }),
      ...(onDismiss === undefined ? {} : { onDismiss }),
      ...(onExit === undefined ? {} : { onExit }),
      exitOnFocusSuccess: exitOnFocusSuccess === true,
    });
  const runtime = createDashboardRuntime({
    ...runtimeOptions,
    source: clientState,
    capabilities: resolvedCapabilities,
    helpEntries: runtimeOptions.helpEntries ?? stationHelpEntryOrder,
    visibleDashboardRows: runtimeOptions.visibleDashboardRows ?? layout.visibleRows,
  });
  return { ...runtime, clientState, layout };
}

function createStationTestCapabilities(options: {
  clientState: StationClientStateSource;
  service: DashboardRuntimeOptions["service"];
  persistentPopup: boolean;
  focusOrigin?: import("@station/contracts").TerminalFocusOrigin;
  resolveFocusTarget?: () => Promise<DashboardFocusTarget | undefined>;
  onFocusSuccess?: () => Promise<void>;
  onDismiss?: () => Promise<void>;
  onExit?: (code: number) => void;
  exitOnFocusSuccess: boolean;
}): DashboardCapabilities {
  const activationOptions: Parameters<typeof createObserverActivationCapabilities>[0] = {
    source: options.clientState,
    service: options.service,
    clientLabel: "Station test",
    waitForFocusCompletion: options.persistentPopup || options.exitOnFocusSuccess,
  };
  if (options.focusOrigin !== undefined) activationOptions.focusOrigin = options.focusOrigin;
  if (options.resolveFocusTarget !== undefined) {
    activationOptions.resolveFocusTarget = options.resolveFocusTarget;
  }
  if (options.onFocusSuccess !== undefined) activationOptions.onFocusSuccess = options.onFocusSuccess;
  const managedOptions: Parameters<typeof createObserverManagedSessionCapabilities>[0] = {
    service: options.service,
    clientLabel: "Station test",
  };
  if (options.focusOrigin !== undefined) managedOptions.focusOrigin = options.focusOrigin;
  if (options.resolveFocusTarget !== undefined) {
    managedOptions.resolveFocusTarget = options.resolveFocusTarget;
  }
  return {
    activation: createObserverActivationCapabilities(activationOptions),
    managedSessions: createObserverManagedSessionCapabilities(managedOptions),
    worktreeRemoval: createObserverWorktreeRemovalCapabilities({
      service: options.service,
      clientLabel: "Station test",
    }),
    shell: { open: () => dashboardExecution({ kind: "success" }) },
    dismissal: {
      dismissDashboard: () => {
        const completion = options.onDismiss?.() ?? Promise.resolve();
        return dashboardExecution(completion.then(() => ({ kind: "success" } as const)));
      },
      exitRenderer: ({ exitCode }) => {
        if (options.persistentPopup && options.onDismiss !== undefined) {
          return dashboardExecution(options.onDismiss().then(() => ({ kind: "success" } as const)));
        }
        options.onExit?.(exitCode);
        return dashboardExecution({ kind: "success" });
      },
    },
  };
}

export type StationTestRuntime = {
  runtime: StationTestDashboardRuntime;
  input: Pick<StationTestDashboardRuntime, "state" | "actions" | "clientState" | "layout">;
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
    persistentPopup: true,
    onDismiss: async () => {},
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    initialState: {
      ...(options.initialState ?? {}),
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
    input: { state: runtime.state, actions: runtime.actions, clientState: source, layout: runtime.layout },
    source,
    service,
  };
}
