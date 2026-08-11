import type { StationClientState, StationClientStateSource } from "@station/client";
import type {
  ProviderId,
  SafeError,
  StationCommand,
  StationSnapshot,
  WorktreeRow,
} from "@station/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dashboardRowIds } from "../../../src/selectors/dashboardTree.js";
import type {
  TuiFolderEntry,
  TuiFolderReadResult,
  TuiFolderService,
} from "../../../src/services/folderService.js";
import { dashboardExecution } from "../../../src/state/capabilities/execution.js";
import { createEmptyTuiLocalRows } from "../../../src/state/localRows.js";
import { selectedAddProjectFolderRow } from "../../../src/state/selection/addProject.js";
import { ADD_PROJECT_DIRECTORY_POLL_INTERVAL_MS } from "../../../src/state/timing.js";
import type { DashboardStateView } from "../../../src/state/types.js";
import {
  createCommandSnapshot,
  createDashboardSnapshot,
  createNoProjectsSnapshot,
  createZeroWorktreeSnapshot,
  fixtureNow,
} from "../../fixtures/snapshots.js";
import {
  createTestDashboardRuntime,
  FakeClientStateSource,
} from "../../support/fakeClientStateSource.js";
import { createFakeDashboardCapabilities } from "../../support/fakeDashboardCapabilities.js";
import { FakeTuiObserverService } from "../../support/fakeObserverService.js";

describe("dashboard runtime boundary", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes data-only state through a read-only source", () => {
    const snapshot = createDashboardSnapshot();
    const runtime = createTestDashboardRuntime({
      service: new FakeTuiObserverService(snapshot),
      initialSnapshot: snapshot,
    });

    expect(Object.keys(runtime.state).sort()).toEqual(["getInitialState", "getState", "subscribe"]);
    expect(runtime.state).not.toHaveProperty("setState");
    expect(runtime.actions).not.toHaveProperty("setState");
    expect(runtime.state.getState()).not.toHaveProperty("handleKey");
    expect(runtime.state.getState()).not.toHaveProperty("start");
    expect(runtime.state.getInitialState()).not.toHaveProperty("dispatch");
    expect(runtime.state.getInitialState()).not.toHaveProperty("dispose");
  });

  it("projects state without copying, freezing, or changing notification identity", () => {
    const snapshot = createDashboardSnapshot();
    const runtime = createTestDashboardRuntime({
      service: new FakeTuiObserverService(snapshot),
      initialSnapshot: snapshot,
    });
    const initialState = runtime.state.getState();
    let notifications = 0;
    const unsubscribe = runtime.state.subscribe((state, previous) => {
      notifications += 1;
      expect(state).toBe(runtime.state.getState());
      expect(previous).toBe(initialState);
    });

    expect(runtime.state.getInitialState()).toBe(initialState);
    expect(initialState.snapshot).toBe(snapshot);
    expect(Object.isFrozen(initialState)).toBe(false);
    expect(Object.isFrozen(initialState.snapshot)).toBe(false);

    runtime.actions.setTerminalRows(initialState.terminalRows + 1);

    expect(notifications).toBe(1);
    expect(runtime.state.getState()).not.toBe(initialState);
    expect(runtime.state.getState().snapshot).toBe(snapshot);
    unsubscribe();
  });

  it("starts once and returns one repeat-safe source settlement", async () => {
    const snapshot = createCommandSnapshot("idle");
    const source = new FakeClientStateSource(snapshot);
    const service = new FakeTuiObserverService(snapshot);
    const runtime = createTestDashboardRuntime({ service, source });

    runtime.start();
    runtime.start();
    expect(source.subscribeCount).toBe(1);
    expect(service.subscribeCount).toBe(0);

    const firstDisposal = runtime.dispose();
    const secondDisposal = runtime.dispose();
    expect(secondDisposal).toBe(firstDisposal);
    expect(source.unsubscribeCount).toBe(1);
    await firstDisposal;

    runtime.start();
    expect(source.subscribeCount).toBe(1);
  });

  it("does not notify subscribers when a source re-emits an equal failure", () => {
    const now = Date.parse(fixtureNow);
    const sourceError: SafeError = {
      tag: "ProtocolError",
      code: "PROTOCOL_CONNECT_FAILED",
      message: "Could not connect to the observer socket.",
    };
    const source = mutableSnapshotSource({
      connection: { state: "loading", since: now },
    });
    const runtime = createTestDashboardRuntime({
      service: new FakeTuiObserverService(createDashboardSnapshot()),
      source,
    });
    let notifications = 0;
    const unsubscribe = runtime.state.subscribe(() => {
      notifications += 1;
    });

    runtime.start();
    source.setConnection({ state: "reconnecting", since: now, lastError: sourceError });
    expect(notifications).toBe(1);

    source.setConnection({
      state: "reconnecting",
      since: now,
      lastError: { ...sourceError },
    });
    source.setConnection({
      state: "reconnecting",
      since: now,
      lastError: { ...sourceError },
    });
    expect(notifications).toBe(1);

    unsubscribe();
    runtime.dispose();
  });

  it("deletes an absent persistent filter during full replacement", () => {
    const snapshot = createDashboardSnapshot();
    const runtime = createTestDashboardRuntime({
      service: new FakeTuiObserverService(snapshot),
      initialSnapshot: snapshot,
      initialState: { persistentFilter: { query: "working" } },
    });

    runtime.actions.handleKey({ input: "/" });
    runtime.actions.handleKey({ input: "u", ctrl: true });
    runtime.actions.handleKey({ input: "\r", return: true });

    expect("persistentFilter" in runtime.state.getState()).toBe(false);
  });
});

describe("dashboard runtime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies semantic actions through the same transition executor as keys", () => {
    const snapshot = createNoProjectsSnapshot();
    const keyStore = createTestDashboardRuntime({
      service: new FakeTuiObserverService(snapshot),
      initialSnapshot: snapshot,
    });
    const actionStore = createTestDashboardRuntime({
      service: new FakeTuiObserverService(snapshot),
      initialSnapshot: snapshot,
    });

    const keyResult = keyStore.actions.handleKey({ input: "A" });
    const actionResult = actionStore.actions.dispatch({ type: "dashboard.addProject" });

    expect(actionResult).toEqual(keyResult);
    expect(actionStore.state.getState().screen).toEqual(keyStore.state.getState().screen);
  });

  it("commits project-header focus before invoking shell capability", () => {
    const snapshot = createDashboardSnapshot();
    const capabilities = createFakeDashboardCapabilities();
    let focusAtInvocation: DashboardStateView["dashboardFocus"];
    capabilities.shellHandle = () => {
      focusAtInvocation = store.state.getState().dashboardFocus;
      return dashboardExecution({ kind: "success" });
    };
    const store = createTestDashboardRuntime({
      service: new FakeTuiObserverService(snapshot),
      initialSnapshot: snapshot,
      capabilities,
    });

    store.actions.dispatch({
      type: "dashboard.cell.activate",
      rowId: dashboardRowIds.project("web"),
      cellId: "shell",
    });

    expect(focusAtInvocation).toEqual({
      rowId: dashboardRowIds.project("web"),
      cellId: "shell",
    });
    expect(capabilities.shellRequests).toEqual([{ kind: "project", projectId: "web" }]);
  });

  it("retains deliberate New Session on failure without an optimistic root row", async () => {
    const snapshot = createDashboardSnapshot();
    const capabilities = createFakeDashboardCapabilities();
    capabilities.createHandle = () =>
      dashboardExecution({
        kind: "failure",
        disposition: "remove-immediately",
        error: {
          tag: "CommandValidationError",
          code: "SESSION_GROUP_NOT_FOUND",
          message: "The selected Group no longer exists.",
        },
      });
    const store = createTestDashboardRuntime({
      service: new FakeTuiObserverService(snapshot),
      initialSnapshot: snapshot,
      capabilities,
    });

    store.actions.handleKey({ input: "N" });
    store.actions.handleKey({ input: "C" });

    await waitFor(() =>
      store.state
        .getState()
        .toasts.some((entry) => entry.toast.message === "The selected Group no longer exists."),
    );
    expect(store.state.getState().screen).toMatchObject({
      name: "newSession",
      flow: { mode: "review", reviewFocus: "group" },
    });
    expect(store.state.getState().localRows.pendingCreate).toEqual([]);
    expect(store.state.getState().localRows.failedCreate).toEqual([]);
  });

  it("closes deliberate New Session only after successful settlement", async () => {
    const snapshot = createDashboardSnapshot();
    const capabilities = createFakeDashboardCapabilities();
    const completion = deferred<Awaited<ReturnType<typeof dashboardExecution>["completion"]>>();
    capabilities.createHandle = () => dashboardExecution(completion.promise);
    const store = createTestDashboardRuntime({
      service: new FakeTuiObserverService(snapshot),
      initialSnapshot: snapshot,
      capabilities,
    });

    store.actions.handleKey({ input: "N" });
    store.actions.handleKey({ input: "C" });
    expect(store.state.getState().screen).toMatchObject({
      name: "newSession",
      flow: { mode: "review", submissionLocalId: expect.any(String) },
    });

    completion.resolve({ kind: "success" });
    await waitFor(() => store.state.getState().screen.name === "dashboard");
    expect(store.state.getState().localRows.pendingCreate).toEqual([]);
  });

  it("applies Quick Session optimistic state synchronously after screen focus", () => {
    const snapshot = createZeroWorktreeSnapshot();
    const capabilities = createFakeDashboardCapabilities();
    capabilities.quickCreateHandle = () =>
      dashboardExecution(new Promise(() => {}), {
        optimistic: "pending-create",
        successDisposition: "wait-for-canonical",
      });
    const store = createTestDashboardRuntime({
      service: new FakeTuiObserverService(snapshot),
      initialSnapshot: snapshot,
      capabilities,
    });

    store.actions.dispatch({
      type: "dashboard.cell.activate",
      rowId: dashboardRowIds.empty("web"),
      cellId: "addSession",
    });

    expect(store.state.getState().dashboardFocus).toEqual({
      rowId: dashboardRowIds.empty("web"),
      cellId: "addSession",
    });
    expect(store.state.getState().localRows.pendingCreate).toHaveLength(1);
    expect(capabilities.quickCreateRequests).toHaveLength(1);
  });

  it("owns failed optimistic rows without exposing mutation methods", async () => {
    vi.useFakeTimers();
    const snapshot = createZeroWorktreeSnapshot();
    const capabilities = createFakeDashboardCapabilities();
    const error: SafeError = {
      tag: "StationLaunchError",
      code: "HOSTED_CREATE_FAILED",
      message: "The hosted create failed.",
    };
    capabilities.quickCreateHandle = () =>
      dashboardExecution(
        { kind: "failure", error, disposition: "retain-failed" },
        { optimistic: "pending-create" },
      );
    const store = createTestDashboardRuntime({
      service: new FakeTuiObserverService(snapshot),
      initialSnapshot: snapshot,
      capabilities,
      initialState: { terminalRows: 42 },
    });

    store.actions.dispatch({
      type: "dashboard.cell.activate",
      rowId: dashboardRowIds.empty("web"),
      cellId: "addSession",
    });
    expect(store.state.getState().localRows.pendingCreate).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.state.getState().localRows.failedCreate).toHaveLength(1);
    expect(store.state.getState().localRows.failedCreate[0]?.error).toEqual(error);
    expect(store.actions).not.toHaveProperty("addPendingCreateSession");
    expect(store.actions).not.toHaveProperty("failPendingCreateSession");
    expect(store.actions).not.toHaveProperty("removePendingCreateSession");
    expect(store.state.getState().terminalRows).toBe(42);
    expect(vi.getTimerCount()).toBe(1);
    await store.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drains admitted capability work while blocking late state writes and actions", async () => {
    const snapshot = createZeroWorktreeSnapshot();
    const capabilities = createFakeDashboardCapabilities();
    const completion = deferred<Awaited<ReturnType<typeof dashboardExecution>["completion"]>>();
    capabilities.quickCreateHandle = () =>
      dashboardExecution(completion.promise, { optimistic: "pending-create" });
    const store = createTestDashboardRuntime({
      service: new FakeTuiObserverService(snapshot),
      initialSnapshot: snapshot,
      capabilities,
    });

    store.actions.dispatch({
      type: "dashboard.cell.activate",
      rowId: dashboardRowIds.empty("web"),
      cellId: "addSession",
    });
    expect(store.state.getState().localRows.pendingCreate).toHaveLength(1);
    const stateAtDisposal = store.state.getState();
    const firstDisposal = store.dispose();
    const secondDisposal = store.dispose();

    store.actions.dispatch({
      type: "dashboard.cell.activate",
      rowId: dashboardRowIds.empty("web"),
      cellId: "addSession",
    });
    store.actions.pushToast({ kind: "info", message: "late" });
    expect(secondDisposal).toBe(firstDisposal);
    expect(capabilities.quickCreateRequests).toHaveLength(1);
    expect(store.state.getState()).toBe(stateAtDisposal);

    let disposed = false;
    void observeSettlement(firstDisposal, () => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    completion.resolve({ kind: "success" });
    await firstDisposal;
    expect(store.state.getState()).toBe(stateAtDisposal);
  });

  it("uses one four-second scheduler for multiple failed create rows", async () => {
    vi.useFakeTimers();
    const baseSnapshot = createZeroWorktreeSnapshot();
    const project = baseSnapshot.projects[0];
    if (project === undefined) throw new Error("project fixture missing");
    const snapshot: StationSnapshot = {
      ...baseSnapshot,
      projects: [
        project,
        {
          ...project,
          id: "api",
          label: "api",
          root: "/Users/example/Developer/api",
        },
      ],
    };
    const capabilities = createFakeDashboardCapabilities();
    capabilities.quickCreateHandle = () =>
      dashboardExecution(
        {
          kind: "failure",
          disposition: "retain-failed",
          error: {
            tag: "CommandExecutionError",
            code: "CREATE_FAILED",
            message: "Create failed.",
          },
        },
        { optimistic: "pending-create" },
      );
    const store = createTestDashboardRuntime({
      service: new FakeTuiObserverService(snapshot),
      initialSnapshot: snapshot,
      capabilities,
    });

    store.actions.dispatch({
      type: "dashboard.cell.activate",
      rowId: dashboardRowIds.empty("web"),
      cellId: "addSession",
    });
    await vi.advanceTimersByTimeAsync(1);
    store.actions.dispatch({
      type: "dashboard.cell.activate",
      rowId: dashboardRowIds.empty("api"),
      cellId: "addSession",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(store.state.getState().localRows.failedCreate).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(3_998);
    expect(store.state.getState().localRows.failedCreate).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.state.getState().localRows.failedCreate).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.state.getState().localRows.failedCreate).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    await store.dispose();
  });

  it("seeds from the canonical source and cleans up its subscription", () => {
    const snapshot = createCommandSnapshot("idle");
    const source = new FakeClientStateSource(snapshot);
    const store = createTestDashboardRuntime({
      service: new FakeTuiObserverService(snapshot),
      source,
    });

    expect(store.state.getState().snapshot).toBe(snapshot);
    store.start();
    expect(source.subscribeCount).toBe(1);
    store.dispose();
    expect(source.unsubscribeCount).toBe(1);
  });

  it("projects canonical source snapshots without replacing dashboard-local state", () => {
    const snapshot = createCommandSnapshot("idle");
    const source = new FakeClientStateSource(snapshot);
    const store = createTestDashboardRuntime({
      service: new FakeTuiObserverService(snapshot),
      source,
      initialState: {
        persistentFilter: { query: "idle" },
        collapsedProjectIds: ["web"],
        localRows: {
          ...createEmptyTuiLocalRows(),
          pendingCreate: [
            {
              localId: "local-source-projection",
              projectId: "web",
              title: "optimistic session",
              branch: "optimistic-session",
              harnessProvider: "codex",
              createdAt: fixtureNow,
            },
          ],
        },
      },
    });
    store.start();
    const updated: StationSnapshot = {
      ...snapshot,
      rows: snapshot.rows.map((row) => ({
        ...row,
        display: {
          statusLabel: "working",
          sortPriority: 30,
          alert: false,
          reason: "Harness reported active generation.",
        },
      })),
    };

    source.setSnapshot(updated);

    const projected = store.state.getState();
    expect(projected.snapshot).toBe(updated);
    expect(projected.persistentFilter).toEqual({ query: "idle" });
    expect(projected.collapsedProjectIds.has("web")).toBe(true);
    expect(projected.localRows.pendingCreate[0]?.localId).toBe("local-source-projection");
    store.dispose();
  });

  it("marks an existing snapshot as display-only from canonical client state", () => {
    const snapshot = createCommandSnapshot("idle");
    const source = new FakeClientStateSource(snapshot);
    const store = createTestDashboardRuntime({
      service: new FakeTuiObserverService(snapshot),
      source,
    });
    store.start();

    source.setConnection({
      state: "displayOnly",
      since: Date.now(),
      lastError: connectSafeError(),
    });

    expect(store.state.getState().observerConnectionStatus.state).toBe("displayOnly");
    expect(store.state.getState().snapshot).toBe(snapshot);
    expect(store.state.getState().toasts).toEqual([]);
    store.dispose();
  });

  it("marks a snapshot-free client source as reconnecting without a toast", () => {
    const source = new FakeClientStateSource(undefined, { state: "loading", since: Date.now() });
    const store = createTestDashboardRuntime({
      service: new FakeTuiObserverService(createCommandSnapshot("idle")),
      source,
    });
    store.start();

    source.setConnection({
      state: "reconnecting",
      since: Date.now(),
      lastError: connectSafeError(),
    });

    expect(store.state.getState().observerConnectionStatus.state).toBe("reconnecting");
    expect(store.state.getState().snapshot).toBeUndefined();
    expect(store.state.getState().toasts).toEqual([]);
    store.dispose();
  });

  it("clears reconnect status after a successful snapshot and shows delayed recovery feedback", () => {
    const snapshot = createCommandSnapshot("idle");
    const source = mutableSnapshotSource({
      snapshot,
      connection: {
        state: "displayOnly",
        since: Date.now() - 1_501,
        lastError: connectSafeError(),
      },
    });
    const store = createTestDashboardRuntime({
      service: new FakeTuiObserverService(snapshot),
      source,
      initialSnapshot: snapshot,
    });
    store.start();

    source.setConnection({ state: "connected", since: Date.now() });

    expect(store.state.getState().observerConnectionStatus.state).toBe("connected");
    expect(
      store.state
        .getState()
        .toasts.some((entry) => entry.toast.message === "Observer reconnected."),
    ).toBe(true);
    store.dispose();
  });

  it("does not show recovery feedback for brief reconnect states", () => {
    const snapshot = createCommandSnapshot("idle");
    const source = mutableSnapshotSource({
      snapshot,
      connection: {
        state: "displayOnly",
        since: Date.now() - 100,
        lastError: connectSafeError(),
      },
    });
    const store = createTestDashboardRuntime({
      service: new FakeTuiObserverService(snapshot),
      source,
      initialSnapshot: snapshot,
    });
    store.start();

    source.setConnection({ state: "connected", since: Date.now() });

    expect(store.state.getState().observerConnectionStatus.state).toBe("connected");
    expect(store.state.getState().toasts).toEqual([]);
    store.dispose();
  });

  it("acknowledges a ready turn after successful focus", async () => {
    const snapshot = withTurnReadiness(createCommandSnapshot("idle"));
    const service = new FakeTuiObserverService(snapshot);
    const store = createTestDashboardRuntime({ service, initialSnapshot: snapshot });

    store.actions.handleKey({ input: "1" });

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

  it.each([
    ["rejected", "The readiness acknowledgment was rejected."],
    ["failed", "The readiness acknowledgment failed."],
    ["thrown", "The readiness acknowledgment was unavailable."],
  ] as const)("keeps the popup open when readiness acknowledgment is %s", async (failure, message) => {
    const snapshot = withTurnReadiness(createCommandSnapshot("idle"));
    const service = new ReadinessFailureService(snapshot, failure);
    let focusSuccessCount = 0;
    const store = createTestDashboardRuntime({
      service,
      initialSnapshot: snapshot,
      persistentPopup: true,
      resolveFocusTarget: async () => ({
        origin: { provider: "fixture-terminal", clientId: "client-current" },
        onFocusSuccess: async () => {
          focusSuccessCount += 1;
        },
      }),
    });

    store.actions.handleKey({ input: "1" });

    await waitFor(() =>
      store.state.getState().toasts.some((entry) => entry.toast.message === message),
    );
    expect(focusSuccessCount).toBe(0);
    expect(store.state.getState().screen).toEqual({ name: "dashboard" });
    expect(service.dispatched.map((command) => command.type)).toEqual([
      "terminal.focus",
      "session.acknowledgeTurn",
    ]);
  });

  it("resolves current focus, completes focus and readiness, then dismisses", async () => {
    const snapshot = withTurnReadiness(createCommandSnapshot("idle"));
    const order: string[] = [];
    const service = new OrderedFocusService(snapshot, order);
    const store = createTestDashboardRuntime({
      service,
      initialSnapshot: snapshot,
      persistentPopup: true,
      resolveFocusTarget: async () => {
        order.push("resolve-origin");
        return {
          origin: { provider: "fixture-terminal", clientId: "client-current" },
          onFocusSuccess: async () => {
            order.push("dismiss");
          },
        };
      },
    });

    store.actions.handleKey({ input: "1" });

    await waitFor(() => order.includes("dismiss"));
    expect(order).toEqual([
      "resolve-origin",
      "dispatch:terminal.focus",
      "wait:cmd_focus",
      "dispatch:session.acknowledgeTurn",
      "wait:cmd_ack",
      "dismiss",
    ]);
    expect(service.dispatched[0]).toEqual({
      type: "terminal.focus",
      payload: {
        sessionId: "ses_wt_web_idle",
        origin: { provider: "fixture-terminal", clientId: "client-current" },
      },
    });
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
    let focusSuccessCount = 0;
    const store = createTestDashboardRuntime({
      service,
      initialSnapshot: snapshot,
      persistentPopup: true,
      onFocusSuccess: async () => {
        focusSuccessCount += 1;
      },
    });

    store.actions.handleKey({ input: "1" });

    await waitFor(() => service.waitedForCommandIds.length === 1);
    expect(service.dispatched).toEqual([
      { type: "terminal.focus", payload: { sessionId: "ses_wt_web_idle" } },
    ]);
    expect(focusSuccessCount).toBe(0);
  });

  it("leaves a persistent popup open when focus-target resolution fails", async () => {
    const snapshot = createCommandSnapshot("idle");
    const service = new FakeTuiObserverService(snapshot);
    let focusSuccessCount = 0;
    const store = createTestDashboardRuntime({
      service,
      initialSnapshot: snapshot,
      persistentPopup: true,
      resolveFocusTarget: async () => {
        throw {
          tag: "TuiRendererControlError",
          code: "TUI_POPUP_FOCUS_ORIGIN_UNAVAILABLE",
          message: "The current popup origin could not be resolved.",
        } satisfies SafeError;
      },
      onFocusSuccess: async () => {
        focusSuccessCount += 1;
      },
    });

    store.actions.handleKey({ input: "1" });

    await waitFor(() =>
      store.state
        .getState()
        .toasts.some(
          (entry) => entry.toast.message === "The current popup origin could not be resolved.",
        ),
    );
    expect(service.dispatched).toEqual([]);
    expect(focusSuccessCount).toBe(0);
    expect(store.state.getState().screen).toEqual({ name: "dashboard" });
  });

  it("does not exit after a target-scoped focus-success callback fails", async () => {
    const snapshot = createCommandSnapshot("idle");
    const service = new FakeTuiObserverService(snapshot);
    const exitCodes: number[] = [];
    const store = createTestDashboardRuntime({
      service,
      initialSnapshot: snapshot,
      exitOnFocusSuccess: true,
      resolveFocusTarget: async () => ({
        origin: { provider: "fixture-terminal", clientId: "client-current" },
        onFocusSuccess: async () => {
          throw {
            tag: "TuiRendererControlError",
            code: "TUI_POPUP_FOCUS_TARGET_STALE",
            message: "The popup focus target changed before dismissal.",
          } satisfies SafeError;
        },
      }),
      onExit: (code) => exitCodes.push(code),
    });

    store.actions.handleKey({ input: "1" });

    await waitFor(() =>
      store.state
        .getState()
        .toasts.some(
          (entry) => entry.toast.message === "The popup focus target changed before dismissal.",
        ),
    );
    expect(exitCodes).toEqual([]);
  });

  it("leaves a persistent popup open and shows a toast when dismissal fails", async () => {
    const snapshot = createCommandSnapshot("idle");
    const service = new FakeTuiObserverService(snapshot);
    const exitCodes: number[] = [];
    const store = createTestDashboardRuntime({
      service,
      initialSnapshot: snapshot,
      persistentPopup: true,
      onDismiss: async () => {
        throw {
          tag: "TuiRendererControlError",
          code: "TUI_POPUP_DISMISS_FAILED",
          message: "The popup could not be dismissed.",
        } satisfies SafeError;
      },
      onExit: (code) => exitCodes.push(code),
    });

    const result = store.actions.handleKey({ input: "Q" });

    expect(result).toBeUndefined();
    await waitFor(() =>
      store.state
        .getState()
        .toasts.some((entry) => entry.toast.message === "The popup could not be dismissed."),
    );
    expect(exitCodes).toEqual([]);
    expect(store.state.getState().snapshot).toBe(snapshot);
    expect(store.state.getState().screen).toEqual({ name: "dashboard" });
  });

  it("does not treat a retained no-agent session as completed start truth", async () => {
    const snapshot = createCommandSnapshot("none");
    const service = new FakeTuiObserverService(snapshot);
    const store = createTestDashboardRuntime({ service, initialSnapshot: snapshot });

    store.actions.handleKey({ input: "1" });

    await waitFor(() => service.loadCount === 1);
    expect(store.state.getState().localRows.pendingStart).toHaveLength(1);
    expect(service.dispatched).toEqual([expect.objectContaining({ type: "session.startAgent" })]);
  });

  it("syncs terminal rows into view state and clamps dashboard scroll", () => {
    const snapshot = createDashboardSnapshot();
    const service = new FakeTuiObserverService(snapshot);
    const store = createTestDashboardRuntime({
      service,
      initialSnapshot: snapshot,
      initialState: {
        scrollOffset: 8,
        terminalRows: 10,
      },
    });

    store.actions.setTerminalRows(24);

    expect(store.state.getState().terminalRows).toBe(24);
    expect(store.state.getState().scrollOffset).toBe(0);
  });

  it("uses the local folder service and dispatches project.add after confirmation", async () => {
    const snapshot = createNoProjectsSnapshot();
    const service = new FakeTuiObserverService(snapshot);
    const folderService = fakeFolderService();
    const store = createTestDashboardRuntime({
      service,
      initialSnapshot: snapshot,
      folderService,
    });

    store.actions.handleKey({ input: "A" });
    expect(store.state.getState().screen).toMatchObject({ name: "addProject" });

    store.actions.handleKey({ input: "", rightArrow: true });
    await waitFor(() => screenMode(store.state.getState()) === "choose");
    expect(folderService.reads).toEqual(["/Users/example/Developer/station"]);

    store.actions.handleKey({ input: "", downArrow: true });
    store.actions.handleKey({ input: "\r", return: true });
    await waitFor(() => screenMode(store.state.getState()) === "review");

    store.actions.handleKey({ input: "N" });
    store.actions.handleKey({ input: "-custom" });
    store.actions.handleKey({ input: "\r", return: true });

    service.setSnapshot(createZeroWorktreeSnapshot());
    store.actions.handleKey({ input: "\r", return: true });
    await waitFor(() => screenMode(store.state.getState()) === "success");

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

  it("refreshes only the visible project directory and preserves selection by path", async () => {
    const snapshot = createNoProjectsSnapshot();
    const service = new FakeTuiObserverService(snapshot);
    let entries = folderEntries("alpha", "station");
    let failNextRead = false;
    const reads: string[] = [];
    const folderService = mutableFolderService(
      reads,
      (path) => {
        if (failNextRead) {
          failNextRead = false;
          throw new Error("transient directory read failure");
        }
        return { path, entries };
      },
      "/Users/example/Developer",
    );
    const store = createTestDashboardRuntime({
      service,
      source: staticSnapshotSource(snapshot),
      initialSnapshot: snapshot,
      folderService,
    });

    store.actions.handleKey({ input: "A" });
    store.actions.handleKey({ input: "", rightArrow: true });
    await waitFor(() => screenMode(store.state.getState()) === "choose");
    store.actions.handleKey({ input: "", downArrow: true });
    store.actions.handleKey({ input: "", downArrow: true });
    expect(selectedAddProjectPath(store.state.getState())).toBe("/Users/example/Developer/station");

    vi.useFakeTimers();
    store.start();
    entries = folderEntries("aardvark", "alpha", "station");
    await vi.advanceTimersByTimeAsync(ADD_PROJECT_DIRECTORY_POLL_INTERVAL_MS);

    expect(addProjectEntryNames(store.state.getState())).toEqual(["aardvark", "alpha", "station"]);
    expect(selectedAddProjectPath(store.state.getState())).toBe("/Users/example/Developer/station");

    let notifications = 0;
    const unsubscribe = store.state.subscribe(() => {
      notifications += 1;
    });
    await vi.advanceTimersByTimeAsync(ADD_PROJECT_DIRECTORY_POLL_INTERVAL_MS);
    expect(notifications).toBe(0);

    entries = folderEntries("aardvark", "renamed");
    failNextRead = true;
    await vi.advanceTimersByTimeAsync(ADD_PROJECT_DIRECTORY_POLL_INTERVAL_MS);
    expect(addProjectEntryNames(store.state.getState())).toEqual(["aardvark", "alpha", "station"]);
    expect(notifications).toBe(0);

    await vi.advanceTimersByTimeAsync(ADD_PROJECT_DIRECTORY_POLL_INTERVAL_MS);
    expect(addProjectEntryNames(store.state.getState())).toEqual(["aardvark", "renamed"]);
    expect(selectedAddProjectPath(store.state.getState())).toBe("/Users/example/Developer/renamed");

    store.actions.handleKey({ input: "", escape: true });
    const readsAfterClose = reads.length;
    await vi.advanceTimersByTimeAsync(ADD_PROJECT_DIRECTORY_POLL_INTERVAL_MS * 2);
    expect(reads).toHaveLength(readsAfterClose);

    unsubscribe();
    store.dispose();
  });

  it("does not overlap polls or apply a late result after directory navigation", async () => {
    const snapshot = createNoProjectsSnapshot();
    const service = new FakeTuiObserverService(snapshot);
    const rootPath = "/Users/example/Developer/station";
    const childPath = `${rootPath}/child`;
    const latePoll = deferred<TuiFolderReadResult>();
    const reads: string[] = [];
    const folderService = mutableFolderService(reads, (path) => {
      if (path === rootPath && reads.filter((read) => read === rootPath).length > 1) {
        return latePoll.promise;
      }
      return {
        path,
        entries: path === rootPath ? [folderEntry("child", childPath)] : [],
      };
    });
    const store = createTestDashboardRuntime({
      service,
      source: staticSnapshotSource(snapshot),
      initialSnapshot: snapshot,
      folderService,
    });

    store.actions.handleKey({ input: "A" });
    store.actions.handleKey({ input: "", rightArrow: true });
    await waitFor(() => screenMode(store.state.getState()) === "choose");

    vi.useFakeTimers();
    store.start();
    await vi.advanceTimersByTimeAsync(ADD_PROJECT_DIRECTORY_POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(ADD_PROJECT_DIRECTORY_POLL_INTERVAL_MS * 4);
    expect(reads.filter((path) => path === rootPath)).toHaveLength(2);

    store.actions.handleKey({ input: "", downArrow: true });
    store.actions.handleKey({ input: "", rightArrow: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(activeAddProjectPath(store.state.getState())).toBe(childPath);

    latePoll.resolve({ path: rootPath, entries: folderEntries("stale") });
    await vi.advanceTimersByTimeAsync(0);
    expect(activeAddProjectPath(store.state.getState())).toBe(childPath);
    expect(addProjectEntryNames(store.state.getState())).toEqual([]);

    store.dispose();
  });

  it("drains an in-flight directory read without a late write or reschedule", async () => {
    const snapshot = createNoProjectsSnapshot();
    const rootPath = "/Users/example/Developer/station";
    const latePoll = deferred<TuiFolderReadResult>();
    const reads: string[] = [];
    const folderService = mutableFolderService(reads, (path) => {
      if (reads.filter((read) => read === path).length > 1) {
        return latePoll.promise;
      }
      return { path, entries: folderEntries("initial") };
    });
    const store = createTestDashboardRuntime({
      service: new FakeTuiObserverService(snapshot),
      source: staticSnapshotSource(snapshot),
      initialSnapshot: snapshot,
      folderService,
    });

    store.actions.handleKey({ input: "A" });
    store.actions.handleKey({ input: "", rightArrow: true });
    await waitFor(() => screenMode(store.state.getState()) === "choose");
    expect(activeAddProjectPath(store.state.getState())).toBe(rootPath);

    vi.useFakeTimers();
    store.start();
    await vi.advanceTimersByTimeAsync(ADD_PROJECT_DIRECTORY_POLL_INTERVAL_MS);
    expect(reads).toHaveLength(2);
    const stateAtDisposal = store.state.getState();
    const disposal = store.dispose();
    expect(vi.getTimerCount()).toBe(0);

    let disposed = false;
    void observeSettlement(disposal, () => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    latePoll.resolve({ path: rootPath, entries: folderEntries("late") });
    await disposal;
    expect(store.state.getState()).toBe(stateAtDisposal);
    await vi.advanceTimersByTimeAsync(ADD_PROJECT_DIRECTORY_POLL_INTERVAL_MS * 2);
    expect(reads).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("opens the explicit first-project flow with Enter on an empty dashboard", () => {
    const snapshot = createNoProjectsSnapshot();
    const service = new FakeTuiObserverService(snapshot);
    const store = createTestDashboardRuntime({
      service,
      initialSnapshot: snapshot,
      folderService: fakeFolderService(),
    });

    store.actions.handleKey({ input: "\r", return: true });

    expect(store.state.getState().screen).toMatchObject({
      name: "addProject",
      flow: { mode: "start", firstProject: true },
    });
  });

  it("sets a project default harness, refreshes the snapshot, and shows success", async () => {
    const snapshot = createDashboardSnapshot();
    const service = new FakeTuiObserverService(snapshot);
    service.setSnapshot(snapshotWithProjectHarness(snapshot, "web", "opencode"));
    const store = createTestDashboardRuntime({ service, initialSnapshot: snapshot });

    store.actions.dispatch({ type: "projectDefaultAgent.open", projectId: "web" });
    store.actions.handleKey({ input: "2" });

    await waitFor(() => service.loadCount === 1);
    expect(service.dispatched).toEqual([
      {
        type: "project.setDefaultHarness",
        payload: { projectId: "web", harness: "opencode" },
      },
    ]);
    expect(service.waitedForCommandIds).toEqual(["cmd_tui_1"]);
    expect(store.state.getState().snapshot?.projects[0]?.defaults.harness).toBe("opencode");
    expect(store.state.getState().toasts.map((entry) => entry.toast)).toContainEqual(
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
    const store = createTestDashboardRuntime({ service, initialSnapshot: snapshot });

    store.actions.dispatch({ type: "projectDefaultAgent.open", projectId: "web" });
    store.actions.handleKey({ input: "2" });

    await waitFor(() =>
      store.state
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
    const store = createTestDashboardRuntime({ service, initialSnapshot: snapshot });

    store.actions.dispatch({ type: "projectDefaultAgent.open", projectId: "web" });
    store.actions.handleKey({ input: "2" });

    await waitFor(() =>
      store.state
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
    const store = createTestDashboardRuntime({ service, initialSnapshot: snapshot });

    store.actions.dispatch({ type: "projectDefaultAgent.open", projectId: "web" });
    store.actions.handleKey({ input: "2" });

    await waitFor(() =>
      store.state
        .getState()
        .toasts.some((entry) => entry.toast.message === "Observer socket closed."),
    );
    expect(service.waitedForCommandIds).toEqual([]);
    expect(service.loadCount).toBe(0);
  });

  it("shows one local toast when a default-harness command fails completion", async () => {
    const snapshot = createDashboardSnapshot();
    const service = new FakeTuiObserverService(snapshot);
    const failure: SafeError = {
      tag: "ProjectConfigError",
      code: "PROJECT_DEFAULT_HARNESS_OVERRIDDEN",
      message: "Project-local config keeps claude effective.",
    };
    service.nextCompletion = { status: "failed", commandId: "cmd_tui_1", error: failure };
    const store = createTestDashboardRuntime({ service, initialSnapshot: snapshot });

    store.actions.dispatch({ type: "projectDefaultAgent.open", projectId: "web" });
    store.actions.handleKey({ input: "2" });

    await waitFor(() => service.waitedForCommandIds.includes("cmd_tui_1"));
    await waitFor(
      () =>
        store.state.getState().toasts.filter((entry) => entry.toast.message === failure.message)
          .length === 1,
    );
    expect(
      store.state.getState().toasts.filter((entry) => entry.toast.message === failure.message),
    ).toHaveLength(1);
  });

  it("reviews a pasted full path when folder filtering has no matches", async () => {
    const snapshot = createNoProjectsSnapshot();
    const service = new FakeTuiObserverService(snapshot);
    const folderService = fakeFolderService();
    const store = createTestDashboardRuntime({
      service,
      initialSnapshot: snapshot,
      folderService,
    });

    store.actions.handleKey({ input: "A" });
    store.actions.handleKey({ input: "", rightArrow: true });
    await waitFor(() => screenMode(store.state.getState()) === "choose");

    store.actions.handleKey({ input: "/" });
    store.actions.handleKey({ input: "/Users/example/Developer/synth" });
    store.actions.handleKey({ input: "\r", return: true });
    await waitFor(() => screenMode(store.state.getState()) === "review");

    expect(folderService.reviews).toEqual(["/Users/example/Developer/synth"]);
    expect(store.state.getState().screen).toMatchObject({
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
    const store = createTestDashboardRuntime({
      service,
      initialSnapshot: snapshot,
      folderService,
    });

    store.actions.handleKey({ input: "A" });
    store.actions.handleKey({ input: "", downArrow: true });
    store.actions.handleKey({ input: "\r", return: true });
    await waitFor(() => screenMode(store.state.getState()) === "choose");

    expect(folderService.reads).toEqual(["/Users/example"]);
    expect(store.state.getState().screen).toMatchObject({
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
    const store = createTestDashboardRuntime({
      service,
      initialSnapshot: snapshot,
      folderService,
    });

    store.actions.handleKey({ input: "A" });
    store.actions.handleKey({ input: "\r", return: true });
    await waitFor(() => screenMode(store.state.getState()) === "choose");

    store.actions.handleKey({ input: "/" });
    store.actions.handleKey({ input: "Germ" });
    await waitFor(() => addProjectSearchResultCount(store.state.getState()) === 1);

    store.actions.handleKey({ input: "\r", return: true });
    await waitFor(() => screenMode(store.state.getState()) === "review");

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

function staticSnapshotSource(snapshot: StationSnapshot): StationClientStateSource {
  return new FakeClientStateSource(snapshot);
}

function mutableSnapshotSource(initial: StationClientState): FakeClientStateSource {
  return new FakeClientStateSource(initial.snapshot, initial.connection);
}

function mutableFolderService(
  reads: string[],
  readDirectory: (path: string) => TuiFolderReadResult | Promise<TuiFolderReadResult>,
  cwd = "/Users/example/Developer/station",
): TuiFolderService {
  return {
    cwd: () => cwd,
    homeDir: () => "/Users/example",
    parent: (path) => path.split("/").slice(0, -1).join("/") || "/",
    readDirectory: async (path) => {
      reads.push(path);
      return readDirectory(path);
    },
    searchDirectories: async (query) => ({ query, entries: [], truncated: false }),
    reviewFolder: async (path) => ({ selectedPath: path, id: "project", label: "project" }),
  };
}

function folderEntries(...names: string[]): TuiFolderEntry[] {
  return names.map((name) => folderEntry(name, `/Users/example/Developer/${name}`));
}

function folderEntry(name: string, path: string): TuiFolderEntry {
  return { name, path, kind: "directory" };
}

function selectedAddProjectPath(state: DashboardStateView): string | undefined {
  return selectedAddProjectFolderRow(state)?.path;
}

function activeAddProjectPath(state: DashboardStateView): string | undefined {
  return state.screen.name === "addProject" && state.screen.flow.mode === "choose"
    ? state.screen.flow.currentPath
    : undefined;
}

function addProjectEntryNames(state: DashboardStateView): string[] {
  return state.screen.name === "addProject" && state.screen.flow.mode === "choose"
    ? state.screen.flow.entries.map((entry) => entry.name)
    : [];
}

async function observeSettlement(settlement: Promise<void>, observe: () => void): Promise<void> {
  await settlement;
  observe();
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
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

function screenMode(state: DashboardStateView) {
  return state.screen.name === "addProject" ? state.screen.flow.mode : undefined;
}

function addProjectSearchResultCount(state: DashboardStateView) {
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

class OrderedFocusService extends FakeTuiObserverService {
  constructor(
    snapshot: StationSnapshot,
    private readonly order: string[],
  ) {
    super(snapshot);
  }

  override async dispatch(command: StationCommand) {
    this.order.push(`dispatch:${command.type}`);
    this.nextReceipt = {
      commandId: command.type === "terminal.focus" ? "cmd_focus" : "cmd_ack",
      accepted: true,
      status: "accepted",
    };
    return super.dispatch(command);
  }

  override async waitForCommandCompletion(commandId: string) {
    this.order.push(`wait:${commandId}`);
    return {
      status: "succeeded" as const,
      commandId,
    };
  }
}

class ReadinessFailureService extends FakeTuiObserverService {
  constructor(
    snapshot: StationSnapshot,
    private readonly failure: "rejected" | "failed" | "thrown",
  ) {
    super(snapshot);
  }

  override async dispatch(command: StationCommand) {
    this.dispatched.push(command);
    if (command.type === "terminal.focus") {
      return { accepted: true as const, commandId: "cmd_focus", status: "accepted" as const };
    }
    if (this.failure === "thrown") {
      throw {
        tag: "ObserverCommandError",
        code: "READINESS_ACK_UNAVAILABLE",
        message: "The readiness acknowledgment was unavailable.",
      } satisfies SafeError;
    }
    if (this.failure === "rejected") {
      return {
        accepted: false as const,
        commandId: "cmd_ack",
        status: "rejected" as const,
        error: {
          tag: "ObserverCommandError",
          code: "READINESS_ACK_REJECTED",
          message: "The readiness acknowledgment was rejected.",
        } satisfies SafeError,
      };
    }
    return { accepted: true as const, commandId: "cmd_ack", status: "accepted" as const };
  }

  override async waitForCommandCompletion(commandId: string) {
    this.waitedForCommandIds.push(commandId);
    if (commandId === "cmd_ack" && this.failure === "failed") {
      return {
        status: "failed" as const,
        commandId,
        error: {
          tag: "ObserverCommandError",
          code: "READINESS_ACK_FAILED",
          message: "The readiness acknowledgment failed.",
        } satisfies SafeError,
      };
    }
    return { status: "succeeded" as const, commandId };
  }
}

function connectSafeError(): SafeError {
  return {
    tag: "ProtocolError",
    code: "PROTOCOL_CONNECT_FAILED",
    message: "Could not connect to observer socket /tmp/station-test.sock.",
  };
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  for (;;) {
    if (assertion()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for assertion");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
