import type { TuiKey } from "../keys.js";
import { isReturnKey } from "../keys.js";
import type { TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";
import { removeSessionCommandForCurrentScreen } from "./sessionRows.js";

export function handleRemoveSessionKey(state: TuiState, key: TuiKey): TuiTransition {
  if (state.screen.name !== "removeSession") {
    return { state };
  }

  const input = key.input.toLowerCase();

  if (input === "n" || key.escape === true || isReturnKey(key)) {
    return {
      state: {
        ...state,
        screen: { name: "dashboard" },
      },
    };
  }

  if (input !== "y") {
    return { state };
  }

  const command = removeSessionCommandForCurrentScreen(state);
  if (command === undefined) {
    return {
      state: {
        ...state,
        screen: { name: "dashboard" },
      },
    };
  }

  return {
    state: {
      ...state,
      screen: { name: "dashboard" },
    },
    commands: [command],
  };
}
