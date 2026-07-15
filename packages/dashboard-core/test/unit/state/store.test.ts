import type {
  ProviderId,
  SafeError,
  StationEvent,
  StationSnapshot,
  WorktreeRow,
} from "@station/contracts";
import type { TuiFolderService, TuiObserverService } from "@station/dashboard-core";
import {
  createTuiStore,
  openProjectDefaultAgentPicker,
  type TuiStore,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";
import {
  createCommandSnapshot,
  createDashboardSnapshot,
  createNoProjectsSnapshot,
  createZeroWorktreeSnapshot,
  fixtureNow,
} from "../../fixtures/snapshots.js";
import { FakeTuiObserverService } from "../../support/fakeObserverService.js";

describe("TUI store", () => {
  it("loads initial snapshots and cleans up event subscriptions", async () => {
    const snapshot = createCommandSnapshot("idle");
    const service = new FakeTuiObserverService(snapshot);
    const store = createTuiStore({ service });
    const stop = store.getState().start();

    await waitFor(() => store.getState().snapshot?.rows.length === 1);
    await waitFor(() => service.subscribeCount === 1);
    stop();
    await waitFor(() => service.cleanupCount === 1);
  });

  it("applies live events to rendered state", async () => {
    const snapshot = createCommandSnapshot("idle");
    const service = new FakeTuiObserverService(snapshot);
    const store = createTuiStore({ service });
    const stop = store.getState().start();
    const event: StationEvent = {
      type: "worktree.updated",
      worktreeId: "wt_web_idle",
      patch: {
        display: {
          statusLabel: "working",
          sortPriority: 30,
          alert: false,
          reason: "Harness reported active generation.",
        },
      },
    };

    await waitFor(() => service.subscribeCount === 1);
    service.emit(event);

    await waitFor(() => store.getState().snapshot?.rows[0]?.display.statusLabel === "working");
    stop();
  });

  it("removes worktree rows and surfaces command failure toasts from observer events", async () => {
    const snapshot = createCommandSnapshot("idle");
    const service = new FakeTuiObserverService(snapshot);
    const store = createTuiStore({ service, initialSnapshot: snapshot });
    const stop = store.getState().start();

    await waitFor(() => service.subscribeCount === 1);
    service.emit({ type: "worktree.removed", worktreeId: "wt_web_idle" });
    service.emit({
      type: "command.failed",
      commandId: "cmd_focus_1",
      error: {
        tag: "TerminalProviderError",
        code: "TERMINAL_TARGET_MISSING",
        message: "The terminal target for this worktree no longer exists.",
        diagnosticId: "diag_terminal_missing",
      },
    });

    await waitFor(
      () =>
        store.getState().snapshot?.rows.length === 0 &&
        store
          .getState()
          .toasts.some((entry) => entry.toast.diagnosticId === "diag_terminal_missing"),
    );
    stop();
  });

  it("marks an existing snapshot as display-only on observer connect failures without a toast", async () => {
    const snapshot = createCommandSnapshot("idle");
    const service = new SnapshotConnectFailingService(snapshot);
    const store = createTuiStore({ service, initialSnapshot: snapshot });
    const stop = store.getState().start();

    await waitFor(() => service.subscribeCount === 1);
    service.failSubscriptions(wrappedConnectError());

    await waitFor(() => store.getState().observerConnectionStatus.state === "displayOnly");
    expect(store.getState().snapshot?.rows).toHaveLength(1);
    expect(store.getState().toasts).toEqual([]);
    stop();
  });

  it("marks cold starts as reconnecting on observer connect failures without a toast", async () => {
    const snapshot = createCommandSnapshot("idle");
    const service = new ColdStartConnectFailingService(snapshot);
    const store = createTuiStore({ service });
    const stop = store.getState().start();

    await waitFor(() => store.getState().observerConnectionStatus.state === "reconnecting");
    expect(store.getState().snapshot).toBeUndefined();
    expect(store.getState().toasts).toEqual([]);
    stop();
  });

  it("clears reconnect status after a successful snapshot and shows delayed recovery feedback", async () => {
    const snapshot = createCommandSnapshot("idle");
    const service = new FakeTuiObserverService(snapshot);
    const store = createTuiStore({ service, initialSnapshot: snapshot });
    const stop = store.getState().start();

    await waitFor(() => service.subscribeCount === 1);
    store.setState({
      observerConnectionStatus: {
        state: "displayOnly",
        since: Date.now() - 1_501,
        lastError: connectSafeError(),
      },
    });
    service.endSubscriptions();

    await waitFor(
      () =>
        store.getState().observerConnectionStatus.state === "connected" &&
        store.getState().toasts.some((entry) => entry.toast.message === "Observer reconnected."),
    );
    stop();
  });

  it("does not show recovery feedback for brief reconnect states", async () => {
    const snapshot = createCommandSnapshot("idle");
    const service = new FakeTuiObserverService(snapshot);
    const store = createTuiStore({ service, initialSnapshot: snapshot });
    const stop = store.getState().start();

    await waitFor(() => service.subscribeCount === 1);
    store.setState({
      observerConnectionStatus: {
        state: "displayOnly",
        since: Date.now() - 100,
        lastError: connectSafeError(),
      },
    });
    service.endSubscriptions();

    await waitFor(() => store.getState().observerConnectionStatus.state === "connected");
    expect(store.getState().toasts).toEqual([]);
    stop();
  });

  it("acknowledges a ready turn after successful focus", async () => {
    const snapshot = withTurnReadiness(createCommandSnapshot("idle"));
    const service = new FakeTuiObserverService(snapshot);
    const store = createTuiStore({ service, initialSnapshot: snapshot });

    store.getState().handleKey({ input: "1" });

    await waitFor(() => service.dispatched.length === 2);
    expect(service.dispatched).toEqual([
      { type: "terminal.focus", payload: { sessionId: "ses_wt_web_idle" } },
      {
        type: "session.acknowledgeTurn",
        payload: { sessionId: "ses_wt_web_idle", token: "report_ready" },
      },
    ]);
    expect(service.waitedForCommandIds).toEqual(["cmd_tui_1", "cmd_tui_1"]);
  });

  it("does not acknowledge a ready turn when focus fails", async () => {
    const snapshot = withTurnReadiness(createCommandSnapshot("idle"));
    const service = new FakeTuiObserverService(snapshot);
    service.nextCompletion = {
      status: "failed",
      commandId: "cmd_tui_1",
      error: {
        tag: "TerminalProviderError",
        code: "TERMINAL_FOCUS_FAILED",
        message: "The terminal could not be focused.",
      },
    };
    const store = createTuiStore({ service, initialSnapshot: snapshot });

    store.getState().handleKey({ input: "1" });

    await waitFor(() => service.waitedForCommandIds.length === 1);
    expect(service.dispatched).toEqual([
      { type: "terminal.focus", payload: { sessionId: "ses_wt_web_idle" } },
    ]);
  });

  it("syncs terminal rows into view state and clamps dashboard scroll", () => {
    const snapshot = createDashboardSnapshot();
    const service = new FakeTuiObserverService(snapshot);
    const store = createTuiStore({
      service,
      initialSnapshot: snapshot,
      initialState: {
        scrollOffset: 8,
        terminalRows: 10,
      },
    });

    store.getState().setTerminalRows(24);

    expect(store.getState().terminalRows).toBe(24);
    expect(store.getState().scrollOffset).toBe(0);
  });

  it("uses the local folder service and dispatches project.add after confirmation", async () => {
    const snapshot = createNoProjectsSnapshot();
    const service = new FakeTuiObserverService(snapshot);
    const folderService = fakeFolderService();
    const store = createTuiStore({
      service,
      initialSnapshot: snapshot,
      folderService,
    });

    store.getState().handleKey({ input: "A" });
    expect(store.getState().screen).toMatchObject({ name: "addProject" });

    store.getState().handleKey({ input: "", rightArrow: true });
    await waitFor(() => screenMode(store.getState()) === "choose");
    expect(folderService.reads).toEqual(["/Users/example/Developer/station"]);

    store.getState().handleKey({ input: "", downArrow: true });
    store.getState().handleKey({ input: "\r", return: true });
    await waitFor(() => screenMode(store.getState()) === "review");

    store.getState().handleKey({ input: "N" });
    store.getState().handleKey({ input: "-custom" });
    store.getState().handleKey({ input: "\r", return: true });

    service.setSnapshot(createZeroWorktreeSnapshot());
    store.getState().handleKey({ input: "\r", return: true });
    await waitFor(() => screenMode(store.getState()) === "success");

    expect(service.dispatched).toEqual([
      {
        type: "project.add",
        payload: {
          path: "/Users/example/Developer/station",
          id: "station-custom",
          label: "station",
        },
      },
    ]);
    expect(service.waitedForCommandIds).toEqual(["cmd_tui_1"]);
  });

  it("opens the explicit first-project flow with Enter on an empty dashboard", () => {
    const snapshot = createNoProjectsSnapshot();
    const service = new FakeTuiObserverService(snapshot);
    const store = createTuiStore({
      service,
      initialSnapshot: snapshot,
      folderService: fakeFolderService(),
    });

    store.getState().handleKey({ input: "\r", return: true });

    expect(store.getState().screen).toMatchObject({
      name: "addProject",
      flow: { mode: "start", firstProject: true },
    });
  });

  it("sets a project default harness, refreshes the snapshot, and shows success", async () => {
    const snapshot = createDashboardSnapshot();
    const service = new FakeTuiObserverService(snapshot);
    service.setSnapshot(snapshotWithProjectHarness(snapshot, "web", "opencode"));
    const store = createTuiStore({ service, initialSnapshot: snapshot });

    store.setState(openProjectDefaultAgentPicker(store.getState(), "web"));
    store.getState().handleKey({ input: "2" });

    await waitFor(() => service.loadCount === 1);
    expect(service.dispatched).toEqual([
      {
        type: "project.setDefaultHarness",
        payload: { projectId: "web", harness: "opencode" },
      },
    ]);
    expect(service.waitedForCommandIds).toEqual(["cmd_tui_1"]);
    expect(store.getState().snapshot?.projects[0]?.defaults.harness).toBe("opencode");
    expect(store.getState().toasts.map((entry) => entry.toast)).toContainEqual(
      expect.objectContaining({
        kind: "success",
        message: "Default agent set to opencode.",
      }),
    );
  });

  it("shows an error toast when setting a project default harness is rejected", async () => {
    const snapshot = createDashboardSnapshot();
    const service = new FakeTuiObserverService(snapshot);
    service.nextReceipt = {
      commandId: "cmd_tui_rejected",
      accepted: false,
      status: "rejected",
      error: {
        tag: "CommandExecutionError",
        code: "COMMAND_REJECTED",
        message: "Default harness was rejected.",
      },
    };
    const store = createTuiStore({ service, initialSnapshot: snapshot });

    store.setState(openProjectDefaultAgentPicker(store.getState(), "web"));
    store.getState().handleKey({ input: "2" });

    await waitFor(() =>
      store
        .getState()
        .toasts.some((entry) => entry.toast.message === "Default harness was rejected."),
    );
    expect(service.waitedForCommandIds).toEqual([]);
    expect(service.loadCount).toBe(0);
  });

  it("shows an error toast when setting a project default harness fails completion", async () => {
    const snapshot = createDashboardSnapshot();
    const service = new FakeTuiObserverService(snapshot);
    service.nextCompletion = {
      status: "failed",
      commandId: "cmd_tui_1",
      error: {
        tag: "ProjectConfigError",
        code: "PROJECT_DEFAULT_HARNESS_OVERRIDDEN",
        message: "Project-local config keeps claude effective.",
      },
    };
    const store = createTuiStore({ service, initialSnapshot: snapshot });

    store.setState(openProjectDefaultAgentPicker(store.getState(), "web"));
    store.getState().handleKey({ input: "2" });

    await waitFor(() =>
      store
        .getState()
        .toasts.some(
          (entry) => entry.toast.message === "Project-local config keeps claude effective.",
        ),
    );
    expect(service.waitedForCommandIds).toEqual(["cmd_tui_1"]);
    expect(service.loadCount).toBe(0);
  });

  it("shows an error toast when setting a project default harness dispatch throws", async () => {
    const snapshot = createDashboardSnapshot();
    const service = new FakeTuiObserverService(snapshot);
    service.nextDispatchError = {
      tag: "ProtocolError",
      code: "PROTOCOL_SOCKET_CLOSED",
      message: "Observer socket closed.",
    };
    const store = createTuiStore({ service, initialSnapshot: snapshot });

    store.setState(openProjectDefaultAgentPicker(store.getState(), "web"));
    store.getState().handleKey({ input: "2" });

    await waitFor(() =>
      store.getState().toasts.some((entry) => entry.toast.message === "Observer socket closed."),
    );
    expect(service.waitedForCommandIds).toEqual([]);
    expect(service.loadCount).toBe(0);
  });

  it("shows a single toast when a failed default-harness command also broadcasts command.failed", async () => {
    const snapshot = createDashboardSnapshot();
    const service = new FakeTuiObserverService(snapshot);
    const failure: SafeError = {
      tag: "ProjectConfigError",
      code: "PROJECT_DEFAULT_HARNESS_OVERRIDDEN",
      message: "Project-local config keeps claude effective.",
    };
    service.nextCompletion = { status: "failed", commandId: "cmd_tui_1", error: failure };
    const store = createTuiStore({ service, initialSnapshot: snapshot });
    const stop = store.getState().start();
    await waitFor(() => service.subscribeCount === 1);

    store.setState(openProjectDefaultAgentPicker(store.getState(), "web"));
    store.getState().handleKey({ input: "2" });

    // The op registers the command before awaiting, so the observer's separate
    // command.failed broadcast must be suppressed (one toast, not two). A second
    // unrelated failure is emitted after as an ordering barrier: once its toast
    // lands, the earlier event has already been processed (FIFO).
    await waitFor(() => service.waitedForCommandIds.includes("cmd_tui_1"));
    service.emit({ type: "command.failed", commandId: "cmd_tui_1", error: failure });
    service.emit({
      type: "command.failed",
      commandId: "cmd_other",
      error: {
        tag: "CommandExecutionError",
        code: "COMMAND_REJECTED",
        message: "Unrelated failure.",
      },
    });

    await waitFor(
      () =>
        store.getState().toasts.some((entry) => entry.toast.message === failure.message) &&
        store.getState().toasts.some((entry) => entry.toast.message === "Unrelated failure."),
    );
    expect(
      store.getState().toasts.filter((entry) => entry.toast.message === failure.message),
    ).toHaveLength(1);
    stop();
  });

  it("reviews a pasted full path when folder filtering has no matches", async () => {
    const snapshot = createNoProjectsSnapshot();
    const service = new FakeTuiObserverService(snapshot);
    const folderService = fakeFolderService();
    const store = createTuiStore({
      service,
      initialSnapshot: snapshot,
      folderService,
    });

    store.getState().handleKey({ input: "A" });
    store.getState().handleKey({ input: "", rightArrow: true });
    await waitFor(() => screenMode(store.getState()) === "choose");

    store.getState().handleKey({ input: "/" });
    store.getState().handleKey({ input: "/Users/example/Developer/synth" });
    store.getState().handleKey({ input: "\r", return: true });
    await waitFor(() => screenMode(store.getState()) === "review");

    expect(folderService.reviews).toEqual(["/Users/example/Developer/synth"]);
    expect(store.getState().screen).toMatchObject({
      name: "addProject",
      flow: {
        mode: "review",
        selectedPath: "/Users/example/Developer/synth",
        id: "synth",
        label: "synth",
      },
    });
  });

  it("opens the home anchor from start choices", async () => {
    const snapshot = createNoProjectsSnapshot();
    const service = new FakeTuiObserverService(snapshot);
    const folderService = fakeFolderService();
    const store = createTuiStore({
      service,
      initialSnapshot: snapshot,
      folderService,
    });

    store.getState().handleKey({ input: "A" });
    store.getState().handleKey({ input: "", downArrow: true });
    store.getState().handleKey({ input: "\r", return: true });
    await waitFor(() => screenMode(store.getState()) === "choose");

    expect(folderService.reads).toEqual(["/Users/example"]);
    expect(store.getState().screen).toMatchObject({
      name: "addProject",
      flow: {
        mode: "choose",
        currentPath: "/Users/example",
      },
    });
  });

  it("globally searches likely project roots from slash mode", async () => {
    const snapshot = createNoProjectsSnapshot();
    const service = new FakeTuiObserverService(snapshot);
    const folderService = fakeFolderService();
    const store = createTuiStore({
      service,
      initialSnapshot: snapshot,
      folderService,
    });

    store.getState().handleKey({ input: "A" });
    store.getState().handleKey({ input: "\r", return: true });
    await waitFor(() => screenMode(store.getState()) === "choose");

    store.getState().handleKey({ input: "/" });
    store.getState().handleKey({ input: "Germ" });
    await waitFor(() => addProjectSearchResultCount(store.getState()) === 1);

    store.getState().handleKey({ input: "\r", return: true });
    await waitFor(() => screenMode(store.getState()) === "review");

    expect(folderService.reviews).toContain("/Users/example/Desktop/projects/GermStack");
  });
});

function withTurnReadiness(snapshot: StationSnapshot): StationSnapshot {
  return {
    ...snapshot,
    rows: snapshot.rows.map((row): WorktreeRow => {
      if (row.id !== "wt_web_idle" || row.agent === undefined) {
        return row;
      }
      return {
        ...row,
        agent: {
          ...row.agent,
          turnReadiness: {
            state: "ready_to_read",
            token: "report_ready",
            completedAt: fixtureNow,
          },
        },
      };
    }),
  };
}

function fakeFolderService(): TuiFolderService & {
  reads: string[];
  reviews: string[];
  searches: string[];
} {
  const reads: string[] = [];
  const reviews: string[] = [];
  const searches: string[] = [];
  return {
    reads,
    reviews,
    searches,
    cwd: () => "/Users/example/Developer/station",
    homeDir: () => "/Users/example",
    parent: (path) => path.split("/").slice(0, -1).join("/") || "/",
    readDirectory: async (path) => {
      reads.push(path);
      return {
        path,
        entries: entriesForPath(path),
      };
    },
    searchDirectories: async (query) => {
      searches.push(query);
      return {
        query,
        truncated: false,
        entries: query.toLowerCase().includes("germ")
          ? [
              {
                name: "GermStack",
                path: "/Users/example/Desktop/projects/GermStack",
                displayPath: "~/Desktop/projects/GermStack",
                kind: "directory",
              },
            ]
          : [],
      };
    },
    reviewFolder: async (path) => {
      reviews.push(path);
      const label = path.split("/").filter(Boolean).at(-1) ?? "project";
      return {
        selectedPath: path,
        gitRoot: path,
        id: label,
        label,
      };
    },
  };
}

function entriesForPath(path: string) {
  if (path === "/Users/example/Desktop/projects") {
    return [
      {
        name: "GermStack",
        path: "/Users/example/Desktop/projects/GermStack",
        kind: "directory" as const,
      },
    ];
  }
  return [
    {
      name: "station",
      path: "/Users/example/Developer/station",
      kind: "directory" as const,
    },
  ];
}

function screenMode(state: TuiStore) {
  return state.screen.name === "addProject" ? state.screen.flow.mode : undefined;
}

function addProjectSearchResultCount(state: TuiStore) {
  return state.screen.name === "addProject" && state.screen.flow.mode === "choose"
    ? state.screen.flow.searchEntries.length
    : 0;
}

function snapshotWithProjectHarness(
  snapshot: StationSnapshot,
  projectId: string,
  harness: ProviderId,
): StationSnapshot {
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) =>
      project.id === projectId
        ? { ...project, defaults: { ...project.defaults, harness } }
        : project,
    ),
  };
}

class SnapshotConnectFailingService extends FakeTuiObserverService {
  override async loadSnapshot(): Promise<StationSnapshot> {
    this.loadCount += 1;
    throw wrappedConnectError();
  }
}

class ColdStartConnectFailingService implements TuiObserverService {
  readonly dispatched = [];
  loadCount = 0;
  subscribeCount = 0;

  constructor(private readonly snapshot: StationSnapshot) {}

  async loadSnapshot(): Promise<StationSnapshot> {
    this.loadCount += 1;
    throw wrappedConnectError();
  }

  subscribeEvents(): AsyncIterable<StationEvent> {
    this.subscribeCount += 1;
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          throw wrappedConnectError();
        },
        return: async () => ({ done: true, value: undefined }),
      }),
    };
  }

  async dispatch() {
    return {
      commandId: "cmd_tui_1",
      accepted: true,
      status: "accepted" as const,
    };
  }

  async waitForCommandCompletion(commandId: string) {
    return {
      status: "succeeded" as const,
      commandId,
    };
  }

  async reconcile(): Promise<StationSnapshot> {
    return this.snapshot;
  }
}

function connectSafeError(): SafeError {
  return {
    tag: "ProtocolError",
    code: "PROTOCOL_CONNECT_FAILED",
    message: "Could not connect to observer socket /tmp/station-test.sock.",
  };
}

function wrappedConnectError(): Error {
  const error = new Error("wrapped connect failure");
  (error as Error & { cause?: unknown }).cause = connectSafeError();
  return error;
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  for (;;) {
    if (assertion()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for assertion");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
