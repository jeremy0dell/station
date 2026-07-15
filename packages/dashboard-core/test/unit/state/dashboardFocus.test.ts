import type { StationSnapshot } from "@station/contracts";
import type { TuiState } from "@station/dashboard-core";
import {
  clearDashboardFocus,
  createInitialTuiState,
  createTuiStore,
  focusDashboardSession,
  handleTuiKey,
  selectDashboardItems,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";
import { createCommandSnapshot, createDashboardSnapshot } from "../../fixtures/snapshots.js";
import { FakeTuiObserverService } from "../../support/fakeObserverService.js";

const DOWN = { input: "", downArrow: true } as const;
const UP = { input: "", upArrow: true } as const;
const NEXT_NEEDS_ME = { input: "i", ctrl: true } as const;
const RETURN = { input: "\r", return: true } as const;

// Canonical session order under project web: working, attention, exited,
// idle, unknown, stuck — then project api: api_working.
function state(options: Partial<Parameters<typeof createInitialTuiState>[0]> = {}): TuiState {
  return createInitialTuiState({ initialSnapshot: createDashboardSnapshot(), ...options });
}

describe("dashboard focus cursor", () => {
  it("focuses the canonical session row and minimally scrolls it into view", () => {
    const snapshot = createDashboardSnapshot();
    snapshot.rows = snapshot.rows.map((row) =>
      row.id === "wt_api_working" && row.agent !== undefined
        ? { ...row, agent: { ...row.agent, sessionId: "ses_stale_row_metadata" } }
        : row,
    );
    const initial = createInitialTuiState({
      initialSnapshot: snapshot,
      terminalRows: 12,
      scrollOffset: 0,
    });
    const focused = focusDashboardSession(initial, "ses_wt_api_working");

    expect(focused.focusedRowId).toBe("ses_wt_api_working");
    expect(focused.scrollOffset).toBe(5);
  });

  it.each([
    ["non-session worktree id", (snapshot: StationSnapshot) => snapshot, "wt_api_working"],
    [
      "stale session row",
      (snapshot: StationSnapshot) => ({
        ...snapshot,
        rows: snapshot.rows.filter((row) => row.id !== "wt_api_working"),
      }),
      "ses_wt_api_working",
    ],
  ])("clears focus for a %s without moving the viewport", (_label, updateSnapshot, sessionId) => {
    const initial = state({ focusedRowId: "ses_wt_web_attention", scrollOffset: 3 });
    const snapshot = updateSnapshot(initial.snapshot as StationSnapshot);
    const focused = focusDashboardSession({ ...initial, snapshot }, sessionId);

    expect("focusedRowId" in focused).toBe(false);
    expect(focused.scrollOffset).toBe(3);
  });

  it("clears focus when search filters out the session without changing search or scroll", () => {
    const initial = state({
      focusedRowId: "ses_wt_web_attention",
      searchQuery: "cache-refactor",
      scrollOffset: 2,
    });
    const focused = focusDashboardSession(initial, "ses_wt_api_working");

    expect("focusedRowId" in focused).toBe(false);
    expect(focused.searchQuery).toBe("cache-refactor");
    expect(focused.scrollOffset).toBe(2);
  });

  it("clears focus when the session project is collapsed without changing collapse or scroll", () => {
    const initial = state({
      focusedRowId: "ses_wt_web_attention",
      collapsedProjectIds: ["api"],
      scrollOffset: 2,
    });
    const focused = focusDashboardSession(initial, "ses_wt_api_working");

    expect("focusedRowId" in focused).toBe(false);
    expect(focused.collapsedProjectIds).toEqual(new Set(["api"]));
    expect(focused.scrollOffset).toBe(2);
  });

  it("removes transient focus without changing the viewport", () => {
    const initial = state({ focusedRowId: "ses_wt_web_attention", scrollOffset: 2 });
    const cleared = clearDashboardFocus(initial);

    expect("focusedRowId" in cleared).toBe(false);
    expect(cleared.scrollOffset).toBe(2);
  });

  it("preserves store actions while synchronizing and clearing focus", () => {
    const snapshot = createDashboardSnapshot();
    const store = createTuiStore({
      service: new FakeTuiObserverService(snapshot),
      initialSnapshot: snapshot,
      initialState: { terminalRows: 12 },
    });

    store.getState().focusDashboardSession("ses_wt_web_attention");
    store.getState().handleKey(DOWN);

    expect(store.getState().focusedRowId).toBe("ses_wt_web_exited");

    store.getState().clearDashboardFocus();

    expect("focusedRowId" in store.getState()).toBe(false);
    expect(typeof store.getState().handleKey).toBe("function");
  });

  it("enters on the first visible session row and walks rows, skipping headers", () => {
    const first = handleTuiKey(state({ terminalRows: 12 }), DOWN).state;
    expect(first.focusedRowId).toBe("ses_wt_web_working");
    expect(first.scrollOffset).toBe(0);

    const second = handleTuiKey(first, DOWN).state;
    expect(second.focusedRowId).toBe("ses_wt_web_attention");
  });

  it("enters upward on the last visible session row", () => {
    const entered = handleTuiKey(state({ terminalRows: 12 }), UP).state;
    // terminalRows 12 -> bodyRows 5: header + four session rows visible.
    expect(entered.focusedRowId).toBe("ses_wt_web_idle");
  });

  it("scrolls the viewport to keep the cursor visible when walking past the bottom", () => {
    let current = state({ terminalRows: 12 });
    for (let presses = 0; presses < 5; presses += 1) {
      current = handleTuiKey(current, DOWN).state;
    }
    expect(current.focusedRowId).toBe("ses_wt_web_unknown");
    // Item index 5 must sit inside the 5-row window: offset = 5 - 5 + 1.
    expect(current.scrollOffset).toBe(1);
  });

  it("clamps at both ends of the session list", () => {
    const top = handleTuiKey(handleTuiKey(state(), DOWN).state, UP).state;
    expect(handleTuiKey(top, UP).state.focusedRowId).toBe("ses_wt_web_working");

    let bottom = state({ terminalRows: 40 });
    for (let presses = 0; presses < 12; presses += 1) {
      bottom = handleTuiKey(bottom, DOWN).state;
    }
    expect(bottom.focusedRowId).toBe("ses_wt_api_working");
  });

  it("re-enters from the viewport when the focused row leaves the snapshot", () => {
    const stale = { ...state({ terminalRows: 12 }), focusedRowId: "wt_gone" };
    expect(handleTuiKey(stale, DOWN).state.focusedRowId).toBe("ses_wt_web_working");
  });

  it("jumps to the next needs-attention or stuck row and wraps", () => {
    const first = handleTuiKey(state({ terminalRows: 12 }), NEXT_NEEDS_ME).state;
    expect(first.focusedRowId).toBe("ses_wt_web_attention");

    const second = handleTuiKey(first, NEXT_NEEDS_ME).state;
    expect(second.focusedRowId).toBe("ses_wt_web_stuck");
    // The stuck row (item index 7) scrolled into the 5-row window.
    expect(second.scrollOffset).toBe(2);

    const wrapped = handleTuiKey(second, NEXT_NEEDS_ME).state;
    expect(wrapped.focusedRowId).toBe("ses_wt_web_attention");
  });

  it("activates the focused row with return", () => {
    const focused = handleTuiKey(state(), DOWN).state;
    const transition = handleTuiKey(focused, RETURN);
    expect(transition.commands).toEqual([
      {
        type: "terminal.focus",
        payload: { sessionId: "ses_wt_web_working" },
      },
    ]);
  });

  it("ignores return with no focused row", () => {
    const initial = state();
    const transition = handleTuiKey(initial, RETURN);
    expect(transition.state).toBe(initial);
    expect(transition.commands).toBeUndefined();
  });

  it("does not re-dispatch for a row whose start is already pending", () => {
    const snapshot = createCommandSnapshot("none");
    const initial = createInitialTuiState({ initialSnapshot: snapshot });
    const items = selectDashboardItems(snapshot, initial);
    expect(items.some((item) => item.type === "session")).toBe(true);

    const pending: TuiState = {
      ...initial,
      focusedRowId: "ses_wt_web_no_agent",
      localRows: {
        ...initial.localRows,
        pendingStart: [
          {
            localId: "start:wt_web_no_agent",
            projectId: "web",
            worktreeId: "wt_web_no_agent",
            branch: "feature-auth",
            operation: "startAgent",
            createdAt: "2026-05-31T12:00:00.000Z",
          },
        ],
      },
    };
    const transition = handleTuiKey(pending, RETURN);
    expect(transition.commands).toBeUndefined();
    expect(transition.operations).toBeUndefined();
  });
});
