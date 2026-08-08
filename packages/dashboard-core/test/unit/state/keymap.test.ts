import { describe, expect, it } from "vitest";
import {
  dashboardBindingHelp,
  deriveTuiInputMode,
  isSlotKey,
  matchDashboardBinding,
} from "../../../src/state/keymap.js";
import { createInitialTuiState } from "../../../src/state/screen.js";
import { handleTuiKey } from "../../../src/state/transition.js";
import { createDashboardSnapshot } from "../../fixtures/snapshots.js";

const KEY_CONTEXT = { cwd: "/Users/example/Developer/station", homeDir: "/Users/example" };

describe("dashboard key bindings", () => {
  it("matches dashboard navigation and actions", () => {
    expect(matchDashboardBinding({ input: "", upArrow: true })?.action).toBe("tui.focus.up");
    expect(matchDashboardBinding({ input: "", downArrow: true })?.action).toBe("tui.focus.down");
    expect(matchDashboardBinding({ input: "", leftArrow: true })?.action).toBe("tui.focus.left");
    expect(matchDashboardBinding({ input: "", rightArrow: true })?.action).toBe("tui.focus.right");
    expect(matchDashboardBinding({ input: "\r", return: true })?.action).toBe("tui.focus.activate");
    expect(matchDashboardBinding({ input: "N" })?.action).toBe("tui.newSession.open");
    expect(matchDashboardBinding({ input: "?" })?.action).toBe("tui.help.open");
  });

  it("derives the dedicated persistent-filter input mode", () => {
    const base = createInitialTuiState({ initialSnapshot: createDashboardSnapshot() });
    expect(
      deriveTuiInputMode({
        ...base,
        screen: {
          name: "persistentFilter",
          draft: { value: "", cursor: 0 },
          draftConditions: [],
        },
      }),
    ).toBe("persistentFilter");
  });

  it("gives the global Ctrl-C exit precedence over slot matching", () => {
    expect(isSlotKey({ input: "c", ctrl: true })).toBe(true);
    expect(matchDashboardBinding({ input: "c", ctrl: true })).toMatchObject({
      id: "tui.global.exitIntent",
      action: "tui.exit",
      outcome: "exit",
    });
  });

  it("keeps Ctrl-I for next-needs-me while plain i remains a slot", () => {
    expect(isSlotKey({ input: "i", ctrl: true })).toBe(false);
    expect(matchDashboardBinding({ input: "i", ctrl: true })?.action).toBe("tui.focus.nextNeedsMe");
    expect(isSlotKey({ input: "i" })).toBe(true);
    expect(matchDashboardBinding({ input: "i" })?.action).toBe("tui.row.activateSlot");
  });
});

describe("dashboard lifecycle keys", () => {
  it("emits renderer exit for Q and dashboard dismissal for Esc", () => {
    const state = createInitialTuiState({ initialSnapshot: createDashboardSnapshot() });

    expect(handleTuiKey(state, { input: "Q" }, KEY_CONTEXT).operations).toEqual([
      { type: "exitDashboardRenderer", exitCode: 0 },
    ]);
    expect(handleTuiKey(state, { input: "", escape: true }, KEY_CONTEXT).operations).toEqual([
      { type: "dismissDashboard" },
    ]);
  });
});

describe("dashboard footer binding metadata", () => {
  it("exposes stable keys and labels without contextual layout policy", () => {
    expect(dashboardBindingHelp("tui.dashboard.filter")).toEqual({
      keys: "/",
      label: "filter",
    });
    expect(dashboardBindingHelp("tui.dashboard.dismissEsc")).toEqual({
      keys: "Esc",
      label: "clear persistent filter",
    });
    expect(dashboardBindingHelp("tui.dashboard.quit")).toEqual({
      keys: "Q",
      label: "quit",
    });
  });
});
