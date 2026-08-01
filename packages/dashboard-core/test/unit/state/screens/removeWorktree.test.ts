import {
  createInitialTuiState,
  handleTuiAction,
  handleTuiKey,
  openRemoveWorktreeConfirmForRow,
  type TuiKey,
  type TuiState,
  type TuiTransition,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";
import { createDashboardSnapshot } from "../../../fixtures/snapshots.js";

const CTX = { cwd: "/Users/example/Developer/station", homeDir: "/Users/example" };
const ENTER: TuiKey = { input: "\r", return: true };
const LEFT: TuiKey = { input: "", leftArrow: true };
const RIGHT: TuiKey = { input: "", rightArrow: true };
const ESC: TuiKey = { input: "", escape: true };

function openConfirm(): TuiState {
  return openRemoveWorktreeConfirmForRow(
    createInitialTuiState({ initialSnapshot: createDashboardSnapshot() }),
    "ses_wt_web_idle",
  );
}

function step(state: TuiState, key: TuiKey): TuiTransition {
  return handleTuiKey(state, key, CTX);
}

function confirmScreen(state: TuiState) {
  if (state.screen.name !== "removeWorktree" || state.screen.step !== "confirm") {
    throw new Error(`expected remove confirmation, got ${state.screen.name}`);
  }
  return state.screen;
}

describe("remove worktree confirmation", () => {
  it("starts on the safe Keep session action and Enter cancels", () => {
    const opened = openConfirm();

    expect(confirmScreen(opened).actionFocus).toBe("keep");
    expect(step(opened, ENTER).state.screen).toEqual({ name: "dashboard" });
    expect(step(opened, ENTER).operations).toBeUndefined();
  });

  it("moves horizontally without wrapping", () => {
    const opened = openConfirm();
    const deleteFocused = step(opened, LEFT).state;

    expect(confirmScreen(deleteFocused).actionFocus).toBe("delete");
    expect(confirmScreen(step(deleteFocused, LEFT).state).actionFocus).toBe("delete");
    expect(confirmScreen(step(deleteFocused, RIGHT).state).actionFocus).toBe("keep");
    expect(confirmScreen(step(opened, RIGHT).state).actionFocus).toBe("keep");
  });

  it("converges focused Enter, direct Y, and semantic Delete", () => {
    const opened = openConfirm();
    const focused = step(step(opened, LEFT).state, ENTER);
    const direct = step(opened, { input: "y" });
    const semantic = handleTuiAction(
      opened,
      { type: "removeWorktree.activate", actionId: "confirm.delete" },
      CTX,
    );

    for (const transition of [focused, direct, semantic]) {
      expect(transition.state.screen).toEqual({ name: "dashboard" });
      expect(transition.operations?.[0]).toMatchObject({
        type: "removeWorktree",
        projectId: "web",
        worktreeId: "wt_web_idle",
      });
    }
    expect(focused.operations?.[0]).toEqual(direct.operations?.[0]);
    expect(semantic.operations?.[0]).toEqual(direct.operations?.[0]);
  });

  it("converges direct, focused, semantic, and Escape cancellation", () => {
    const opened = openConfirm();
    const transitions = [
      step(opened, ENTER),
      step(opened, { input: "n" }),
      step(opened, ESC),
      handleTuiAction(opened, { type: "removeWorktree.activate", actionId: "confirm.keep" }, CTX),
    ];

    for (const transition of transitions) {
      expect(transition.state.screen).toEqual({ name: "dashboard" });
      expect(transition.operations).toBeUndefined();
    }
  });

  it("keeps stale semantic actions inert", () => {
    const dashboard = createInitialTuiState({ initialSnapshot: createDashboardSnapshot() });

    expect(
      handleTuiAction(
        dashboard,
        { type: "removeWorktree.activate", actionId: "confirm.delete" },
        CTX,
      ),
    ).toEqual({ state: dashboard });
  });
});
