import type { StationCommand } from "@station/contracts";
import type { TuiKey } from "./keys.js";
import type { TuiOperation } from "./operations/types.js";
import { handleAddProjectKey } from "./screens/addProjectScreen.js";
import { handleDashboardKey } from "./screens/dashboard.js";
import { handleForkKey } from "./screens/fork.js";
import { handleHelpKey } from "./screens/help.js";
import { handleNewSessionKey } from "./screens/newSession.js";
import { handleProjectCollapseKey } from "./screens/projectCollapse.js";
import { handleProjectDefaultAgentKey } from "./screens/projectDefaultAgent.js";
import { handleRemoveWorktreeKey } from "./screens/removeWorktree.js";
import { handleRenameSessionKey } from "./screens/renameSession.js";
import { handleSearchKey } from "./screens/search.js";
import type { TuiState } from "./types.js";

export type TuiTransition = {
  state: TuiState;
  commands?: StationCommand[];
  operations?: TuiOperation[];
  reconcileReason?: string;
  exitCode?: number;
  dismissPopup?: true;
};

export type TuiKeyRuntimeContext = {
  cwd: string;
  homeDir: string;
};

export function handleTuiKey(
  state: TuiState,
  key: TuiKey,
  context: TuiKeyRuntimeContext = { cwd: process.cwd(), homeDir: process.env.HOME ?? "" },
): TuiTransition {
  if (key.ctrl === true && key.input === "c") {
    return {
      state,
      exitCode: 0,
    };
  }

  switch (state.screen.name) {
    case "dashboard":
      return handleDashboardKey(state, key, context);
    case "help":
      return handleHelpKey(state, key);
    case "search":
      return handleSearchKey(state, key);
    case "projectCollapse":
      return handleProjectCollapseKey(state, key);
    case "removeWorktree":
      return handleRemoveWorktreeKey(state, key);
    case "renameSession":
      return handleRenameSessionKey(state, key);
    case "fork":
      return handleForkKey(state, key);
    case "newSession":
      return handleNewSessionKey(state, key);
    case "projectDefaultAgent":
      return handleProjectDefaultAgentKey(state, key);
    case "addProject":
      return handleAddProjectKey(state, key);
  }
}
