import { describe, expect, it } from "bun:test";
import { createTuiStore } from "@station/dashboard-core";
import { resolveInitialState } from "../../state/initialState.js";
import { manyProjectsSnapshot } from "../fixtures/scenarios.js";
import { FakeTuiObserverService } from "../test/support/fakeObserverService.js";
import { FakeStationSource } from "../test/support/fakeStationSource.js";
import { resolveKeyFocusedRowAgentTarget } from "./stationActions.js";
import { createStationOverlayLayer } from "./stationOverlayLayer.js";

// Station opens rows as managed pane launches (not the machine's
// terminal.focus, which Station-hosted panes can't honor). Enter on the
// focused cursor row must resolve to the same RowAgentTarget a slot key or
// click does; anything unresolved falls through to the shared machine.
function newStore() {
  const snapshot = manyProjectsSnapshot();
  return createTuiStore({
    source: new FakeStationSource(snapshot),
    service: new FakeTuiObserverService(snapshot),
    initialSnapshot: snapshot,
    persistentPopup: true,
    onDismiss: async () => {},
  });
}

function focusFirstSession(store: ReturnType<typeof newStore>): string {
  store.getState().handleKey({ input: "", downArrow: true });
  store.getState().handleKey({ input: "", downArrow: true });
  const focus = store.getState().dashboardFocus;
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
    shellStore.getState().handleKey({ input: "", downArrow: true });
    shellStore.getState().handleKey({ input: "", rightArrow: true });
    expect(
      createStationOverlayLayer(shellStore).catchAll?.("\r", resolveInitialState()),
    ).toEqual({
      kind: "pane-open",
      paneId: "pane-proj-station",
      cwd: "/Users/example/Developer/station",
      role: "shell",
    });

    const quickStore = newStore();
    quickStore.getState().handleKey({ input: "", downArrow: true });
    quickStore.getState().handleKey({ input: "", rightArrow: true });
    quickStore.getState().handleKey({ input: "", rightArrow: true });
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

  it("is inert while an operation is pending on the focused row", () => {
    const store = newStore();
    const focusedSessionId = focusFirstSession(store);
    const worktreeId = store
      .getState()
      .snapshot?.sessions.find((session) => session.id === focusedSessionId)?.worktreeId;
    if (worktreeId === undefined) {
      throw new Error("Expected the focused session's worktree.");
    }
    store.setState({
      localRows: {
        ...store.getState().localRows,
        pendingStart: [
          {
            localId: `start:${worktreeId}`,
            operation: "startAgent",
            projectId: "station",
            worktreeId,
            branch: "station-overlay",
            createdAt: "2026-07-02T12:00:00.000Z",
          },
        ],
      },
    });
    expect(resolveKeyFocusedRowAgentTarget(store, "\r").kind).toBe("none");
  });
});
