import { SELECTION_KEYS, type SelectionKey } from "../selectors/selectors.js";
import type { TuiKey } from "./keys.js";
import type { TuiState } from "./types.js";

export type TuiInputMode =
  | "dashboard"
  | "help"
  | "search"
  | "persistentFilter"
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

export function deriveTuiInputMode(state: TuiState): TuiInputMode {
  const screen = state.screen;
  switch (screen.name) {
    case "dashboard":
      return "dashboard";
    case "help":
      return "help";
    case "search":
      return "search";
    case "persistentFilter":
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

type DashboardBindingSpec = {
  id: string;
  pattern: DashboardKeyPattern;
  action: string;
  outcome: "handled" | "exit" | "dismiss-popup";
  help?: {
    keys: string;
    label: string;
    footer?: DashboardFooterMetadata;
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
      footer: {
        order: 10,
        labels: {
          full: "activate",
          compact: "activate",
          firstRunFull: "add first project",
          firstRunCompact: "add first project",
        },
      },
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
      footer: {
        order: 40,
        labels: { full: "next-needs-me", compact: "next" },
      },
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
      footer: { order: 70, labels: { full: "help", compact: "help" } },
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
      footer: {
        order: 55,
        labels: { filteredFull: "clear", filteredCompact: "clear" },
      },
    },
  },
  {
    id: "tui.dashboard.search",
    pattern: { kind: "char", char: "/" },
    action: "tui.search.open",
    outcome: "handled",
    help: {
      keys: "/",
      label: "search",
      footer: {
        order: 50,
        labels: {
          full: "search",
          compact: "search",
          filteredFull: "edit",
          filteredCompact: "edit",
        },
      },
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
      footer: { order: 60, labels: { full: "delete", compact: "delete" } },
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
      footer: { order: 20, labels: { full: "new", compact: "new" } },
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
      footer: {
        order: 30,
        labels: { full: "add", firstRunFull: "add project" },
      },
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

export function dashboardFooterLabel({
  columns,
  quitHint,
  firstRun = false,
  persistentFilter = false,
}: {
  columns: number;
  quitHint: string;
  firstRun?: boolean;
  persistentFilter?: boolean;
}): string {
  const full = dashboardFooterCandidate(
    dashboardFooterVariant("full", firstRun, persistentFilter),
    quitHint,
  );
  const compact = dashboardFooterCandidate(
    dashboardFooterVariant("compact", firstRun, persistentFilter),
    quitHint,
  );
  if (full.length <= columns) {
    return full;
  }
  if (quitHint === QUIT_HINT_DISMISS_ERROR && compact.length > columns) {
    return quitHint;
  }
  return compact;
}

type DashboardFooterWidth = "full" | "compact";
type DashboardFooterShortcut = { order: number; text: string };

function dashboardFooterVariant(
  width: DashboardFooterWidth,
  firstRun: boolean,
  persistentFilter: boolean,
): DashboardFooterVariant {
  if (firstRun) {
    return width === "full" ? "firstRunFull" : "firstRunCompact";
  }
  if (persistentFilter) {
    return width === "full" ? "filteredFull" : "filteredCompact";
  }
  return width;
}

function dashboardFooterCandidate(variant: DashboardFooterVariant, quitHint: string): string {
  const shortcuts = dashboardFooterShortcuts(variant);
  return shortcuts.length === 0 ? quitHint : `${shortcuts}  ${quitHint}`;
}

function dashboardFooterShortcuts(variant: DashboardFooterVariant): string {
  const bindings: readonly DashboardBindingSpec[] = TUI_DASHBOARD_BINDINGS;
  // Presentation order stays in footer metadata so key-match precedence can remain independent.
  return bindings
    .map((binding) => dashboardFooterShortcut(binding, variant))
    .filter((shortcut): shortcut is DashboardFooterShortcut => shortcut !== undefined)
    .sort((left, right) => left.order - right.order)
    .map(({ text }) => text)
    .join("  ");
}

function dashboardFooterShortcut(
  binding: DashboardBindingSpec,
  variant: DashboardFooterVariant,
): DashboardFooterShortcut | undefined {
  const help = binding.help;
  if (help === undefined || help.footer === undefined) {
    return undefined;
  }
  const footer = help.footer;
  const label = dashboardFooterLabelForVariant(footer.labels, variant);
  if (label === undefined) {
    return undefined;
  }
  return { order: footer.order, text: `${help.keys} ${label}` };
}

function dashboardFooterLabelForVariant(
  labels: DashboardFooterMetadata["labels"],
  variant: DashboardFooterVariant,
): string | undefined {
  const label = labels[variant];
  if (label !== undefined) {
    return label;
  }
  const fallbackVariant = dashboardFooterFallbackVariant(variant);
  if (fallbackVariant === undefined) {
    return undefined;
  }
  return labels[fallbackVariant];
}

function dashboardFooterFallbackVariant(
  variant: DashboardFooterVariant,
): DashboardFooterVariant | undefined {
  switch (variant) {
    case "filteredFull":
      return "full";
    case "filteredCompact":
      return "compact";
    case "full":
    case "compact":
    case "firstRunFull":
    case "firstRunCompact":
      return undefined;
    default:
      return undefined;
  }
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
