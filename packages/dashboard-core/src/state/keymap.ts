import { SELECTION_KEYS, type SelectionKey } from "../selectors/selectors.js";
import type { TuiKey } from "./keys.js";
import { selectableListBindings } from "./selection/bindings.js";
import type { TuiState } from "./types.js";

export type TuiInputMode =
  | "dashboard"
  | "help"
  | "search"
  | "projectCollapse"
  | "projectSettingsPicker"
  | "removeChooseSlot"
  | "removeConfirm"
  | "renameChooseSlot"
  | "renameEdit"
  | "forkChooseSlot"
  | "forkDetails"
  | "newSessionReview"
  | "newSessionEditName"
  | "newSessionPickProject"
  | "newSessionPickAgent"
  | "projectDefaultAgent"
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
      return screen.step === "chooseSlot" ? "removeChooseSlot" : "removeConfirm";
    case "renameSession":
      return screen.step === "chooseSlot" ? "renameChooseSlot" : "renameEdit";
    case "fork":
      return screen.step === "chooseSlot" ? "forkChooseSlot" : "forkDetails";
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
    case "projectDefaultAgent":
      return "projectDefaultAgent";
    case "widgetSettings":
      return "widgetSettings";
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

export type TuiBindingSpec = {
  id: string;
  pattern: TuiKeyPattern;
  action: string;
  outcome: TuiBindingOutcome;
  help?: { keys: string; label: string };
};

// The shared editable-text key block (cursor moves, backspace/delete, and a trailing
// text catch-all) reused by every single-field edit mode. All keys route to one action
// the mode handler interprets, so modes never redeclare this boilerplate.
export function editableTextBindings(
  prefix: string,
  action: string,
  typeHelp?: { keys: string; label: string },
): readonly TuiBindingSpec[] {
  return [
    {
      id: `${prefix}.cursorLeft`,
      pattern: { kind: "named", named: "left" },
      action,
      outcome: "handled",
    },
    {
      id: `${prefix}.cursorRight`,
      pattern: { kind: "named", named: "right" },
      action,
      outcome: "handled",
    },
    {
      id: `${prefix}.backspace`,
      pattern: { kind: "named", named: "backspace" },
      action,
      outcome: "handled",
    },
    {
      id: `${prefix}.delete`,
      pattern: { kind: "named", named: "delete" },
      action,
      outcome: "handled",
    },
    {
      id: `${prefix}.type`,
      pattern: { kind: "text" },
      action,
      outcome: "handled",
      ...(typeHelp === undefined ? {} : { help: typeHelp }),
    },
  ];
}

export type TuiHelpContentLine =
  | { text: string; align?: "center" }
  | { key: string; description: string };

const slotHelp = { keys: "1-9 a-z", label: "start or focus visible row" };

// Dashboard dispatch resolves through this table before executing the binding's
// action. Other mode tables feed copy/tests so documented chords cannot drift
// silently from their screen machines.
export const TUI_KEYMAP = {
  dashboard: [
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
      // Ctrl-I (sequenceToTuiKey) — the two are indistinguishable by design.
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
  projectSettingsPicker: [
    {
      id: "tui.projectSettingsPicker.cancel",
      pattern: { kind: "named", named: "escape" },
      action: "tui.projectSettings.pickerCancel",
      outcome: "handled",
      help: { keys: "esc", label: "cancel" },
    },
    {
      id: "tui.projectSettingsPicker.choose",
      pattern: { kind: "slot" },
      action: "tui.projectSettings.pick",
      outcome: "handled",
      help: { keys: "1-9 a-z", label: "open settings" },
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
    ...editableTextBindings("tui.renameEdit", "tui.rename.edit"),
  ],
  forkChooseSlot: [
    {
      id: "tui.fork.cancel",
      pattern: { kind: "named", named: "escape" },
      action: "tui.fork.cancel",
      outcome: "handled",
      help: { keys: "esc", label: "cancel" },
    },
    {
      id: "tui.fork.scrollUp",
      pattern: { kind: "named", named: "up" },
      action: "tui.view.scrollUp",
      outcome: "handled",
    },
    {
      id: "tui.fork.scrollDown",
      pattern: { kind: "named", named: "down" },
      action: "tui.view.scrollDown",
      outcome: "handled",
    },
    {
      id: "tui.fork.chooseSlot",
      pattern: { kind: "slot" },
      action: "tui.fork.chooseSlot",
      outcome: "handled",
      help: { keys: "1-9 a-z", label: "choose source" },
    },
  ],
  forkDetails: [
    {
      id: "tui.forkDetails.back",
      pattern: { kind: "named", named: "escape" },
      action: "tui.fork.back",
      outcome: "handled",
      help: { keys: "esc", label: "back" },
    },
    {
      id: "tui.forkDetails.submit",
      pattern: { kind: "named", named: "return" },
      action: "tui.fork.submit",
      outcome: "handled",
      help: { keys: "enter", label: "fork" },
    },
    {
      id: "tui.forkDetails.focusUp",
      pattern: { kind: "named", named: "up" },
      action: "tui.fork.focus",
      outcome: "handled",
    },
    {
      id: "tui.forkDetails.focusDown",
      pattern: { kind: "named", named: "down" },
      action: "tui.fork.focus",
      outcome: "handled",
      help: { keys: "↑↓", label: "field" },
    },
    ...editableTextBindings("tui.forkDetails", "tui.fork.detailKey", {
      keys: "space",
      label: "toggle copy",
    }),
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
    ...editableTextBindings("tui.newSessionEdit", "tui.newSession.editInput"),
  ],
  newSessionPickProject: [
    {
      id: "tui.newSessionProject.cancel",
      pattern: { kind: "named", named: "escape" },
      action: "tui.newSession.cancel",
      outcome: "handled",
      help: { keys: "esc", label: "cancel" },
    },
    ...selectableListBindings("tui.newSessionProject"),
  ],
  newSessionPickAgent: [
    {
      id: "tui.newSessionAgent.cancel",
      pattern: { kind: "named", named: "escape" },
      action: "tui.newSession.cancel",
      outcome: "handled",
      help: { keys: "esc", label: "cancel" },
    },
    ...selectableListBindings("tui.newSessionAgent"),
  ],
  projectDefaultAgent: [
    {
      id: "tui.projectDefaultAgent.cancel",
      pattern: { kind: "named", named: "escape" },
      action: "tui.projectDefaultAgent.cancel",
      outcome: "handled",
      help: { keys: "esc", label: "cancel" },
    },
    ...selectableListBindings("tui.projectDefaultAgent"),
  ],
  // One action; the widgetSettings screen handler decodes list-vs-picker focus.
  widgetSettings: [
    {
      id: "tui.widgetSettings.close",
      pattern: { kind: "named", named: "escape" },
      action: "tui.widgetSettings.key",
      outcome: "handled",
      help: { keys: "esc", label: "close" },
    },
    {
      id: "tui.widgetSettings.cursorUp",
      pattern: { kind: "named", named: "up" },
      action: "tui.widgetSettings.key",
      outcome: "handled",
    },
    {
      id: "tui.widgetSettings.cursorDown",
      pattern: { kind: "named", named: "down" },
      action: "tui.widgetSettings.key",
      outcome: "handled",
    },
    {
      id: "tui.widgetSettings.toggle",
      pattern: { kind: "named", named: "return" },
      action: "tui.widgetSettings.key",
      outcome: "handled",
      help: { keys: "↵", label: "toggle on/off" },
    },
    {
      id: "tui.widgetSettings.toggleSpace",
      pattern: { kind: "char", char: " " },
      action: "tui.widgetSettings.key",
      outcome: "handled",
    },
    {
      id: "tui.widgetSettings.moveUp",
      pattern: { kind: "char", char: "[" },
      action: "tui.widgetSettings.key",
      outcome: "handled",
      help: { keys: "[ ]", label: "reorder" },
    },
    {
      id: "tui.widgetSettings.moveDown",
      pattern: { kind: "char", char: "]" },
      action: "tui.widgetSettings.key",
      outcome: "handled",
    },
    {
      id: "tui.widgetSettings.remove",
      pattern: { kind: "char", char: "x" },
      action: "tui.widgetSettings.key",
      outcome: "handled",
      help: { keys: "x", label: "remove" },
    },
    {
      id: "tui.widgetSettings.add",
      pattern: { kind: "char", char: "a" },
      action: "tui.widgetSettings.key",
      outcome: "handled",
      help: { keys: "a", label: "add widget" },
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
} as const satisfies Record<TuiInputMode, readonly TuiBindingSpec[]>;

export const TUI_GLOBAL_BINDINGS = [
  {
    id: "tui.global.exitIntent",
    pattern: { kind: "char", char: "c", ctrl: true },
    action: "tui.exit",
    outcome: "exit",
  },
] as const satisfies readonly TuiBindingSpec[];

export type TuiModeBinding<M extends TuiInputMode> = (typeof TUI_KEYMAP)[M][number];
export type TuiGlobalBinding = (typeof TUI_GLOBAL_BINDINGS)[number];
export type TuiBinding<M extends TuiInputMode = TuiInputMode> =
  | TuiGlobalBinding
  | TuiModeBinding<M>;

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
  // Spec A5 triage keybar: the visible chords are the triage loop; everything
  // else lives behind "? help".
  const full = firstRun
    ? `A add project  ${quitHint}`
    : `↵ open  N new  A add  ⇥ next-needs-me  / search  X delete  ? help  ${quitHint}`;
  const compactClose = `↵ open  N new  ⇥ next  / search  X delete  ? help  ${QUIT_HINT_CLOSE}`;
  return quitHint === QUIT_HINT_CLOSE && full.length > columns ? compactClose : full;
}

export function isSlotKey(key: TuiKey): boolean {
  // Ctrl is deliberately not excluded: row choice dispatch reads key.input, so
  // Ctrl-A still targets slot "a" after the global Ctrl-C exit binding runs.
  // Ctrl-I is the exception — Tab folds to it in legacy encoding and the
  // next-needs-me chord owns it; slot "i" stays reachable without ctrl.
  if (key.ctrl === true && key.input === "i") {
    return false;
  }
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

export function matchingTuiBindings<M extends TuiInputMode>(
  mode: M,
  key: TuiKey,
): readonly TuiBinding<M>[] {
  const globals = TUI_GLOBAL_BINDINGS.filter((binding) => matchesPattern(binding.pattern, key));
  if (globals.length > 0) {
    return globals;
  }
  return TUI_KEYMAP[mode].filter((binding) => matchesPattern(binding.pattern, key));
}

export function matchTuiBinding<M extends TuiInputMode>(
  mode: M,
  key: TuiKey,
): TuiBinding<M> | undefined {
  return matchingTuiBindings(mode, key)[0];
}
