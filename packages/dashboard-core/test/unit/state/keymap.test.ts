import { describe, expect, it } from "vitest";
import { SELECTION_KEYS } from "../../../src/selectors/keyedChoices.js";
import {
  type DashboardFooterWidth,
  dashboardBindingHelp,
  dashboardFooterShortcuts,
  deriveTuiInputMode,
  isSlotKey,
  matchDashboardBinding,
} from "../../../src/state/keymap.js";
import { createInitialTuiState } from "../../../src/state/screen.js";
import { openGroupSettings } from "../../../src/state/screens/groupSettings.js";
import { handleTuiKey } from "../../../src/state/transition.js";
import {
  createDashboardSnapshot,
  createGroupedDashboardSnapshot,
} from "../../fixtures/snapshots.js";

const KEY_CONTEXT = { cwd: "/Users/example/Developer/station", homeDir: "/Users/example" };

describe("dashboard key bindings", () => {
  it("matches dashboard navigation and actions", () => {
    expect(matchDashboardBinding({ input: "", upArrow: true })?.action).toBe("tui.focus.up");
    expect(matchDashboardBinding({ input: "", downArrow: true })?.action).toBe("tui.focus.down");
    expect(matchDashboardBinding({ input: "", leftArrow: true })?.action).toBe("tui.focus.left");
    expect(matchDashboardBinding({ input: "", rightArrow: true })?.action).toBe("tui.focus.right");
    expect(matchDashboardBinding({ input: "\r", return: true })?.action).toBe("tui.focus.activate");
    expect(matchDashboardBinding({ input: "N" })?.action).toBe("tui.newSession.open");
    expect(matchDashboardBinding({ input: "G" })?.action).toBe("tui.quickGroup.create");
    expect(matchDashboardBinding({ input: "M" })?.action).toBe("tui.moveToGroup.open");
    expect(matchDashboardBinding({ input: "?" })?.action).toBe("tui.help.open");
  });

  it.each([
    ["R", { name: "renameSession", step: "chooseSlot" }],
    ["M", { name: "moveToGroup", step: "chooseSlot" }],
    ["F", { name: "fork", step: "chooseSlot" }],
    ["X", { name: "removeWorktree", step: "chooseSlot" }],
  ] as const)("opens the visible session chooser flow for %s", (input, expectedScreen) => {
    const state = createInitialTuiState({ initialSnapshot: createDashboardSnapshot() });

    expect(handleTuiKey(state, { input }, KEY_CONTEXT).state.screen).toEqual(expectedScreen);
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

  it("derives the dedicated Group menu input mode", () => {
    const base = createInitialTuiState({ initialSnapshot: createGroupedDashboardSnapshot() });
    expect(
      deriveTuiInputMode({
        ...base,
        screen: {
          name: "groupMenu",
          projectId: "web",
          groupId: "group_active",
          focus: "quickSession",
        },
      }),
    ).toBe("groupMenu");
  });

  it("derives the dedicated Group Settings input mode", () => {
    const state = openGroupSettings(
      createInitialTuiState({ initialSnapshot: createGroupedDashboardSnapshot() }),
      "group_active",
    );
    expect(deriveTuiInputMode(state)).toBe("groupSettings");
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

  it("keeps lowercase g in the landed session-slot grammar", () => {
    expect(SELECTION_KEYS).toContain("g");
    expect(isSlotKey({ input: "g" })).toBe(true);
    expect(matchDashboardBinding({ input: "g" })?.action).toBe("tui.row.activateSlot");
  });

  it("keeps lowercase m as a session slot", () => {
    expect(isSlotKey({ input: "m" })).toBe(true);
    expect(matchDashboardBinding({ input: "m" })?.action).toBe("tui.row.activateSlot");
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
  const footerText = (width: DashboardFooterWidth) =>
    dashboardFooterShortcuts(width)
      .map(({ keys, label }) => `${keys} ${label}`)
      .join("  ");

  it("derives full and compact shortcut membership from binding metadata", () => {
    expect(footerText("full")).toBe(
      "↵ activate  N new  M move to group  A add  ⇥ next-needs-me  / filter  X delete  ? help",
    );
    expect(footerText("compact")).toBe(
      "↵ activate  N new  ⇥ next-needs-me  / filter  X delete  ? help",
    );
  });

  it("exposes stable and Help-panel keyboard language from the same binding", () => {
    expect(dashboardBindingHelp("tui.dashboard.filter")).toMatchObject({
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
    expect(dashboardBindingHelp("tui.dashboard.quickGroup")).toEqual({
      keys: "G",
      label: "quick group",
    });
    expect(dashboardBindingHelp("tui.dashboard.moveToGroup")).toEqual({
      keys: "M",
      label: "move to group",
      footerOrder: 25,
    });
    expect(dashboardBindingHelp("tui.dashboard.nextNeedsMe")).toMatchObject({
      keys: "⇥",
      label: "next-needs-me",
      panelKeys: "tab",
      panelLabel: "next session needing you",
    });
    expect(dashboardBindingHelp("tui.dashboard.slotActivate")).toMatchObject({
      keys: "1-9 a-z",
      label: "open visible session",
      panelKeys: "1-9/a-z",
      panelLabel: "open visible session or toggle condition",
    });
  });
});
