import {
  DASHBOARD_SHORTCUT_MAX_CODE_LENGTH,
  dashboardShortcutInputChunk,
} from "../selectors/dashboardShortcuts.js";
import { isReturnKey, type TuiKey } from "./keys.js";
import type { DashboardScreenView, DashboardState } from "./types.js";

export type ShortcutInputKeyResult =
  | { kind: "unhandled" }
  | { kind: "handled"; state: DashboardState }
  | { kind: "submit"; state: DashboardState; code: string };

/** Returns the active command/shortcut prefix, distinguishing an armed empty prefix from absence. */
export function shortcutCodeInputForScreen(screen: DashboardScreenView): string | undefined {
  switch (screen.name) {
    case "dashboard":
      return screen.shortcutCodeInput;
    case "removeWorktree":
    case "renameSession":
    case "moveToGroup":
    case "fork":
      return screen.step === "chooseSlot" ? screen.shortcutCodeInput : undefined;
    default:
      return undefined;
  }
}

/** Arms shortcut input only on the dashboard or a choose-session command screen. */
export function armShortcutCodeInput(state: DashboardState): DashboardState {
  return setShortcutCodeInput(state, "");
}

/** Clears an armed session-jump prefix without changing the surrounding command screen. */
export function clearShortcutCodeInput(state: DashboardState): DashboardState {
  switch (state.screen.name) {
    case "dashboard":
      return { ...state, screen: { name: "dashboard" } };
    case "removeWorktree":
      return state.screen.step === "chooseSlot"
        ? { ...state, screen: { name: "removeWorktree", step: "chooseSlot" } }
        : state;
    case "renameSession":
      return state.screen.step === "chooseSlot"
        ? { ...state, screen: { name: "renameSession", step: "chooseSlot" } }
        : state;
    case "moveToGroup":
      return state.screen.step === "chooseSlot"
        ? { ...state, screen: { name: "moveToGroup", step: "chooseSlot" } }
        : state;
    case "fork":
      return state.screen.step === "chooseSlot"
        ? { ...state, screen: { name: "fork", step: "chooseSlot" } }
        : state;
    default:
      return state;
  }
}

/** Collects, edits, cancels, or submits one timeout-free command/shortcut prefix. */
export function handleShortcutCodeInputKey(
  state: DashboardState,
  key: TuiKey,
  options: { armOnBacktick: boolean },
): ShortcutInputKeyResult {
  const input = shortcutCodeInputForScreen(state.screen);
  if (input === undefined) {
    return options.armOnBacktick && key.input === "`"
      ? { kind: "handled", state: armShortcutCodeInput(state) }
      : { kind: "unhandled" };
  }
  if (key.escape === true || key.input === "`") {
    return { kind: "handled", state: clearShortcutCodeInput(state) };
  }
  if (key.backspace === true) {
    return { kind: "handled", state: setShortcutCodeInput(state, input.slice(0, -1)) };
  }
  if (isReturnKey(key)) {
    const cleared = clearShortcutCodeInput(state);
    return input.length === 0
      ? { kind: "handled", state: cleared }
      : { kind: "submit", state: cleared, code: input };
  }
  if (key.ctrl === true) {
    return { kind: "handled", state };
  }
  const chunk = dashboardShortcutInputChunk(key.input);
  const maxLength = DASHBOARD_SHORTCUT_MAX_CODE_LENGTH;
  if (chunk === undefined || input.length >= maxLength) {
    return { kind: "handled", state };
  }
  const remaining = maxLength - input.length;
  return {
    kind: "handled",
    state: setShortcutCodeInput(state, `${input}${chunk.slice(0, remaining)}`),
  };
}

function setShortcutCodeInput(state: DashboardState, shortcutCodeInput: string): DashboardState {
  switch (state.screen.name) {
    case "dashboard":
      return { ...state, screen: { name: "dashboard", shortcutCodeInput } };
    case "removeWorktree":
      return state.screen.step === "chooseSlot"
        ? {
            ...state,
            screen: { name: "removeWorktree", step: "chooseSlot", shortcutCodeInput },
          }
        : state;
    case "renameSession":
      return state.screen.step === "chooseSlot"
        ? {
            ...state,
            screen: { name: "renameSession", step: "chooseSlot", shortcutCodeInput },
          }
        : state;
    case "moveToGroup":
      return state.screen.step === "chooseSlot"
        ? {
            ...state,
            screen: { name: "moveToGroup", step: "chooseSlot", shortcutCodeInput },
          }
        : state;
    case "fork":
      return state.screen.step === "chooseSlot"
        ? { ...state, screen: { name: "fork", step: "chooseSlot", shortcutCodeInput } }
        : state;
    default:
      return state;
  }
}
