import { SELECTION_KEYS, type SelectionKey } from "../selectors/selectors.js";
import type { TuiKey } from "./keys.js";
import type { TuiState } from "./types.js";

export type TuiInputMode =
  | "dashboard"
  | "help"
  | "search"
  | "projectCollapse"
  | "removeChooseSlot"
  | "removeConfirm"
  | "renameChooseSlot"
  | "renameEdit"
  | "newSessionReview"
  | "newSessionEditName"
  | "newSessionPickProject"
  | "newSessionPickAgent"
  | "addProject";

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
    case "removeWorktree":
      return screen.step === "chooseSlot" ? "removeChooseSlot" : "removeConfirm";
    case "renameSession":
      return screen.step === "chooseSlot" ? "renameChooseSlot" : "renameEdit";
    case "newSession":
      switch (screen.flow.mode) {
        case "review":
          return "newSessionReview";
        case "editName":
          return "newSessionEditName";
        case "pickProject":
          return "newSessionPickProject";
        case "pickAgent":
          return "newSessionPickAgent";
      }
      break;
    case "addProject":
      return "addProject";
  }
  return "dashboard";
}

export type TuiKeyPattern =
  | { kind: "char"; char: string; ctrl?: true }
  | {
      kind: "named";
      named: "return" | "escape" | "backspace" | "delete" | "up" | "down" | "left" | "right";
    }
  | { kind: "slot" }
  | { kind: "text" };

export type TuiBindingOutcome = "handled" | "exit" | "dismiss-popup";

export type TuiBinding = {
  id: string;
  pattern: TuiKeyPattern;
  action: string;
  outcome: TuiBindingOutcome;
  help?: { keys: string; label: string };
};

export type TuiHelpContentLine =
  | { text: string; align?: "center" }
  | { key: string; description: string };

const slotHelp = { keys: "1-9 a-z", label: "start or focus visible row" };

// Metadata only: handleTuiKey remains the behavioral source. These tables feed
// copy/tests so a documented chord cannot drift silently from the machine.
export const TUI_KEYMAP: Record<TuiInputMode, readonly TuiBinding[]> = {
  dashboard: [
    {
      id: "tui.dashboard.scrollUp",
      pattern: { kind: "named", named: "up" },
      action: "tui.view.scrollUp",
      outcome: "handled",
    },
    {
      id: "tui.dashboard.scrollDown",
      pattern: { kind: "named", named: "down" },
      action: "tui.view.scrollDown",
      outcome: "handled",
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
      id: "tui.dashboard.collapse",
      pattern: { kind: "char", char: "C" },
      action: "tui.collapse.open",
      outcome: "handled",
      help: { keys: "C", label: "fold" },
    },
    {
      id: "tui.dashboard.slotActivate",
      pattern: { kind: "slot" },
      action: "tui.row.activateSlot",
      outcome: "handled",
      help: slotHelp,
    },
  ],
  help: [
    {
      id: "tui.help.closeH",
      pattern: { kind: "char", char: "H" },
      action: "tui.help.close",
      outcome: "handled",
      help: { keys: "H/?/Q/esc", label: "close help" },
    },
    {
      id: "tui.help.closeAlias",
      pattern: { kind: "char", char: "?" },
      action: "tui.help.close",
      outcome: "handled",
    },
    {
      id: "tui.help.closeQ",
      pattern: { kind: "char", char: "Q" },
      action: "tui.help.close",
      outcome: "handled",
    },
    {
      id: "tui.help.closeEsc",
      pattern: { kind: "named", named: "escape" },
      action: "tui.help.close",
      outcome: "handled",
    },
  ],
  search: [
    {
      id: "tui.search.cancel",
      pattern: { kind: "named", named: "escape" },
      action: "tui.search.cancel",
      outcome: "handled",
      help: { keys: "esc", label: "cancel" },
    },
    {
      id: "tui.search.commit",
      pattern: { kind: "named", named: "return" },
      action: "tui.search.commit",
      outcome: "handled",
      help: { keys: "enter", label: "apply" },
    },
    {
      id: "tui.search.deleteBack",
      pattern: { kind: "named", named: "backspace" },
      action: "tui.search.deleteChar",
      outcome: "handled",
    },
    {
      id: "tui.search.deleteForward",
      pattern: { kind: "named", named: "delete" },
      action: "tui.search.deleteChar",
      outcome: "handled",
    },
    {
      id: "tui.search.type",
      pattern: { kind: "text" },
      action: "tui.search.appendText",
      outcome: "handled",
    },
  ],
  projectCollapse: [
    {
      id: "tui.collapse.cancel",
      pattern: { kind: "named", named: "escape" },
      action: "tui.collapse.cancel",
      outcome: "handled",
      help: { keys: "esc", label: "cancel" },
    },
    {
      id: "tui.collapse.toggleSlot",
      pattern: { kind: "slot" },
      action: "tui.collapse.toggleSlot",
      outcome: "handled",
      help: { keys: "1-9 a-z", label: "toggle project" },
    },
  ],
  removeChooseSlot: [
    {
      id: "tui.remove.cancel",
      pattern: { kind: "named", named: "escape" },
      action: "tui.remove.cancel",
      outcome: "handled",
      help: { keys: "esc", label: "cancel" },
    },
    {
      id: "tui.remove.scrollUp",
      pattern: { kind: "named", named: "up" },
      action: "tui.view.scrollUp",
      outcome: "handled",
    },
    {
      id: "tui.remove.scrollDown",
      pattern: { kind: "named", named: "down" },
      action: "tui.view.scrollDown",
      outcome: "handled",
    },
    {
      id: "tui.remove.chooseSlot",
      pattern: { kind: "slot" },
      action: "tui.remove.chooseSlot",
      outcome: "handled",
      help: { keys: "1-9 a-z", label: "choose row" },
    },
  ],
  removeConfirm: [
    {
      id: "tui.removeConfirm.cancelEsc",
      pattern: { kind: "named", named: "escape" },
      action: "tui.remove.cancel",
      outcome: "handled",
      help: { keys: "N/esc/enter", label: "cancel" },
    },
    {
      id: "tui.removeConfirm.cancelEnter",
      pattern: { kind: "named", named: "return" },
      action: "tui.remove.cancel",
      outcome: "handled",
    },
    {
      id: "tui.removeConfirm.cancelN",
      pattern: { kind: "char", char: "N" },
      action: "tui.remove.cancel",
      outcome: "handled",
    },
    {
      id: "tui.removeConfirm.cancelLowerN",
      pattern: { kind: "char", char: "n" },
      action: "tui.remove.cancel",
      outcome: "handled",
    },
    {
      id: "tui.removeConfirm.confirmY",
      pattern: { kind: "char", char: "Y" },
      action: "tui.remove.confirm",
      outcome: "handled",
      help: { keys: "Y", label: "confirm delete" },
    },
    {
      id: "tui.removeConfirm.confirmLowerY",
      pattern: { kind: "char", char: "y" },
      action: "tui.remove.confirm",
      outcome: "handled",
    },
    {
      id: "tui.removeConfirm.cancelCtrlN",
      pattern: { kind: "char", char: "n", ctrl: true },
      action: "tui.remove.cancel",
      outcome: "handled",
    },
    {
      id: "tui.removeConfirm.confirmCtrlY",
      pattern: { kind: "char", char: "y", ctrl: true },
      action: "tui.remove.confirm",
      outcome: "handled",
    },
  ],
  renameChooseSlot: [
    {
      id: "tui.rename.cancel",
      pattern: { kind: "named", named: "escape" },
      action: "tui.rename.cancel",
      outcome: "handled",
      help: { keys: "esc", label: "cancel" },
    },
    {
      id: "tui.rename.scrollUp",
      pattern: { kind: "named", named: "up" },
      action: "tui.view.scrollUp",
      outcome: "handled",
    },
    {
      id: "tui.rename.scrollDown",
      pattern: { kind: "named", named: "down" },
      action: "tui.view.scrollDown",
      outcome: "handled",
    },
    {
      id: "tui.rename.chooseSlot",
      pattern: { kind: "slot" },
      action: "tui.rename.chooseSlot",
      outcome: "handled",
      help: { keys: "1-9 a-z", label: "choose row" },
    },
  ],
  renameEdit: [
    {
      id: "tui.renameEdit.back",
      pattern: { kind: "named", named: "escape" },
      action: "tui.rename.back",
      outcome: "handled",
      help: { keys: "esc", label: "back" },
    },
    {
      id: "tui.renameEdit.submit",
      pattern: { kind: "named", named: "return" },
      action: "tui.rename.submit",
      outcome: "handled",
      help: { keys: "enter", label: "rename" },
    },
    {
      id: "tui.renameEdit.backspace",
      pattern: { kind: "named", named: "backspace" },
      action: "tui.rename.edit",
      outcome: "handled",
    },
    {
      id: "tui.renameEdit.delete",
      pattern: { kind: "named", named: "delete" },
      action: "tui.rename.edit",
      outcome: "handled",
    },
    {
      id: "tui.renameEdit.cursorLeft",
      pattern: { kind: "named", named: "left" },
      action: "tui.rename.edit",
      outcome: "handled",
    },
    {
      id: "tui.renameEdit.cursorRight",
      pattern: { kind: "named", named: "right" },
      action: "tui.rename.edit",
      outcome: "handled",
    },
    {
      id: "tui.renameEdit.type",
      pattern: { kind: "text" },
      action: "tui.rename.edit",
      outcome: "handled",
    },
  ],
  newSessionReview: [
    {
      id: "tui.newSession.cancel",
      pattern: { kind: "named", named: "escape" },
      action: "tui.newSession.cancel",
      outcome: "handled",
      help: { keys: "esc", label: "cancel" },
    },
    {
      id: "tui.newSession.create",
      pattern: { kind: "named", named: "return" },
      action: "tui.newSession.submit",
      outcome: "handled",
      help: { keys: "enter", label: "create" },
    },
    {
      id: "tui.newSession.editName",
      pattern: { kind: "char", char: "N" },
      action: "tui.newSession.editName",
      outcome: "handled",
      help: { keys: "N", label: "name" },
    },
    {
      id: "tui.newSession.pickProject",
      pattern: { kind: "char", char: "P" },
      action: "tui.newSession.pickProject",
      outcome: "handled",
      help: { keys: "P", label: "project" },
    },
    {
      id: "tui.newSession.pickAgent",
      pattern: { kind: "char", char: "A" },
      action: "tui.newSession.pickAgent",
      outcome: "handled",
      help: { keys: "A", label: "agent" },
    },
  ],
  newSessionEditName: [
    {
      id: "tui.newSessionEdit.cancel",
      pattern: { kind: "named", named: "escape" },
      action: "tui.newSession.cancel",
      outcome: "handled",
      help: { keys: "esc", label: "cancel" },
    },
    {
      id: "tui.newSessionEdit.commit",
      pattern: { kind: "named", named: "return" },
      action: "tui.newSession.commitName",
      outcome: "handled",
      help: { keys: "enter", label: "use name" },
    },
    {
      id: "tui.newSessionEdit.backspace",
      pattern: { kind: "named", named: "backspace" },
      action: "tui.newSession.editInput",
      outcome: "handled",
    },
    {
      id: "tui.newSessionEdit.delete",
      pattern: { kind: "named", named: "delete" },
      action: "tui.newSession.editInput",
      outcome: "handled",
    },
    {
      id: "tui.newSessionEdit.cursorLeft",
      pattern: { kind: "named", named: "left" },
      action: "tui.newSession.editInput",
      outcome: "handled",
    },
    {
      id: "tui.newSessionEdit.cursorRight",
      pattern: { kind: "named", named: "right" },
      action: "tui.newSession.editInput",
      outcome: "handled",
    },
    {
      id: "tui.newSessionEdit.type",
      pattern: { kind: "text" },
      action: "tui.newSession.editInput",
      outcome: "handled",
    },
  ],
  newSessionPickProject: [
    {
      id: "tui.newSessionProject.cancel",
      pattern: { kind: "named", named: "escape" },
      action: "tui.newSession.cancel",
      outcome: "handled",
      help: { keys: "esc", label: "cancel" },
    },
    {
      id: "tui.newSessionProject.choose",
      pattern: { kind: "slot" },
      action: "tui.newSession.chooseProject",
      outcome: "handled",
      help: { keys: "1-9 a-z", label: "choose project" },
    },
  ],
  newSessionPickAgent: [
    {
      id: "tui.newSessionAgent.cancel",
      pattern: { kind: "named", named: "escape" },
      action: "tui.newSession.cancel",
      outcome: "handled",
      help: { keys: "esc", label: "cancel" },
    },
    {
      id: "tui.newSessionAgent.choose",
      pattern: { kind: "slot" },
      action: "tui.newSession.chooseAgent",
      outcome: "handled",
      help: { keys: "1-9 a-z", label: "choose agent" },
    },
  ],
  addProject: [
    {
      id: "tui.addProject.cancel",
      pattern: { kind: "named", named: "escape" },
      action: "tui.addProject.key",
      outcome: "handled",
      help: { keys: "esc", label: "back/cancel" },
    },
    {
      id: "tui.addProject.confirm",
      pattern: { kind: "named", named: "return" },
      action: "tui.addProject.key",
      outcome: "handled",
      help: { keys: "enter", label: "confirm" },
    },
    {
      id: "tui.addProject.up",
      pattern: { kind: "named", named: "up" },
      action: "tui.addProject.key",
      outcome: "handled",
    },
    {
      id: "tui.addProject.down",
      pattern: { kind: "named", named: "down" },
      action: "tui.addProject.key",
      outcome: "handled",
    },
    {
      id: "tui.addProject.left",
      pattern: { kind: "named", named: "left" },
      action: "tui.addProject.key",
      outcome: "handled",
    },
    {
      id: "tui.addProject.right",
      pattern: { kind: "named", named: "right" },
      action: "tui.addProject.key",
      outcome: "handled",
    },
    {
      id: "tui.addProject.backspace",
      pattern: { kind: "named", named: "backspace" },
      action: "tui.addProject.key",
      outcome: "handled",
    },
    {
      id: "tui.addProject.delete",
      pattern: { kind: "named", named: "delete" },
      action: "tui.addProject.key",
      outcome: "handled",
    },
    {
      id: "tui.addProject.clearLine",
      pattern: { kind: "char", char: "u", ctrl: true },
      action: "tui.addProject.key",
      outcome: "handled",
    },
    {
      id: "tui.addProject.type",
      pattern: { kind: "text" },
      action: "tui.addProject.key",
      outcome: "handled",
    },
  ],
};

export const TUI_GLOBAL_BINDINGS: readonly TuiBinding[] = [
  {
    id: "tui.global.exitIntent",
    pattern: { kind: "char", char: "c", ctrl: true },
    action: "tui.exit",
    outcome: "exit",
  },
];

export const TUI_HELP_CONTENT = [
  { text: "station help", align: "center" as const },
  { text: "" },
  { key: "↑/↓ wheel", description: "scroll dashboard" },
  { key: "1-9/a-z", description: "choose visible item" },
  { key: "N", description: "new session" },
  { key: "R", description: "rename session" },
  { key: "X", description: "delete session" },
  { key: "C", description: "collapse project" },
  { key: "/", description: "search" },
  { key: "Z", description: "refresh snapshot" },
  { key: "H / ?", description: "help" },
  { key: "Q", description: "quit or close popup" },
  { key: "Esc", description: "back/cancel" },
] as const satisfies readonly TuiHelpContentLine[];

export const QUIT_HINT_CLOSE = "Q/esc:close";
export const QUIT_HINT_QUIT = "Q:quit";

/** The footer quit hint for a quit action; the single source for this copy. */
export function quitHintLabel(quitActionLabel: "close" | "quit"): string {
  return quitActionLabel === "close" ? QUIT_HINT_CLOSE : QUIT_HINT_QUIT;
}

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
    ? `A:Add Project ${quitHint}`
    : `N:new A:add R:rename Z:refresh 1-9/a-z:open X:delete session /:search C:fold H:help ${quitHint}`;
  const compactClose = `${QUIT_HINT_CLOSE} N:new A:add Z:refresh 1-9/a-z:open X:delete session /:search H:help`;
  return quitHint === QUIT_HINT_CLOSE && full.length > columns ? compactClose : full;
}

export function isSlotKey(key: TuiKey): boolean {
  // Ctrl is deliberately not excluded: row choice dispatch reads key.input, so
  // Ctrl-A still targets slot "a" after the global Ctrl-C exit binding runs.
  return (
    key.return !== true && key.escape !== true && SELECTION_KEYS.includes(key.input as SelectionKey)
  );
}

function matchesPattern(pattern: TuiKeyPattern, key: TuiKey): boolean {
  switch (pattern.kind) {
    case "char":
      return (
        key.input === pattern.char &&
        (pattern.ctrl === true) === (key.ctrl === true) &&
        key.return !== true &&
        key.escape !== true
      );
    case "named":
      switch (pattern.named) {
        case "return":
          return key.return === true || key.input === "\r" || key.input === "\n";
        case "escape":
          return key.escape === true;
        case "backspace":
          return key.backspace === true;
        case "delete":
          return key.delete === true;
        case "up":
          return key.upArrow === true;
        case "down":
          return key.downArrow === true;
        case "left":
          return key.leftArrow === true;
        case "right":
          return key.rightArrow === true;
      }
      return false;
    case "slot":
      return isSlotKey(key);
    case "text":
      // Text handlers also read key.input with ctrl present; specific bindings
      // must stay before this catch-all in every mode table.
      return (
        key.input.length > 0 &&
        key.return !== true &&
        key.escape !== true &&
        key.backspace !== true &&
        key.delete !== true &&
        key.upArrow !== true &&
        key.downArrow !== true &&
        key.leftArrow !== true &&
        key.rightArrow !== true
      );
  }
}

export function matchingTuiBindings(mode: TuiInputMode, key: TuiKey): readonly TuiBinding[] {
  const globals = TUI_GLOBAL_BINDINGS.filter((binding) => matchesPattern(binding.pattern, key));
  if (globals.length > 0) {
    return globals;
  }
  return TUI_KEYMAP[mode].filter((binding) => matchesPattern(binding.pattern, key));
}

export function matchTuiBinding(mode: TuiInputMode, key: TuiKey): TuiBinding | undefined {
  return matchingTuiBindings(mode, key)[0];
}
