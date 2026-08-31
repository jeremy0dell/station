import { describe, expect, it } from "bun:test";
import {
  createObserverActivationCapabilities,
  createObserverManagedSessionCapabilities,
  createObserverWorktreeRemovalCapabilities,
  dashboardExecution,
} from "@station/dashboard-core/runtime";
import type { DashboardCapabilities } from "@station/dashboard-core/runtime";
import { selectDashboardSlots } from "@station/dashboard-core/selectors";
import type { TuiFolderService } from "@station/dashboard-core/runtime";
import { waitFor } from "../../terminal/testing/waitFor.js";
import { manyProjectsSnapshot } from "../fixtures/scenarios.js";
import { FakeStationSource } from "../test/support/fakeStationSource.js";
import { createFakeFolderService } from "../test/support/fakeFolderService.js";
import { createStationStubObserverService } from "./stubObserverService.js";
import {
  createStationDashboardRuntime,
  type StationDashboardRuntime,
} from "./dashboardRuntime.js";

describe("createStationDashboardRuntime", () => {
  it("forwards one asynchronous repeat-safe dashboard settlement", async () => {
    const store = makeStore();

    const first = store.dispose();
    const second = store.dispose();

    expect(second).toBe(first);
    await first;
  });

  it("applies the persistent filter through the native composition", () => {
    const store = makeStore();

    store.actions.handleKey({ input: "/" });
    store.actions.handleKey({ input: "pty" });
    store.actions.handleKey({ input: "\r", return: true });

    expect(store.state.getState().screen).toEqual({ name: "dashboard" });
    expect(store.state.getState().persistentFilter).toEqual({ query: "pty" });
  });

  it("routes confirmed fresh start through the stubbed command service with real pending state", async () => {
    const store = makeStore();
    const slot = slotForRow(store, "ses_wt_station_none");

    store.actions.handleKey({ input: slot });
    expect(store.state.getState().screen).toMatchObject({ name: "freshStart" });
    store.actions.handleKey({ input: "y" });

    expect(store.state.getState().localRows.pendingStart).toMatchObject([
      {
        localId: "fresh:wt_station_none",
        worktreeId: "wt_station_none",
        branch: "docs-cleanup",
      },
    ]);
    await waitForMockRejectionToast(store);
  });

  it("routes N through deliberate create state without an optimistic row", async () => {
    const store = makeStore();

    store.actions.handleKey({ input: "N" });
    store.actions.handleKey({ input: "\r", return: true });

    const screen = store.state.getState().screen;
    if (screen.name !== "newSession") throw new Error("expected New Session screen");
    if (screen.flow.mode !== "review") throw new Error("expected New Session review");
    expect(screen.flow.submissionLocalId).toBeDefined();
    expect(store.state.getState().localRows.pendingCreate).toEqual([]);
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

function makeStore(folderService?: TuiFolderService): StationDashboardRuntime {
  const snapshot = manyProjectsSnapshot();
  const source = new FakeStationSource(snapshot);
  const options: Parameters<typeof createStationDashboardRuntime>[2] = {
    folderService: folderService ?? createFakeFolderService(),
  };
  const service = createStationStubObserverService(source, { dispatchDelayMs: 1 });
  const capabilities: DashboardCapabilities = {
    activation: createObserverActivationCapabilities({ source, service, clientLabel: "Station" }),
    managedSessions: createObserverManagedSessionCapabilities({ service, clientLabel: "Station" }),
    worktreeRemoval: createObserverWorktreeRemovalCapabilities({ service, clientLabel: "Station" }),
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

function slotForRow(store: StationDashboardRuntime, rowId: string): string {
  const state = store.state.getState();
  if (state.snapshot === undefined) {
    throw new Error("store has no snapshot");
  }
  const choice = selectDashboardSlots(
    state.snapshot,
    state,
    state.screen,
    store.layout.snapshot(),
  ).rowChoices.find(
    (candidate) => candidate.value.id === rowId,
  );
  if (choice === undefined) {
    throw new Error(`no slot for row ${rowId}`);
  }
  return choice.key;
}

async function waitForMockRejectionToast(store: StationDashboardRuntime): Promise<void> {
  await waitFor(() =>
    store
      .state.getState()
      .toasts.some((entry) => entry.toast.message.includes("unavailable in mock mode")),
  );
}

function addProjectScreenMode(store: StationDashboardRuntime): string | undefined {
  const screen = store.state.getState().screen;
  return screen.name === "addProject" ? screen.flow.mode : undefined;
}

function addProjectFailureMessage(store: StationDashboardRuntime): string {
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
