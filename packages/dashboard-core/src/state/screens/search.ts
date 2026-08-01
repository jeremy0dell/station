import { reconcileDashboardFocus } from "../dashboardFocus.js";
import type { TuiKey } from "../keys.js";
import { isReturnKey } from "../keys.js";
import type { TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";

export const searchScreenBehavior = {};

export function openLegacyDashboardSearch(state: TuiState): TuiTransition {
  return {
    state: {
      ...state,
      screen: { name: "search", value: "" },
    },
  };
}

export function handleLegacyDashboardSearchKey(state: TuiState, key: TuiKey): TuiTransition {
  if (state.screen.name !== "search") {
    return { state };
  }

  if (key.escape === true) {
    return {
      state: {
        ...state,
        screen: { name: "dashboard" },
      },
    };
  }

  if (key.backspace === true || key.delete === true) {
    return {
      state: {
        ...state,
        screen: {
          name: "search",
          value: state.screen.value.slice(0, -1),
        },
      },
    };
  }

  if (isReturnKey(key)) {
    const next: TuiState = {
      ...state,
      searchQuery: state.screen.value,
      scrollOffset: 0,
      screen: { name: "dashboard" },
    };
    return { state: reconcileDashboardFocus(state, next) };
  }

  if (key.input.length === 0) {
    return { state };
  }

  return {
    state: {
      ...state,
      screen: {
        name: "search",
        value: `${state.screen.value}${key.input}`,
      },
    },
  };
}
