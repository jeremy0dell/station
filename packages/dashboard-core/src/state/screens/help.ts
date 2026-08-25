import {
  adjacentHelpEntryId,
  endpointHelpEntryId,
  type HelpEntryOrderSource,
} from "../helpEntries.js";
import type { TuiKey } from "../keys.js";
import type { TuiTransition } from "../transition.js";
import type { DashboardState } from "../types.js";

export const helpScreenBehavior = {
  dashboardHoverEnabled: false,
  clickAway: closeHelp,
};

export function handleHelpKey(
  state: DashboardState,
  key: TuiKey,
  entries?: HelpEntryOrderSource,
): TuiTransition {
  if (key.input === "H" || key.input === "?" || key.input === "Q" || key.escape === true) {
    return {
      state: closeHelp(state),
    };
  }
  if (key.downArrow === true || key.upArrow === true) {
    return withFocusedEntry(
      state,
      adjacentHelpEntryId(
        entries,
        state.screen.name === "help" ? state.screen.focusedEntryId : undefined,
        key.upArrow === true ? -1 : 1,
      ),
    );
  }
  if (key.pageUp === true || key.pageDown === true) {
    return withFocusedEntry(
      state,
      endpointHelpEntryId(entries, key.pageUp === true ? "first" : "last"),
    );
  }
  return { state };
}

function withFocusedEntry(
  state: DashboardState,
  focusedEntryId: string | undefined,
): TuiTransition {
  return {
    state: {
      ...state,
      screen: {
        name: "help",
        ...(focusedEntryId === undefined ? {} : { focusedEntryId }),
      },
    },
  };
}

function closeHelp(state: DashboardState): DashboardState {
  return { ...state, screen: { name: "dashboard" } };
}
