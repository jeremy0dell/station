import { SELECTION_KEYS, type SelectionKey } from "../selectors/selectors.js";
import type { TuiKey } from "./keys.js";
import type { DashboardStateView } from "./types.js";

export type TuiInputMode =
  | "dashboard"
  | "help"
  | "projectMenu"
  | "createGroup"
  | "persistentFilter"
  | "persistentFilterConditionField"
  | "persistentFilterConditionValues"
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
  | "addProjectStart"
  | "addProjectChoose"
  | "addProjectFilter"
  | "addProjectReview"
  | "addProjectEditId"
  | "addProjectSuccess"
  | "addProjectFailed"
  | "widgetSettings";

export function deriveTuiInputMode(state: DashboardStateView): TuiInputMode {
  const screen = state.screen;
  switch (screen.name) {
    case "dashboard":
      return "dashboard";
    case "help":
      return "help";
    case "projectMenu":
      return "projectMenu";
    case "createGroup":
      return "createGroup";
    case "persistentFilter":
      if (screen.conditionEditor?.stage === "field") return "persistentFilterConditionField";
      if (screen.conditionEditor?.stage === "values") return "persistentFilterConditionValues";
      return "persistentFilter";
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
      if (screen.flow.mode === "start") return "addProjectStart";
      if (screen.flow.mode === "choose") {
        return screen.flow.filterMode ? "addProjectFilter" : "addProjectChoose";
      }
      if (screen.flow.mode === "review") {
        return screen.flow.editingId === undefined ? "addProjectReview" : "addProjectEditId";
      }
      return screen.flow.mode === "success" ? "addProjectSuccess" : "addProjectFailed";
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
  | { kind: "named"; named: "return" | "escape" | "up" | "down" | "left" | "right" }
  | { kind: "slot" };

type DashboardNamedKey = Extract<DashboardKeyPattern, { kind: "named" }>["named"];

type DashboardBindingSpec = {
  id: string;
  pattern: DashboardKeyPattern;
  action: string;
  outcome: "handled" | "exit" | "dismiss-popup";
  help?: {
    keys: string;
    label: string;
  };
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
    id: "tui.dashboard.focusLeft",
    pattern: { kind: "named", named: "left" },
    action: "tui.focus.left",
    outcome: "handled",
  },
  {
    id: "tui.dashboard.focusRight",
    pattern: { kind: "named", named: "right" },
    action: "tui.focus.right",
    outcome: "handled",
  },
  {
    id: "tui.dashboard.focusActivate",
    pattern: { kind: "named", named: "return" },
    action: "tui.focus.activate",
    outcome: "handled",
    help: {
      keys: "↵",
      label: "activate focus",
    },
  },
  {
    // Tab reaches the dashboard as legacy \t, which the byte path folds to
    // Ctrl-I; the two are indistinguishable by design.
    id: "tui.dashboard.nextNeedsMe",
    pattern: { kind: "char", char: "i", ctrl: true },
    action: "tui.focus.nextNeedsMe",
    outcome: "handled",
    help: {
      keys: "⇥",
      label: "next session needing you",
    },
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
    help: {
      keys: "?",
      label: "help",
    },
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
    help: {
      keys: "Esc",
      label: "clear persistent filter",
    },
  },
  {
    id: "tui.dashboard.filter",
    pattern: { kind: "char", char: "/" },
    action: "tui.filter.open",
    outcome: "handled",
    help: {
      keys: "/",
      label: "filter",
    },
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
    help: {
      keys: "X",
      label: "delete session",
    },
  },
  {
    id: "tui.dashboard.newSession",
    pattern: { kind: "char", char: "N" },
    action: "tui.newSession.open",
    outcome: "handled",
    help: {
      keys: "N",
      label: "new",
    },
  },
  {
    id: "tui.dashboard.quickGroup",
    pattern: { kind: "char", char: "G" },
    action: "tui.quickGroup.create",
    outcome: "handled",
    help: {
      keys: "G",
      label: "quick group",
    },
  },
  {
    id: "tui.dashboard.addProject",
    pattern: { kind: "char", char: "A" },
    action: "tui.addProject.open",
    outcome: "handled",
    help: {
      keys: "A",
      label: "add",
    },
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

/** Typed dashboard action vocabulary decoded by the keyboard binding table. */
export type TuiDashboardAction = TuiDashboardBinding["action"];

export type TuiHelpContentLine =
  | { text: string; align?: "center" }
  | { key: string; description: string };

export const QUIT_HINT_CLOSE = "Q/esc:close";
export const QUIT_HINT_FILTER_CLOSE = "Q:close";
export const QUIT_HINT_DISMISS_ERROR = "Esc:dismiss  Q:close";

export type TuiDashboardBindingId = (typeof TUI_DASHBOARD_BINDINGS)[number]["id"];

/** Returns stable keyboard language without selecting a contextual footer layout. */
export function dashboardBindingHelp(
  id: TuiDashboardBindingId,
): { keys: string; label: string } | undefined {
  const binding = TUI_DASHBOARD_BINDINGS.find((candidate) => candidate.id === id);
  return binding !== undefined && "help" in binding ? binding.help : undefined;
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
      return matchesNamedKey(pattern.named, key);
    case "slot":
      return isSlotKey(key);
    default:
      return assertNeverDashboardPattern(pattern);
  }
}

function matchesNamedKey(named: DashboardNamedKey, key: TuiKey): boolean {
  switch (named) {
    case "return":
      return key.return === true || key.input === "\r" || key.input === "\n";
    case "escape":
      return key.escape === true;
    case "up":
      return key.upArrow === true;
    case "down":
      return key.downArrow === true;
    case "left":
      return key.leftArrow === true;
    case "right":
      return key.rightArrow === true;
    default:
      return assertNeverNamedKey(named);
  }
}

function assertNeverDashboardPattern(pattern: never): never {
  throw new Error(`Unhandled dashboard key pattern: ${JSON.stringify(pattern)}`);
}

function assertNeverNamedKey(named: never): never {
  throw new Error(`Unhandled dashboard named key: ${named}`);
}

export function matchDashboardBinding(key: TuiKey): TuiDashboardBinding | undefined {
  return (
    TUI_GLOBAL_BINDINGS.find((binding) => matchesPattern(binding.pattern, key)) ??
    TUI_DASHBOARD_BINDINGS.find((binding) => matchesPattern(binding.pattern, key))
  );
}
