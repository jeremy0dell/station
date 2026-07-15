import { describe, expect, it } from "bun:test";
import { createTuiStore } from "@station/dashboard-core";
import { manyProjectsSnapshot } from "../fixtures/scenarios.js";
import { FakeTuiObserverService } from "../test/support/fakeObserverService.js";
import { FakeStationSource } from "../test/support/fakeStationSource.js";
import { resolveKeyFocusedRowAgentTarget } from "./stationActions.js";

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

describe("resolveKeyFocusedRowAgentTarget", () => {
  it("resolves Enter on the focused row to its managed launch", () => {
    const store = newStore();
    store.getState().handleKey({ input: "", downArrow: true });
    const focusedRowId = store.getState().focusedRowId;
    expect(focusedRowId).toBeDefined();

    const target = resolveKeyFocusedRowAgentTarget(store, "\r");
    expect(target).toMatchObject({ kind: "launch-managed", rowId: focusedRowId });
  });

  it("stays with the machine when nothing is focused or the key is not Enter", () => {
    const unfocused = newStore();
    expect(resolveKeyFocusedRowAgentTarget(unfocused, "\r").kind).toBe("none");

    const focused = newStore();
    focused.getState().handleKey({ input: "", downArrow: true });
    expect(resolveKeyFocusedRowAgentTarget(focused, "x").kind).toBe("none");
  });

  it("is inert while an operation is pending on the focused row", () => {
    const store = newStore();
    store.getState().handleKey({ input: "", downArrow: true });
    const focusedRowId = store.getState().focusedRowId;
    if (focusedRowId === undefined) {
      throw new Error("Expected a focused row.");
    }
    const worktreeId = store
      .getState()
      .snapshot?.sessions.find((session) => session.id === focusedRowId)?.worktreeId;
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
