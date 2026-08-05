import { describe, expect, it } from "bun:test";
import {
  createObserverActivationCapabilities,
  createObserverManagedSessionCapabilities,
  dashboardExecution,
  selectDashboardViewport,
  type DashboardCapabilities,
} from "@station/dashboard-core";
import type { TuiFolderService } from "@station/dashboard-core";
import type { DashboardRuntime } from "@station/dashboard-core";
import { waitFor } from "../../terminal/testing/waitFor.js";
import { manyProjectsSnapshot } from "../fixtures/scenarios.js";
import { FakeStationSource } from "../test/support/fakeStationSource.js";
import { createStationStubObserverService } from "./stubObserverService.js";
import { createStationDashboardRuntime } from "./dashboardRuntime.js";

describe("createStationDashboardRuntime", () => {
  it("applies the persistent filter through the native composition", () => {
    const store = makeStore();

    store.actions.handleKey({ input: "/" });
    store.actions.handleKey({ input: "pty" });
    store.actions.handleKey({ input: "\r", return: true });

    expect(store.state.getState().screen).toEqual({ name: "dashboard" });
    expect(store.state.getState().persistentFilter).toEqual({ query: "pty" });
  });

  it("routes row activation through the stubbed command service with real pending state", async () => {
    const store = makeStore();
    const slot = slotForRow(store, "ses_wt_station_none");

    store.actions.handleKey({ input: slot });

    expect(store.state.getState().localRows.pendingStart).toMatchObject([
      {
        localId: "start:wt_station_none",
        worktreeId: "wt_station_none",
        branch: "docs-cleanup",
      },
    ]);
    await waitForMockRejectionToast(store);
  });

  it("routes N through create-session pending state and stub rejection feedback", async () => {
    const store = makeStore();

    store.actions.handleKey({ input: "N" });
    store.actions.handleKey({ input: "\r", return: true });

    expect(store.state.getState().localRows.pendingCreate).toHaveLength(1);
    expect(store.state.getState().localRows.pendingCreate[0]).toMatchObject({
      projectId: "station",
      harnessProvider: "codex",
    });
    await waitForMockRejectionToast(store);
  });

  it("routes A through add-project dispatch and stub rejection feedback", async () => {
    const store = makeStore(fakeFolderService());

    store.actions.handleKey({ input: "A" });
    store.actions.handleKey({ input: "\r", return: true });
    await waitFor(() => addProjectScreenMode(store) === "choose");
    store.actions.handleKey({ input: "\r", return: true });
    await waitFor(() => addProjectScreenMode(store) === "review");
    store.actions.handleKey({ input: "\r", return: true });

    await waitFor(() => addProjectFailureMessage(store).includes("unavailable in mock mode"));
  });

  it("routes X through remove pending state and stub rejection feedback", async () => {
    const store = makeStore();
    const slot = slotForRow(store, "ses_wt_station_idle");

    store.actions.handleKey({ input: "X" });
    store.actions.handleKey({ input: slot });
    store.actions.handleKey({ input: "y" });

    expect(store.state.getState().localRows.pendingRemove).toMatchObject([
      {
        localId: "remove:wt_station_idle",
        worktreeId: "wt_station_idle",
        branch: "pty-buffer",
      },
    ]);
    await waitForMockRejectionToast(store);
  });

  it("routes R through rename pending state and stub rejection feedback", async () => {
    const store = makeStore();
    const slot = slotForRow(store, "ses_wt_station_idle");

    store.actions.handleKey({ input: "R" });
    store.actions.handleKey({ input: slot });
    store.actions.handleKey({ input: "x" });
    store.actions.handleKey({ input: "\r", return: true });

    expect(store.state.getState().localRows.pendingRenameTitles?.ses_wt_station_idle).toMatchObject({
      title: "x",
    });
    await waitForMockRejectionToast(store);
  });

  it("routes Z through reconcile and stub rejection feedback", async () => {
    const store = makeStore();

    store.actions.handleKey({ input: "Z" });

    await waitForMockRejectionToast(store);
  });
});

function makeStore(folderService?: TuiFolderService): DashboardRuntime {
  const snapshot = manyProjectsSnapshot();
  const source = new FakeStationSource(snapshot);
  const options: Parameters<typeof createStationDashboardRuntime>[2] = {};
  if (folderService !== undefined) {
    options.folderService = folderService;
  }
  const service = createStationStubObserverService(source, { dispatchDelayMs: 1 });
  const capabilities: DashboardCapabilities = {
    activation: createObserverActivationCapabilities({ source, service, clientLabel: "Station" }),
    managedSessions: createObserverManagedSessionCapabilities({ service, clientLabel: "Station" }),
    shell: { open: () => dashboardExecution({ kind: "success" }) },
    dismissal: {
      dismissDashboard: () => dashboardExecution({ kind: "success" }),
      exitRenderer: () => dashboardExecution({ kind: "success" }),
    },
  };
  const store = createStationDashboardRuntime(
    {
      state: source,
      service,
      start: () => {
        source.start();
      },
      stop: () => source.stop(),
    },
    capabilities,
    options,
  );
  store.start();
  return store;
}

function slotForRow(store: DashboardRuntime, rowId: string): string {
  const state = store.state.getState();
  if (state.snapshot === undefined) {
    throw new Error("store has no snapshot");
  }
  const choice = selectDashboardViewport(state.snapshot, state).rowChoices.find(
    (candidate) => candidate.value.id === rowId,
  );
  if (choice === undefined) {
    throw new Error(`no slot for row ${rowId}`);
  }
  return choice.key;
}

async function waitForMockRejectionToast(store: DashboardRuntime): Promise<void> {
  await waitFor(() =>
    store
      .state.getState()
      .toasts.some((entry) => entry.toast.message.includes("unavailable in mock mode")),
  );
}

function addProjectScreenMode(store: DashboardRuntime): string | undefined {
  const screen = store.state.getState().screen;
  return screen.name === "addProject" ? screen.flow.mode : undefined;
}

function addProjectFailureMessage(store: DashboardRuntime): string {
  const screen = store.state.getState().screen;
  return screen.name === "addProject" && screen.flow.mode === "failed"
    ? screen.flow.error.message
    : "";
}

function fakeFolderService(): TuiFolderService {
  return {
    cwd: () => "/Users/example/Developer/station",
    homeDir: () => "/Users/example",
    parent: (path) => path.split("/").slice(0, -1).join("/") || "/",
    readDirectory: async (path) => ({
      path,
      entries: [
        {
          name: "station",
          path: "/Users/example/Developer/station",
          kind: "directory",
        },
      ],
    }),
    searchDirectories: async (query) => ({ query, entries: [], truncated: false }),
    reviewFolder: async (path) => ({
      selectedPath: path,
      gitRoot: path,
      id: "station",
      label: "station",
    }),
  };
}
