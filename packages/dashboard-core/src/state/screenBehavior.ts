import { addProjectScreenBehavior } from "./screens/addProjectScreen.js";
import { dashboardScreenBehavior } from "./screens/dashboard.js";
import { forkScreenBehavior } from "./screens/fork.js";
import { helpScreenBehavior } from "./screens/help.js";
import { newSessionScreenBehavior } from "./screens/newSession.js";
import { projectCollapseScreenBehavior } from "./screens/projectCollapse.js";
import { projectDefaultAgentScreenBehavior } from "./screens/projectDefaultAgent.js";
import { projectSettingsScreenBehavior } from "./screens/projectSettings.js";
import { projectSettingsPickerScreenBehavior } from "./screens/projectSettingsPicker.js";
import { removeWorktreeScreenBehavior } from "./screens/removeWorktree.js";
import { renameSessionScreenBehavior } from "./screens/renameSession.js";
import { searchScreenBehavior } from "./screens/search.js";
import { widgetSettingsScreenBehavior } from "./screens/widgetSettings.js";
import type { TuiScreen, TuiState } from "./types.js";

/**
 * Cross-screen behavior consumed uniformly by shared dashboard composition and input routing;
 * workflow-specific behavior remains in the owning screen modules.
 */
export type TuiScreenBehavior = {
  /** Performs safe local cancellation and returns only state, never commands or operations. */
  readonly clickAway?: (state: TuiState) => TuiState;
};

/** Exhaustively resolves shared behavior so every future screen makes an explicit decision. */
export function tuiScreenBehavior(screen: TuiScreen): TuiScreenBehavior {
  switch (screen.name) {
    case "dashboard":
      return dashboardScreenBehavior;
    case "help":
      return helpScreenBehavior;
    case "search":
      return searchScreenBehavior;
    case "projectCollapse":
      return projectCollapseScreenBehavior;
    case "projectSettingsPicker":
      return projectSettingsPickerScreenBehavior;
    case "removeWorktree":
      return removeWorktreeScreenBehavior(screen);
    case "renameSession":
      return renameSessionScreenBehavior(screen);
    case "fork":
      return forkScreenBehavior(screen);
    case "addProject":
      return addProjectScreenBehavior;
    case "newSession":
      return newSessionScreenBehavior;
    case "projectDefaultAgent":
      return projectDefaultAgentScreenBehavior;
    case "projectSettings":
      return projectSettingsScreenBehavior;
    case "widgetSettings":
      return widgetSettingsScreenBehavior;
  }
  return assertNever(screen);
}

function assertNever(_value: never): never {
  throw new Error("Unhandled TUI screen variant.");
}
