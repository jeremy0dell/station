// The STATION view's keymap as data. The shared transition machine
// (@station/dashboard-core transition.ts) stays the single behavioral source — these
// tables are the introspection contract over it: they drive the help overlay
// and footer hints, give mouse targets their action vocabulary, and are
// pinned to the machine by tests (stationKeymap.test.ts asserts every
// machine-handled key has exactly one matching binding per mode, and that
// each binding's declared outcome matches what dispatching it produces).
// Runtime keyboard dispatch does NOT branch on these tables; it always goes
// through the machine, so a table omission can never change behavior — it
// fails the coverage test instead.
import { SELECTION_KEYS, type SelectionKey } from "@station/dashboard-core";
import type { TuiKey } from "@station/dashboard-core";
import type { TuiState } from "@station/dashboard-core";

export type StationInputMode =
  | "dashboard"
  | "help"
  | "search"
  | "projectCollapse"
  | "projectSettingsPicker"
  | "removeChooseSlot"
  | "removeConfirm"
  | "renameChooseSlot"
  | "renameEdit"
  | "newSessionReview"
  | "newSessionEditName"
  | "newSessionPickProject"
  | "newSessionPickAgent"
  | "projectDefaultAgent"
  | "projectSettings"
  | "addProject";

export function deriveStationMode(state: TuiState): StationInputMode {
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
    case "projectSettings":
      return "projectSettings";
  }
  return "dashboard";
}

export type StationKeyPattern =
  /** One exact key, matched on the TuiKey's printable input (case-sensitive). */
  | { kind: "char"; char: string; ctrl?: true }
  | {
      kind: "named";
      named: "return" | "escape" | "backspace" | "delete" | "up" | "down" | "left" | "right";
    }
  /** The visible-row slot accelerators (1-9 a-z, viewport-assigned). */
  | { kind: "slot" }
  /** Any printable input not claimed by another binding (text-entry modes). */
  | { kind: "text" };

/**
 * Outcomes mirror the router's vocabulary at the granularity the STATION layer
 * produces: "handled" executes inside the view store and the router swallows
 * the key; "close-overlay" means the machine reported dismissPopup/exitCode
 * and the router closes STATION mode via the coordination store.
 */
export type StationBindingOutcome = "handled" | "close-overlay";

export type StationBinding = {
  /** Stable id, "station.<mode>.<name>" — mouse targets reference these. */
  id: string;
  pattern: StationKeyPattern;
  /** Semantic action id resolved by the stationActions registry. */
  action: string;
  outcome: StationBindingOutcome;
  /** Help-overlay / footer copy; bindings without help are chrome-invisible. */
  help?: { keys: string; label: string };
};

const slotHelp = { keys: "1-9 a-z", label: "start or focus visible row" };

export const STATION_KEYMAP: Record<StationInputMode, readonly StationBinding[]> = {
  dashboard: [
    { id: "station.dashboard.scrollUp", pattern: { kind: "named", named: "up" }, action: "station.view.scrollUp", outcome: "handled" },
    { id: "station.dashboard.scrollDown", pattern: { kind: "named", named: "down" }, action: "station.view.scrollDown", outcome: "handled" },
    { id: "station.dashboard.help", pattern: { kind: "char", char: "H" }, action: "station.help.open", outcome: "handled", help: { keys: "H", label: "help" } },
    { id: "station.dashboard.helpAlias", pattern: { kind: "char", char: "?" }, action: "station.help.open", outcome: "handled" },
    { id: "station.dashboard.dismiss", pattern: { kind: "char", char: "Q" }, action: "station.overlay.dismiss", outcome: "close-overlay", help: { keys: "Q/esc", label: "close" } },
    { id: "station.dashboard.dismissEsc", pattern: { kind: "named", named: "escape" }, action: "station.overlay.dismiss", outcome: "close-overlay" },
    { id: "station.dashboard.search", pattern: { kind: "char", char: "/" }, action: "station.search.open", outcome: "handled", help: { keys: "/", label: "search" } },
    { id: "station.dashboard.rename", pattern: { kind: "char", char: "R" }, action: "station.rename.open", outcome: "handled", help: { keys: "R", label: "rename" } },
    { id: "station.dashboard.refresh", pattern: { kind: "char", char: "Z" }, action: "station.refresh", outcome: "handled", help: { keys: "Z", label: "refresh" } },
    { id: "station.dashboard.remove", pattern: { kind: "char", char: "X" }, action: "station.remove.open", outcome: "handled", help: { keys: "X", label: "delete session" } },
    { id: "station.dashboard.newSession", pattern: { kind: "char", char: "N" }, action: "station.newSession.open", outcome: "handled", help: { keys: "N", label: "new" } },
    { id: "station.dashboard.addProject", pattern: { kind: "char", char: "A" }, action: "station.addProject.open", outcome: "handled", help: { keys: "A", label: "add" } },
    { id: "station.dashboard.collapse", pattern: { kind: "char", char: "C" }, action: "station.collapse.open", outcome: "handled", help: { keys: "C", label: "fold" } },
    { id: "station.dashboard.projectSettings", pattern: { kind: "char", char: "P" }, action: "station.projectSettings.openPicker", outcome: "handled", help: { keys: "P", label: "settings" } },
    { id: "station.dashboard.slotActivate", pattern: { kind: "slot" }, action: "station.row.activateSlot", outcome: "handled", help: slotHelp },
  ],
  help: [
    { id: "station.help.closeH", pattern: { kind: "char", char: "H" }, action: "station.help.close", outcome: "handled", help: { keys: "H/?/Q/esc", label: "close help" } },
    { id: "station.help.closeAlias", pattern: { kind: "char", char: "?" }, action: "station.help.close", outcome: "handled" },
    { id: "station.help.closeQ", pattern: { kind: "char", char: "Q" }, action: "station.help.close", outcome: "handled" },
    { id: "station.help.closeEsc", pattern: { kind: "named", named: "escape" }, action: "station.help.close", outcome: "handled" },
  ],
  search: [
    { id: "station.search.cancel", pattern: { kind: "named", named: "escape" }, action: "station.search.cancel", outcome: "handled", help: { keys: "esc", label: "cancel" } },
    { id: "station.search.commit", pattern: { kind: "named", named: "return" }, action: "station.search.commit", outcome: "handled", help: { keys: "enter", label: "apply" } },
    { id: "station.search.deleteBack", pattern: { kind: "named", named: "backspace" }, action: "station.search.deleteChar", outcome: "handled" },
    { id: "station.search.deleteForward", pattern: { kind: "named", named: "delete" }, action: "station.search.deleteChar", outcome: "handled" },
    { id: "station.search.type", pattern: { kind: "text" }, action: "station.search.appendText", outcome: "handled" },
  ],
  projectCollapse: [
    { id: "station.collapse.cancel", pattern: { kind: "named", named: "escape" }, action: "station.collapse.cancel", outcome: "handled", help: { keys: "esc", label: "cancel" } },
    { id: "station.collapse.toggleSlot", pattern: { kind: "slot" }, action: "station.collapse.toggleSlot", outcome: "handled", help: { keys: "1-9 a-z", label: "toggle project" } },
  ],
  projectSettingsPicker: [
    { id: "station.projectSettingsPicker.cancel", pattern: { kind: "named", named: "escape" }, action: "station.projectSettings.pickerCancel", outcome: "handled", help: { keys: "esc", label: "cancel" } },
    { id: "station.projectSettingsPicker.choose", pattern: { kind: "slot" }, action: "station.projectSettings.pick", outcome: "handled", help: { keys: "1-9 a-z", label: "open settings" } },
  ],
  removeChooseSlot: [
    { id: "station.remove.cancel", pattern: { kind: "named", named: "escape" }, action: "station.remove.cancel", outcome: "handled", help: { keys: "esc", label: "cancel" } },
    { id: "station.remove.scrollUp", pattern: { kind: "named", named: "up" }, action: "station.view.scrollUp", outcome: "handled" },
    { id: "station.remove.scrollDown", pattern: { kind: "named", named: "down" }, action: "station.view.scrollDown", outcome: "handled" },
    { id: "station.remove.chooseSlot", pattern: { kind: "slot" }, action: "station.remove.chooseSlot", outcome: "handled", help: { keys: "1-9 a-z", label: "choose row" } },
  ],
  removeConfirm: [
    { id: "station.removeConfirm.cancelEsc", pattern: { kind: "named", named: "escape" }, action: "station.remove.cancel", outcome: "handled", help: { keys: "N/esc/enter", label: "cancel" } },
    { id: "station.removeConfirm.cancelEnter", pattern: { kind: "named", named: "return" }, action: "station.remove.cancel", outcome: "handled" },
    { id: "station.removeConfirm.cancelN", pattern: { kind: "char", char: "N" }, action: "station.remove.cancel", outcome: "handled" },
    { id: "station.removeConfirm.cancelLowerN", pattern: { kind: "char", char: "n" }, action: "station.remove.cancel", outcome: "handled" },
    { id: "station.removeConfirm.confirmY", pattern: { kind: "char", char: "Y" }, action: "station.remove.confirm", outcome: "handled", help: { keys: "Y", label: "confirm delete" } },
    { id: "station.removeConfirm.confirmLowerY", pattern: { kind: "char", char: "y" }, action: "station.remove.confirm", outcome: "handled" },
    // The confirm handler lowercases key.input without reading ctrl, so the
    // Ctrl-N/Ctrl-Y control bytes cancel/confirm too (upstream behavior).
    { id: "station.removeConfirm.cancelCtrlN", pattern: { kind: "char", char: "n", ctrl: true }, action: "station.remove.cancel", outcome: "handled" },
    { id: "station.removeConfirm.confirmCtrlY", pattern: { kind: "char", char: "y", ctrl: true }, action: "station.remove.confirm", outcome: "handled" },
  ],
  // Two-pane Project Settings panel. Like addProject, every key routes to one
  // action and the dashboard-core machine decodes it against the panel's focus
  // (list vs detail) and active item — so this is a union table, exempted from
  // the stale-binding audit the same way addProject is.
  projectSettings: [
    { id: "station.projectSettings.cancel", pattern: { kind: "named", named: "escape" }, action: "station.projectSettings.key", outcome: "handled", help: { keys: "esc", label: "back/close" } },
    { id: "station.projectSettings.confirm", pattern: { kind: "named", named: "return" }, action: "station.projectSettings.key", outcome: "handled", help: { keys: "→/enter", label: "edit/confirm" } },
    { id: "station.projectSettings.up", pattern: { kind: "named", named: "up" }, action: "station.projectSettings.key", outcome: "handled" },
    { id: "station.projectSettings.down", pattern: { kind: "named", named: "down" }, action: "station.projectSettings.key", outcome: "handled", help: { keys: "↑↓", label: "move" } },
    { id: "station.projectSettings.left", pattern: { kind: "named", named: "left" }, action: "station.projectSettings.key", outcome: "handled" },
    { id: "station.projectSettings.right", pattern: { kind: "named", named: "right" }, action: "station.projectSettings.key", outcome: "handled" },
    { id: "station.projectSettings.backspace", pattern: { kind: "named", named: "backspace" }, action: "station.projectSettings.key", outcome: "handled" },
    { id: "station.projectSettings.delete", pattern: { kind: "named", named: "delete" }, action: "station.projectSettings.key", outcome: "handled" },
    { id: "station.projectSettings.clearLine", pattern: { kind: "char", char: "u", ctrl: true }, action: "station.projectSettings.key", outcome: "handled" },
    { id: "station.projectSettings.type", pattern: { kind: "text" }, action: "station.projectSettings.key", outcome: "handled" },
  ],
  renameChooseSlot: [
    { id: "station.rename.cancel", pattern: { kind: "named", named: "escape" }, action: "station.rename.cancel", outcome: "handled", help: { keys: "esc", label: "cancel" } },
    { id: "station.rename.scrollUp", pattern: { kind: "named", named: "up" }, action: "station.view.scrollUp", outcome: "handled" },
    { id: "station.rename.scrollDown", pattern: { kind: "named", named: "down" }, action: "station.view.scrollDown", outcome: "handled" },
    { id: "station.rename.chooseSlot", pattern: { kind: "slot" }, action: "station.rename.chooseSlot", outcome: "handled", help: { keys: "1-9 a-z", label: "choose row" } },
  ],
  renameEdit: [
    { id: "station.renameEdit.back", pattern: { kind: "named", named: "escape" }, action: "station.rename.back", outcome: "handled", help: { keys: "esc", label: "back" } },
    { id: "station.renameEdit.submit", pattern: { kind: "named", named: "return" }, action: "station.rename.submit", outcome: "handled", help: { keys: "enter", label: "rename" } },
    { id: "station.renameEdit.backspace", pattern: { kind: "named", named: "backspace" }, action: "station.rename.edit", outcome: "handled" },
    { id: "station.renameEdit.delete", pattern: { kind: "named", named: "delete" }, action: "station.rename.edit", outcome: "handled" },
    { id: "station.renameEdit.cursorLeft", pattern: { kind: "named", named: "left" }, action: "station.rename.edit", outcome: "handled" },
    { id: "station.renameEdit.cursorRight", pattern: { kind: "named", named: "right" }, action: "station.rename.edit", outcome: "handled" },
    { id: "station.renameEdit.type", pattern: { kind: "text" }, action: "station.rename.edit", outcome: "handled" },
  ],
  newSessionReview: [
    { id: "station.newSession.cancel", pattern: { kind: "named", named: "escape" }, action: "station.newSession.cancel", outcome: "handled", help: { keys: "esc", label: "cancel" } },
    { id: "station.newSession.create", pattern: { kind: "named", named: "return" }, action: "station.newSession.submit", outcome: "handled", help: { keys: "enter", label: "create" } },
    { id: "station.newSession.editName", pattern: { kind: "char", char: "N" }, action: "station.newSession.editName", outcome: "handled", help: { keys: "N", label: "name" } },
    { id: "station.newSession.pickProject", pattern: { kind: "char", char: "P" }, action: "station.newSession.pickProject", outcome: "handled", help: { keys: "P", label: "project" } },
    { id: "station.newSession.pickAgent", pattern: { kind: "char", char: "A" }, action: "station.newSession.pickAgent", outcome: "handled", help: { keys: "A", label: "agent" } },
  ],
  newSessionEditName: [
    { id: "station.newSessionEdit.cancel", pattern: { kind: "named", named: "escape" }, action: "station.newSession.cancel", outcome: "handled", help: { keys: "esc", label: "cancel" } },
    { id: "station.newSessionEdit.commit", pattern: { kind: "named", named: "return" }, action: "station.newSession.commitName", outcome: "handled", help: { keys: "enter", label: "use name" } },
    { id: "station.newSessionEdit.backspace", pattern: { kind: "named", named: "backspace" }, action: "station.newSession.editInput", outcome: "handled" },
    { id: "station.newSessionEdit.delete", pattern: { kind: "named", named: "delete" }, action: "station.newSession.editInput", outcome: "handled" },
    { id: "station.newSessionEdit.cursorLeft", pattern: { kind: "named", named: "left" }, action: "station.newSession.editInput", outcome: "handled" },
    { id: "station.newSessionEdit.cursorRight", pattern: { kind: "named", named: "right" }, action: "station.newSession.editInput", outcome: "handled" },
    { id: "station.newSessionEdit.type", pattern: { kind: "text" }, action: "station.newSession.editInput", outcome: "handled" },
  ],
  newSessionPickProject: [
    { id: "station.newSessionProject.cancel", pattern: { kind: "named", named: "escape" }, action: "station.newSession.cancel", outcome: "handled", help: { keys: "esc", label: "cancel" } },
    { id: "station.newSessionProject.choose", pattern: { kind: "slot" }, action: "station.newSession.chooseProject", outcome: "handled", help: { keys: "1-9 a-z", label: "choose project" } },
  ],
  newSessionPickAgent: [
    { id: "station.newSessionAgent.cancel", pattern: { kind: "named", named: "escape" }, action: "station.newSession.cancel", outcome: "handled", help: { keys: "esc", label: "cancel" } },
    { id: "station.newSessionAgent.choose", pattern: { kind: "slot" }, action: "station.newSession.chooseAgent", outcome: "handled", help: { keys: "1-9 a-z", label: "choose agent" } },
  ],
  projectDefaultAgent: [
    { id: "station.projectDefaultAgent.cancel", pattern: { kind: "named", named: "escape" }, action: "station.projectDefaultAgent.cancel", outcome: "handled", help: { keys: "esc", label: "cancel" } },
    { id: "station.projectDefaultAgent.choose", pattern: { kind: "slot" }, action: "station.projectDefaultAgent.choose", outcome: "handled", help: { keys: "1-9 a-z", label: "choose agent" } },
  ],
  // The add-project flow has internal modes (start/choose/review/success/
  // failed, with a slash filter and a name editor); this single table covers
  // the union of its key vocabulary — the flow machine decides which apply
  // in the current sub-mode, exactly as upstream.
  addProject: [
    { id: "station.addProject.cancel", pattern: { kind: "named", named: "escape" }, action: "station.addProject.key", outcome: "handled", help: { keys: "esc", label: "back/cancel" } },
    { id: "station.addProject.confirm", pattern: { kind: "named", named: "return" }, action: "station.addProject.key", outcome: "handled", help: { keys: "enter", label: "confirm" } },
    { id: "station.addProject.up", pattern: { kind: "named", named: "up" }, action: "station.addProject.key", outcome: "handled" },
    { id: "station.addProject.down", pattern: { kind: "named", named: "down" }, action: "station.addProject.key", outcome: "handled" },
    { id: "station.addProject.left", pattern: { kind: "named", named: "left" }, action: "station.addProject.key", outcome: "handled" },
    { id: "station.addProject.right", pattern: { kind: "named", named: "right" }, action: "station.addProject.key", outcome: "handled" },
    { id: "station.addProject.backspace", pattern: { kind: "named", named: "backspace" }, action: "station.addProject.key", outcome: "handled" },
    { id: "station.addProject.delete", pattern: { kind: "named", named: "delete" }, action: "station.addProject.key", outcome: "handled" },
    { id: "station.addProject.clearLine", pattern: { kind: "char", char: "u", ctrl: true }, action: "station.addProject.key", outcome: "handled" },
    { id: "station.addProject.type", pattern: { kind: "text" }, action: "station.addProject.key", outcome: "handled" },
  ],
};

/** Station's compact keyboard reference: app-level chords first, then STATION view keys. */
export const STATION_HELP_CONTENT = [
  { text: "station help", align: "center" as const },
  { text: "" },
  { key: "Ctrl-O", description: "open/close project view" },
  { key: "Ctrl-Q", description: "quit Station" },
  { key: "Ctrl-\\", description: "split pane right" },
  { key: "Ctrl-^", description: "split pane below (Ctrl-6)" },
  { key: "Ctrl-]", description: "focus next pane" },
  { key: "Ctrl-/", description: "close split pane (Ctrl-_)" },
  { key: "Enter/Sp", description: "open project view on welcome" },
  { key: "Esc/↑↓", description: "context menu close/move" },
  { key: "Enter/Sp", description: "context menu select" },
  { text: "station project view", align: "center" as const },
  { key: "↑/↓ wheel", description: "scroll project list" },
  { key: "1-9/a-z", description: "start or focus row" },
  { key: "N/A/R/C/P", description: "new/add/rename/fold/settings" },
  { key: "X", description: "delete session" },
  { key: "/, Z", description: "search / refresh snapshot" },
  { key: "H/?", description: "help" },
  { key: "Q/Esc", description: "close/back/cancel" },
] as const;

/**
 * Global bindings the transition machine handles before screen dispatch.
 * Ctrl-C in apps/tui exits the TUI with code 0; Station maps exit intent to
 * closing STATION mode (the workspace owns process exit via Ctrl-Q).
 */
export const STATION_GLOBAL_BINDINGS: readonly StationBinding[] = [
  {
    id: "station.global.exitIntent",
    pattern: { kind: "char", char: "c", ctrl: true },
    action: "station.overlay.dismiss",
    outcome: "close-overlay",
  },
];

export function isSlotKey(key: TuiKey): boolean {
  // ctrl is not excluded: choice lookup in the machine reads key.input only,
  // so Ctrl-A activates slot "a" exactly as apps/tui does under Ink (the
  // global Ctrl-C binding resolves first).
  return (
    key.return !== true && key.escape !== true && SELECTION_KEYS.includes(key.input as SelectionKey)
  );
}

function matchesPattern(pattern: StationKeyPattern, key: TuiKey): boolean {
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
      // ctrl is deliberately NOT excluded: shared text handlers receive
      // control-byte metadata too (for example Ctrl-U clears before cursor).
      // The global Ctrl-C binding resolves first, so the escape hatch survives.
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

/**
 * Resolves the binding for a key in a mode: globals first (mirroring the
 * machine's pre-screen Ctrl-C check), then the mode table in order. Specific
 * patterns are listed before the text catch-all in every table, so order is
 * the precedence rule.
 */
export function matchStationBinding(mode: StationInputMode, key: TuiKey): StationBinding | undefined {
  for (const binding of STATION_GLOBAL_BINDINGS) {
    if (matchesPattern(binding.pattern, key)) {
      return binding;
    }
  }
  for (const binding of STATION_KEYMAP[mode]) {
    if (matchesPattern(binding.pattern, key)) {
      return binding;
    }
  }
  return undefined;
}
