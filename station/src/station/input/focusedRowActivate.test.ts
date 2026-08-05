import { describe, expect, it } from "bun:test";
import {
  createEmptyTuiLocalRows,
  type DashboardRuntimeOptions,
} from "@station/dashboard-core";
import { resolveInitialState } from "../../state/initialState.js";
import { manyProjectsSnapshot } from "../fixtures/scenarios.js";
import { FakeTuiObserverService } from "../test/support/fakeObserverService.js";
import { FakeStationSource } from "../test/support/fakeStationSource.js";
import { createStationTestDashboardRuntime } from "../test/support/makeStationTestRuntime.js";
import { resolveKeyFocusedRowAgentTarget, resolveQuickSessionSubmit } from "./stationActions.js";
import { createStationOverlayLayer } from "./stationOverlayLayer.js";

// Station opens rows as managed pane launches (not the machine's
// terminal.focus, which Station-hosted panes can't honor). Enter on the
// focused cursor row must resolve to the same RowAgentTarget a slot key or
// click does; anything unresolved falls through to the shared machine.
function newStore(
  snapshot = manyProjectsSnapshot(),
  initialState?: DashboardRuntimeOptions["initialState"],
) {
  return createStationTestDashboardRuntime({
    source: new FakeStationSource(snapshot),
    service: new FakeTuiObserverService(snapshot),
    initialSnapshot: snapshot,
    ...(initialState === undefined ? {} : { initialState }),
    persistentPopup: true,
    onDismiss: async () => {},
  });
}

function focusFirstSession(store: ReturnType<typeof newStore>): string {
  store.actions.handleKey({ input: "", downArrow: true });
  store.actions.handleKey({ input: "", downArrow: true });
  const focus = store.state.getState().dashboardFocus;
  if (focus?.kind !== "session") {
    throw new Error("Expected a focused session row.");
  }
  return focus.sessionId;
}

describe("resolveKeyFocusedRowAgentTarget", () => {
  it("resolves Enter on the focused row to its managed launch", () => {
    const store = newStore();
    const focusedSessionId = focusFirstSession(store);

    const target = resolveKeyFocusedRowAgentTarget(store, "\r");
    expect(target).toMatchObject({ kind: "launch-managed", rowId: focusedSessionId });
  });

  it("stays with the machine when nothing is focused or the key is not Enter", () => {
    const unfocused = newStore();
    expect(resolveKeyFocusedRowAgentTarget(unfocused, "\r").kind).toBe("none");

    const focused = newStore();
    focusFirstSession(focused);
    expect(resolveKeyFocusedRowAgentTarget(focused, "x").kind).toBe("none");
  });

  it("maps focused project shell and Quick Session Enter to native router outcomes", () => {
    const shellStore = newStore();
    shellStore.actions.handleKey({ input: "", downArrow: true });
    shellStore.actions.handleKey({ input: "", rightArrow: true });
    expect(
      createStationOverlayLayer(shellStore).catchAll?.("\r", resolveInitialState()),
    ).toEqual({
      kind: "pane-open",
      paneId: "pane-proj-station",
      cwd: "/Users/example/Developer/station",
      role: "shell",
    });

    const quickStore = newStore();
    quickStore.actions.handleKey({ input: "", downArrow: true });
    quickStore.actions.handleKey({ input: "", rightArrow: true });
    quickStore.actions.handleKey({ input: "", rightArrow: true });
    const quick = createStationOverlayLayer(quickStore).catchAll?.(
      "\r",
      resolveInitialState(),
    );
    expect(quick).toMatchObject({
      kind: "pane-launch-new-session",
      projectId: "station",
      harness: "codex",
    });
  });

  it("maps focused empty-project Enter to the native Quick Session executor", () => {
    const store = newStore(manyProjectsSnapshot(), {
      dashboardFocus: { kind: "emptyProjectAction", projectId: "empty-project" },
    });

    expect(createStationOverlayLayer(store).catchAll?.("\r", resolveInitialState())).toMatchObject({
      kind: "pane-launch-new-session",
      projectId: "empty-project",
      harness: "codex",
    });
    expect(store.state.getState().dashboardFocus).toEqual({
      kind: "projectHeader",
      projectId: "empty-project",
      control: "quickSession",
    });
  });

  it("resolves empty-project Quick Session availability at the native consumer", () => {
    const available = newStore(manyProjectsSnapshot(), {
      dashboardFocus: { kind: "emptyProjectAction", projectId: "empty-project" },
    });

    expect(resolveQuickSessionSubmit(available, "empty-project")).toMatchObject({
      kind: "submit",
      projectId: "empty-project",
    });
    expect(available.state.getState().dashboardFocus).toEqual({
      kind: "projectHeader",
      projectId: "empty-project",
      control: "quickSession",
    });

    const snapshot = manyProjectsSnapshot();
    const blocked = newStore(
      {
        ...snapshot,
        projects: snapshot.projects.map((project) =>
          project.id === "empty-project"
            ? { ...project, health: { ...project.health, status: "unavailable" as const } }
            : project,
        ),
      },
      { dashboardFocus: { kind: "emptyProjectAction", projectId: "empty-project" } },
    );

    expect(resolveQuickSessionSubmit(blocked, "empty-project")).toEqual({ kind: "none" });
    expect(blocked.state.getState().dashboardFocus).toEqual({
      kind: "emptyProjectAction",
      projectId: "empty-project",
    });
    expect(blocked.state.getState().toasts.at(-1)?.toast.kind).toBe("error");
  });

  it("is inert while an operation is pending on the focused row", () => {
    const snapshot = manyProjectsSnapshot();
    const session = snapshot.sessions[0];
    if (session === undefined) {
      throw new Error("Expected a session fixture.");
    }
    const store = newStore(snapshot, {
      dashboardFocus: { kind: "session", sessionId: session.id },
      localRows: {
        ...createEmptyTuiLocalRows(),
        pendingStart: [
          {
            localId: `start:${session.worktreeId}`,
            operation: "startAgent",
            projectId: session.projectId,
            worktreeId: session.worktreeId,
            branch: "station-overlay",
            createdAt: "2026-07-02T12:00:00.000Z",
          },
        ],
      },
    });
    expect(resolveKeyFocusedRowAgentTarget(store, "\r").kind).toBe("none");
  });
});
