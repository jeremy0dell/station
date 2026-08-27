import { helpOverlayLineCount } from "../../components/HelpOverlay/content.js";
import {
  clampHelpScrollOffset,
  helpPanelBodyRows,
} from "../../components/HelpOverlay/helpPanel.js";
import type { TuiKey } from "../keys.js";
import type { TuiRuntimeContext, TuiTransition } from "../transition.js";
import type { DashboardState } from "../types.js";

export const helpScreenBehavior = {
  dashboardHoverEnabled: false,
  clickAway: closeHelp,
};

export function handleHelpKey(state: DashboardState, key: TuiKey): TuiTransition {
  if (key.input === "H" || key.input === "?" || key.input === "Q" || key.escape === true) {
    return {
      state: closeHelp(state),
    };
  }
  const delta = helpScrollDeltaForKey(key);
  if (delta !== 0) {
    return { state: scrollHelp(state, delta) };
  }
  return { state };
}

export function openHelp(state: DashboardState, context: TuiRuntimeContext): DashboardState {
  return {
    ...state,
    screen: {
      name: "help",
      scrollOffset: 0,
      contentLength: helpOverlayLineCount(context.helpKeymapLineCount ?? 0),
    },
  };
}

export function scrollHelpTo(state: DashboardState, offset: number): DashboardState {
  if (state.screen.name !== "help") {
    return state;
  }
  const scrollOffset = clampHelpScrollOffset(
    state.screen.contentLength,
    helpPanelBodyRows(state.terminalRows, state.screen.contentLength),
    offset,
  );
  if (scrollOffset === state.screen.scrollOffset) {
    return state;
  }
  return {
    ...state,
    screen: {
      name: "help",
      scrollOffset,
      contentLength: state.screen.contentLength,
    },
  };
}

function scrollHelp(state: DashboardState, delta: number): DashboardState {
  if (state.screen.name !== "help") {
    return state;
  }
  return scrollHelpTo(state, state.screen.scrollOffset + delta);
}

function closeHelp(state: DashboardState): DashboardState {
  return { ...state, screen: { name: "dashboard" } };
}

function helpScrollDeltaForKey(key: TuiKey): -1 | 0 | 1 {
  if (key.upArrow === true || key.mouseScroll === "up") {
    return -1;
  }
  if (key.downArrow === true || key.mouseScroll === "down") {
    return 1;
  }
  return 0;
}
