import {
  MAIN_PANE_ID,
  type FocusTarget,
  type PaneId,
  type StationState,
  type WorkspaceSlice,
} from "./types.js";

export type StationStoreOptions = {
  initialPaneId?: PaneId;
  /**
   * Default keeps existing tests/helpers on the historical single shell pane.
   * Runtime main.tsx opts into "empty" so Station opens on the welcome screen
   * without allocating a PTY until a dashboard action creates a pane.
   */
  boot?: "main-pane" | "empty";
  /**
   * Cold-boot restored panes. Primary-agent identity is absent until host
   * reattach re-derives it; session/target ids from disk are not trusted. An
   * empty restored workspace stays empty.
   */
  initialWorkspace?: WorkspaceSlice;
  /**
   * Show the welcome screen as a boot intro over the (possibly restored)
   * workspace. Defaults off so tests/helpers boot straight into their pane;
   * runtime main.tsx passes the `welcome_on_boot` config value.
   */
  welcomeIntroOnBoot?: boolean;
};

function singleShellState(paneId: PaneId): StationState {
  return workspaceState({
    panes: [{ id: paneId, split: null, role: "shell" }],
    activePaneId: paneId,
  });
}

function workspaceState(workspace: WorkspaceSlice): StationState {
  const focus: FocusTarget =
    workspace.activePaneId !== null
      ? { kind: "pane", paneId: workspace.activePaneId }
      : { kind: "header", region: "title" };
  return {
    workspace,
    input: {
      focus,
      introVisible: false,
      activeOverlay: null,
      overlayReturnFocus: null,
      dialogStack: [],
      contextMenu: null,
    },
    feedback: { toast: null },
  };
}

function emptyInitialState(): StationState {
  return {
    workspace: {
      panes: [],
      activePaneId: null,
    },
    input: {
      focus: { kind: "welcome" },
      introVisible: false,
      activeOverlay: null,
      overlayReturnFocus: null,
      dialogStack: [],
      contextMenu: null,
    },
    feedback: { toast: null },
  };
}

export function resolveInitialState(options?: StationStoreOptions): StationState {
  const restored = options?.initialWorkspace;
  let base: StationState;
  if (restored !== undefined) {
    base = restored.panes.length > 0 ? workspaceState(restored) : emptyInitialState();
  } else if (options?.boot === "empty") {
    base = emptyInitialState();
  } else {
    base = singleShellState(options?.initialPaneId ?? MAIN_PANE_ID);
  }
  if (options?.welcomeIntroOnBoot !== true) {
    return base;
  }
  // The intro covers the workspace on boot: focus the welcome layer (not a pane)
  // so keys hit the intro and the restored session underneath stays untouched
  // until dismissed.
  return {
    ...base,
    input: { ...base.input, introVisible: true, focus: { kind: "welcome" } },
  };
}
