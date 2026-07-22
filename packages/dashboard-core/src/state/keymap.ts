import { SELECTION_KEYS, type SelectionKey } from "../selectors/selectors.js";
import type { TuiKey } from "./keys.js";
import type { TuiState } from "./types.js";

export type TuiInputMode =
  | "dashboard"
  | "help"
  | "search"
  | "projectCollapse"
  | "projectSettingsPicker"
  | "removeChooseSlot"
  | "removeConfirm"
  | "removeUnavailable"
  | "renameChooseSlot"
  | "renameEdit"
  | "forkChooseSlot"
  | "forkDetails"
  | "newSessionReview"
  | "newSessionEditName"
  | "newSessionPickProject"
  | "newSessionPickAgent"
  | "projectDefaultAgent"
  | "projectSettings"
  | "addProject"
  | "widgetSettings";

export function deriveTuiInputMode(state: TuiState): TuiInputMode {
  const screen = state.screen;
  switch (screen.name) {
    case "dashboard":
      return "dashboard";
    case "help":
      return "help";
    case "search":
      return "search";
    case "projectCollapse":
      return "projectCollapse";
    case "projectSettingsPicker":
      return "projectSettingsPicker";
    case "removeWorktree":
      if (screen.step === "chooseSlot") return "removeChooseSlot";
      return screen.step === "unavailable" ? "removeUnavailable" : "removeConfirm";
    case "renameSession":
      return screen.step === "chooseSlot" ? "renameChooseSlot" : "renameEdit";
    case "fork":
      return screen.step === "chooseSlot" ? "forkChooseSlot" : "forkDetails";
    case "newSession":
      if (screen.flow.mode === "review") return "newSessionReview";
      if (screen.flow.mode === "editName") return "newSessionEditName";
      if (screen.flow.mode === "pickProject") return "newSessionPickProject";
      return "newSessionPickAgent";
    case "addProject":
      return "addProject";
    case "projectDefaultAgent":
      return "projectDefaultAgent";
    case "projectSettings":
      return "projectSettings";
    case "widgetSettings":
      return "widgetSettings";
  }
}

type DashboardKeyPattern =
  | { kind: "char"; char: string; ctrl?: true }
  | { kind: "named"; named: "return" | "escape" | "up" | "down" }
  | { kind: "slot" };

type DashboardBindingSpec = {
  id: string;
  pattern: DashboardKeyPattern;
  action: string;
  outcome: "handled" | "exit" | "dismiss-popup";
  help?: { keys: string; label: string };
};

const slotHelp = { keys: "1-9 a-z", label: "open visible session" };

// Dashboard keyboard dispatch resolves through this table; every other screen
// owns its key behavior directly in the transition machine.
export const TUI_DASHBOARD_BINDINGS = [
  {
    id: "tui.dashboard.focusUp",
    pattern: { kind: "named", named: "up" },
    action: "tui.focus.up",
    outcome: "handled",
  },
  {
    id: "tui.dashboard.focusDown",
    pattern: { kind: "named", named: "down" },
    action: "tui.focus.down",
    outcome: "handled",
  },
  {
    id: "tui.dashboard.focusActivate",
    pattern: { kind: "named", named: "return" },
    action: "tui.focus.activate",
    outcome: "handled",
    help: { keys: "↵", label: "open focused session" },
  },
  {
    // Tab reaches the dashboard as legacy \t, which the byte path folds to
    // Ctrl-I; the two are indistinguishable by design.
    id: "tui.dashboard.nextNeedsMe",
    pattern: { kind: "char", char: "i", ctrl: true },
    action: "tui.focus.nextNeedsMe",
    outcome: "handled",
    help: { keys: "⇥", label: "next session needing you" },
  },
  {
    id: "tui.dashboard.help",
    pattern: { kind: "char", char: "H" },
    action: "tui.help.open",
    outcome: "handled",
    help: { keys: "H", label: "help" },
  },
  {
    id: "tui.dashboard.helpAlias",
    pattern: { kind: "char", char: "?" },
    action: "tui.help.open",
    outcome: "handled",
  },
  {
    id: "tui.dashboard.quit",
    pattern: { kind: "char", char: "Q" },
    action: "tui.exit",
    outcome: "exit",
    help: { keys: "Q", label: "quit" },
  },
  {
    id: "tui.dashboard.dismissEsc",
    pattern: { kind: "named", named: "escape" },
    action: "tui.popup.dismiss",
    outcome: "dismiss-popup",
  },
  {
    id: "tui.dashboard.search",
    pattern: { kind: "char", char: "/" },
    action: "tui.search.open",
    outcome: "handled",
    help: { keys: "/", label: "search" },
  },
  {
    id: "tui.dashboard.rename",
    pattern: { kind: "char", char: "R" },
    action: "tui.rename.open",
    outcome: "handled",
    help: { keys: "R", label: "rename" },
  },
  {
    id: "tui.dashboard.fork",
    pattern: { kind: "char", char: "F" },
    action: "tui.fork.open",
    outcome: "handled",
    help: { keys: "F", label: "fork" },
  },
  {
    id: "tui.dashboard.refresh",
    pattern: { kind: "char", char: "Z" },
    action: "tui.refresh",
    outcome: "handled",
    help: { keys: "Z", label: "refresh" },
  },
  {
    id: "tui.dashboard.remove",
    pattern: { kind: "char", char: "X" },
    action: "tui.remove.open",
    outcome: "handled",
    help: { keys: "X", label: "delete session" },
  },
  {
    id: "tui.dashboard.newSession",
    pattern: { kind: "char", char: "N" },
    action: "tui.newSession.open",
    outcome: "handled",
    help: { keys: "N", label: "new" },
  },
  {
    id: "tui.dashboard.addProject",
    pattern: { kind: "char", char: "A" },
    action: "tui.addProject.open",
    outcome: "handled",
    help: { keys: "A", label: "add" },
  },
  {
    id: "tui.dashboard.widgetSettings",
    pattern: { kind: "char", char: "W" },
    action: "tui.widgetSettings.open",
    outcome: "handled",
    help: { keys: "W", label: "widgets" },
  },
  {
    id: "tui.dashboard.collapse",
    pattern: { kind: "char", char: "C" },
    action: "tui.collapse.open",
    outcome: "handled",
    help: { keys: "C", label: "fold" },
  },
  {
    id: "tui.dashboard.projectSettings",
    pattern: { kind: "char", char: "P" },
    action: "tui.projectSettings.openPicker",
    outcome: "handled",
    help: { keys: "P", label: "settings" },
  },
  {
    id: "tui.dashboard.slotActivate",
    pattern: { kind: "slot" },
    action: "tui.row.activateSlot",
    outcome: "handled",
    help: slotHelp,
  },
] as const satisfies readonly DashboardBindingSpec[];

const TUI_GLOBAL_BINDINGS = [
  {
    id: "tui.global.exitIntent",
    pattern: { kind: "char", char: "c", ctrl: true },
    action: "tui.exit",
    outcome: "exit",
  },
] as const satisfies readonly DashboardBindingSpec[];

export type TuiDashboardBinding =
  | (typeof TUI_GLOBAL_BINDINGS)[number]
  | (typeof TUI_DASHBOARD_BINDINGS)[number];

export type TuiHelpContentLine =
  | { text: string; align?: "center" }
  | { key: string; description: string };

export const TUI_HELP_CONTENT = [
  { text: "station help", align: "center" as const },
  { text: "" },
  { key: "↑/↓", description: "move cursor" },
  { key: "↵", description: "open focused session" },
  { key: "tab", description: "next session needing you" },
  { key: "wheel", description: "scroll dashboard" },
  { key: "1-9/a-z", description: "choose visible item" },
  { key: "N", description: "new session" },
  { key: "R", description: "rename session" },
  { key: "X", description: "delete session" },
  { key: "C", description: "collapse project" },
  { key: "P", description: "project settings" },
  { key: "/", description: "search" },
  { key: "Z", description: "refresh snapshot" },
  { key: "H / ?", description: "help" },
  { key: "Q", description: "quit or close popup" },
  { key: "Esc", description: "back/cancel" },
] as const satisfies readonly TuiHelpContentLine[];

export const QUIT_HINT_CLOSE = "Q/esc:close";

export function dashboardFooterLabel({
  columns,
  quitHint,
  firstRun = false,
}: {
  columns: number;
  quitHint: string;
  firstRun?: boolean;
}): string {
  const full = firstRun
    ? `↵ add first project  A add project  ${quitHint}`
    : `↵ open  N new  A add  ⇥ next-needs-me  / search  X delete  ? help  ${quitHint}`;
  const compactFirstRun = `↵ add first project  ${quitHint}`;
  const compactClose = `↵ open  N new  ⇥ next  / search  X delete  ? help  ${QUIT_HINT_CLOSE}`;
  if (firstRun && full.length > columns) {
    return compactFirstRun;
  }
  return quitHint === QUIT_HINT_CLOSE && full.length > columns ? compactClose : full;
}

export function isSlotKey(key: TuiKey): boolean {
  // Ctrl-A remains a slot after the global Ctrl-C binding runs. Ctrl-I is the
  // exception because legacy terminal input makes it indistinguishable from Tab.
  if (key.ctrl === true && key.input === "i") {
    return false;
  }
  return (
    key.return !== true && key.escape !== true && SELECTION_KEYS.includes(key.input as SelectionKey)
  );
}

function matchesPattern(pattern: DashboardKeyPattern, key: TuiKey): boolean {
  switch (pattern.kind) {
    case "char":
      return (
        key.input === pattern.char &&
        (pattern.ctrl === true) === (key.ctrl === true) &&
        key.return !== true &&
        key.escape !== true
      );
    case "named":
      if (pattern.named === "return") {
        return key.return === true || key.input === "\r" || key.input === "\n";
      }
      if (pattern.named === "escape") {
        return key.escape === true;
      }
      if (pattern.named === "up") {
        return key.upArrow === true;
      }
      return key.downArrow === true;
    case "slot":
      return isSlotKey(key);
  }
}

export function matchDashboardBinding(key: TuiKey): TuiDashboardBinding | undefined {
  return (
    TUI_GLOBAL_BINDINGS.find((binding) => matchesPattern(binding.pattern, key)) ??
    TUI_DASHBOARD_BINDINGS.find((binding) => matchesPattern(binding.pattern, key))
  );
}
