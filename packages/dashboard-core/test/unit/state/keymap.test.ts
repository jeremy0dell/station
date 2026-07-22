import {
  createInitialTuiState,
  dashboardFooterLabel,
  handleTuiKey,
  isSlotKey,
  TUI_HELP_CONTENT,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";
import { matchDashboardBinding } from "../../../src/state/keymap.js";
import { createDashboardSnapshot } from "../../fixtures/snapshots.js";

const KEY_CONTEXT = { cwd: "/Users/example/Developer/station", homeDir: "/Users/example" };

describe("dashboard key bindings", () => {
  it("matches dashboard navigation and actions", () => {
    expect(matchDashboardBinding({ input: "", upArrow: true })?.action).toBe("tui.focus.up");
    expect(matchDashboardBinding({ input: "", downArrow: true })?.action).toBe("tui.focus.down");
    expect(matchDashboardBinding({ input: "\r", return: true })?.action).toBe("tui.focus.activate");
    expect(matchDashboardBinding({ input: "N" })?.action).toBe("tui.newSession.open");
    expect(matchDashboardBinding({ input: "?" })?.action).toBe("tui.help.open");
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

  it("keeps dashboard help content independent of screen key metadata", () => {
    expect(TUI_HELP_CONTENT).toEqual(
      expect.arrayContaining([
        { key: "↑/↓", description: "move cursor" },
        { key: "N", description: "new session" },
        { key: "Q", description: "quit or close popup" },
      ]),
    );
  });
});

describe("dashboard popup lifecycle keys", () => {
  it("dismisses a persistent popup with Q or Esc without exiting", () => {
    const state = createInitialTuiState({
      initialSnapshot: createDashboardSnapshot(),
      runtime: { persistentPopup: true, canDismissPopup: true },
    });

    for (const key of [{ input: "Q" }, { input: "", escape: true }]) {
      const transition = handleTuiKey(state, key, KEY_CONTEXT);
      expect(transition.dismissPopup).toBe(true);
      expect(transition.exitCode).toBeUndefined();
      expect(transition.state).toBe(state);
    }
  });

  it("keeps fullscreen and transient popup Q/Esc behavior unchanged", () => {
    const states = [
      createInitialTuiState({ initialSnapshot: createDashboardSnapshot() }),
      createInitialTuiState({
        initialSnapshot: createDashboardSnapshot(),
        runtime: {
          exitOnFocusSuccess: true,
          focusOrigin: { provider: "tmux", clientId: "client-startup" },
        },
      }),
    ];

    for (const state of states) {
      const quit = handleTuiKey(state, { input: "Q" }, KEY_CONTEXT);
      expect(quit.exitCode).toBe(0);
      expect(quit.dismissPopup).toBeUndefined();

      const escapeKey = handleTuiKey(state, { input: "", escape: true }, KEY_CONTEXT);
      expect(escapeKey.exitCode).toBeUndefined();
      expect(escapeKey.dismissPopup).toBeUndefined();
      expect(escapeKey.state).toBe(state);
    }
  });
});

describe("dashboard footer", () => {
  it("keeps the first-project action at wide and compact widths", () => {
    for (const columns of [120, 40]) {
      const label = dashboardFooterLabel({
        columns,
        quitHint: "Q/esc:close",
        firstRun: true,
      });
      expect(label).toContain("add first project");
      expect(label).not.toContain("open");
      expect(label).not.toContain("N new");
      expect(label).not.toContain("delete");
    }
  });
});
