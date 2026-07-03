import type { TuiState } from "@station/dashboard-core";
import { createInitialTuiState, handleTuiKey, selectDashboardItems } from "@station/dashboard-core";
import { describe, expect, it } from "vitest";
import { createDashboardSnapshot } from "../../fixtures/snapshots.js";

const DOWN = { input: "", downArrow: true } as const;
const UP = { input: "", upArrow: true } as const;
const NEXT_NEEDS_ME = { input: "i", ctrl: true } as const;
const RETURN = { input: "\r", return: true } as const;

// Fixture worktree order under project web: working, attention, exited,
// no_agent, idle, unknown, stuck — then project api: api_working.
function state(options: Partial<Parameters<typeof createInitialTuiState>[0]> = {}): TuiState {
  return createInitialTuiState({ initialSnapshot: createDashboardSnapshot(), ...options });
}

describe("dashboard focus cursor", () => {
  it("enters on the first visible session row and walks rows, skipping headers", () => {
    const first = handleTuiKey(state({ terminalRows: 12 }), DOWN).state;
    expect(first.focusedRowId).toBe("wt_web_working");
    expect(first.scrollOffset).toBe(0);

    const second = handleTuiKey(first, DOWN).state;
    expect(second.focusedRowId).toBe("wt_web_attention");
  });

  it("enters upward on the last visible session row", () => {
    const entered = handleTuiKey(state({ terminalRows: 12 }), UP).state;
    // terminalRows 12 -> bodyRows 5: header + working/attention/exited/no-agent visible.
    expect(entered.focusedRowId).toBe("wt_web_no_agent");
  });

  it("scrolls the viewport to keep the cursor visible when walking past the bottom", () => {
    let current = state({ terminalRows: 12 });
    for (let presses = 0; presses < 5; presses += 1) {
      current = handleTuiKey(current, DOWN).state;
    }
    expect(current.focusedRowId).toBe("wt_web_idle");
    // Item index 5 must sit inside the 5-row window: offset = 5 - 5 + 1.
    expect(current.scrollOffset).toBe(1);
  });

  it("clamps at both ends of the session list", () => {
    const top = handleTuiKey(handleTuiKey(state(), DOWN).state, UP).state;
    expect(handleTuiKey(top, UP).state.focusedRowId).toBe("wt_web_working");

    let bottom = state({ terminalRows: 40 });
    for (let presses = 0; presses < 12; presses += 1) {
      bottom = handleTuiKey(bottom, DOWN).state;
    }
    expect(bottom.focusedRowId).toBe("wt_api_working");
  });

  it("re-enters from the viewport when the focused row leaves the snapshot", () => {
    const stale = { ...state({ terminalRows: 12 }), focusedRowId: "wt_gone" };
    expect(handleTuiKey(stale, DOWN).state.focusedRowId).toBe("wt_web_working");
  });

  it("jumps to the next needs-attention or stuck row and wraps", () => {
    const first = handleTuiKey(state({ terminalRows: 12 }), NEXT_NEEDS_ME).state;
    expect(first.focusedRowId).toBe("wt_web_attention");

    const second = handleTuiKey(first, NEXT_NEEDS_ME).state;
    expect(second.focusedRowId).toBe("wt_web_stuck");
    // The stuck row (item index 7) scrolled into the 5-row window.
    expect(second.scrollOffset).toBe(3);

    const wrapped = handleTuiKey(second, NEXT_NEEDS_ME).state;
    expect(wrapped.focusedRowId).toBe("wt_web_attention");
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
    const initial = state();
    const items = selectDashboardItems(createDashboardSnapshot(), initial);
    expect(items.some((item) => item.type === "worktree")).toBe(true);

    const pending: TuiState = {
      ...initial,
      focusedRowId: "wt_web_no_agent",
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
