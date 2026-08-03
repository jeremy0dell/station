import {
  createInitialTuiState,
  dashboardFooterLabel,
  deriveTuiInputMode,
  handleTuiKey,
  isSlotKey,
  QUIT_HINT_DISMISS_ERROR,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";
import { matchDashboardBinding, TUI_DASHBOARD_BINDINGS } from "../../../src/state/keymap.js";
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
        screen: { name: "persistentFilter", draft: { value: "", cursor: 0 } },
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

type DashboardFooterVariant =
  | "full"
  | "compact"
  | "firstRunFull"
  | "firstRunCompact"
  | "filteredFull"
  | "filteredCompact";

type DashboardFooterMetadata = {
  order: number;
  labels: Partial<Record<DashboardFooterVariant, string>>;
};

function footerBindingMetadata(
  binding: (typeof TUI_DASHBOARD_BINDINGS)[number],
): { keys: string; footer: DashboardFooterMetadata } | undefined {
  if (!("help" in binding) || !("footer" in binding.help)) {
    return undefined;
  }
  return { keys: binding.help.keys, footer: binding.help.footer };
}

function shortcutsFromBindingMetadata(variant: DashboardFooterVariant): string {
  return TUI_DASHBOARD_BINDINGS.flatMap((binding) => {
    const metadata = footerBindingMetadata(binding);
    const label = metadata?.footer.labels[variant];
    return metadata === undefined || label === undefined
      ? []
      : [{ order: metadata.footer.order, text: `${metadata.keys} ${label}` }];
  })
    .sort((left, right) => left.order - right.order)
    .map(({ text }) => text)
    .join("  ");
}

describe("dashboard footer", () => {
  it("derives every responsive shortcut variant from binding metadata", () => {
    expect(shortcutsFromBindingMetadata("full")).toBe(
      "↵ activate  N new  A add  ⇥ next-needs-me  / search  X delete  ? help",
    );
    expect(shortcutsFromBindingMetadata("compact")).toBe(
      "↵ activate  N new  ⇥ next  / search  X delete  ? help",
    );
    expect(shortcutsFromBindingMetadata("firstRunFull")).toBe("↵ add first project  A add project");
    expect(shortcutsFromBindingMetadata("firstRunCompact")).toBe("↵ add first project");
  });

  it("selects full and compact registry projections without changing footer copy", () => {
    expect(dashboardFooterLabel({ columns: 120, quitHint: "Q/esc:close" })).toBe(
      `${shortcutsFromBindingMetadata("full")}  Q/esc:close`,
    );
    expect(dashboardFooterLabel({ columns: 80, quitHint: "Q/esc:close" })).toBe(
      `${shortcutsFromBindingMetadata("compact")}  Q/esc:close`,
    );
    expect(dashboardFooterLabel({ columns: 120, quitHint: "Q/esc:close", firstRun: true })).toBe(
      `${shortcutsFromBindingMetadata("firstRunFull")}  Q/esc:close`,
    );
    expect(dashboardFooterLabel({ columns: 40, quitHint: "Q/esc:close", firstRun: true })).toBe(
      `${shortcutsFromBindingMetadata("firstRunCompact")}  Q/esc:close`,
    );
  });

  it("derives applied-filter edit and clear affordances from dashboard binding metadata", () => {
    expect(
      dashboardFooterLabel({
        columns: 140,
        quitHint: "Q:close",
        persistentFilter: true,
      }),
    ).toBe(
      "↵ activate  N new  A add  ⇥ next-needs-me  / edit  Esc clear  X delete  ? help  Q:close",
    );
    expect(
      dashboardFooterLabel({
        columns: 80,
        quitHint: "Q:close",
        persistentFilter: true,
      }),
    ).toBe("↵ activate  N new  ⇥ next  / edit  Esc clear  X delete  ? help  Q:close");
  });

  it("keeps visible-error dismissal readable through compact and quit-only fallbacks", () => {
    expect(dashboardFooterLabel({ columns: 120, quitHint: QUIT_HINT_DISMISS_ERROR })).toBe(
      `${shortcutsFromBindingMetadata("full")}  ${QUIT_HINT_DISMISS_ERROR}`,
    );
    expect(dashboardFooterLabel({ columns: 80, quitHint: QUIT_HINT_DISMISS_ERROR })).toBe(
      `${shortcutsFromBindingMetadata("compact")}  ${QUIT_HINT_DISMISS_ERROR}`,
    );
    expect(dashboardFooterLabel({ columns: 40, quitHint: QUIT_HINT_DISMISS_ERROR })).toBe(
      QUIT_HINT_DISMISS_ERROR,
    );
    expect(
      dashboardFooterLabel({
        columns: 50,
        quitHint: QUIT_HINT_DISMISS_ERROR,
        firstRun: true,
      }),
    ).toBe(`${shortcutsFromBindingMetadata("firstRunCompact")}  ${QUIT_HINT_DISMISS_ERROR}`);
    expect(
      dashboardFooterLabel({
        columns: 40,
        quitHint: QUIT_HINT_DISMISS_ERROR,
        firstRun: true,
      }),
    ).toBe(QUIT_HINT_DISMISS_ERROR);
  });
});
