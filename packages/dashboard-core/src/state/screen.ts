import type { StationSnapshot } from "@station/contracts";
import { transitionAddProjectFlow } from "../flows/addProject/flow.js";
import { transitionNewSessionFlow } from "../flows/newSession.js";
import { createEmptyTuiLocalRows, pruneLocalRowsForSnapshot } from "./localRows.js";
import { reconcileAddProjectSelection } from "./selection/addProject.js";
import type {
  CreateInitialTuiStateOptions,
  TuiRuntimeState,
  TuiScreen,
  TuiState,
} from "./types.js";

export type TuiScreenClickAwayMode = "dismiss" | "passthrough";

/** Screen-level authority for attaching a click-away backdrop or preserving passthrough. */
export function tuiScreenClickAwayMode(screen: TuiScreen): TuiScreenClickAwayMode {
  switch (screen.name) {
    case "dashboard":
    case "search":
      return "passthrough";
    case "removeWorktree":
      switch (screen.step) {
        case "chooseSlot":
          return "passthrough";
        case "unavailable":
        case "confirm":
          return "dismiss";
      }
      return assertNever(screen);
    case "renameSession":
      switch (screen.step) {
        case "chooseSlot":
          return "passthrough";
        case "editName":
          return "dismiss";
      }
      return assertNever(screen);
    case "fork":
      switch (screen.step) {
        case "chooseSlot":
          return "passthrough";
        case "details":
          return "dismiss";
      }
      return assertNever(screen);
    case "addProject": {
      const flow = screen.flow;
      switch (flow.mode) {
        case "start":
        case "choose":
        case "review":
        case "success":
        case "failed":
          return "dismiss";
      }
      return assertNever(flow);
    }
    case "newSession": {
      const flow = screen.flow;
      switch (flow.mode) {
        case "review":
        case "editName":
        case "pickProject":
        case "pickAgent":
          return "dismiss";
      }
      return assertNever(flow);
    }
    case "help":
    case "projectCollapse":
    case "projectSettingsPicker":
    case "projectDefaultAgent":
    case "projectSettings":
    case "widgetSettings":
      return "dismiss";
  }
  return assertNever(screen);
}

/** Performs only safe local click-away cancellation and never emits commands or operations. */
export function dismissTuiScreenOnClickAway(state: TuiState): TuiState {
  const screen = state.screen;
  switch (screen.name) {
    case "dashboard":
    case "search":
    case "removeWorktree":
      return screen.name !== "removeWorktree" || screen.step === "chooseSlot"
        ? state
        : toDashboard(state);
    case "renameSession":
      if (screen.step === "chooseSlot") {
        return state;
      }
      return {
        ...state,
        screen:
          screen.returnTo === "dashboard"
            ? { name: "dashboard" }
            : { name: "renameSession", step: "chooseSlot" },
      };
    case "fork":
      if (screen.step === "chooseSlot") {
        return state;
      }
      return {
        ...state,
        screen:
          screen.returnTo === "dashboard"
            ? { name: "dashboard" }
            : { name: "fork", step: "chooseSlot" },
      };
    case "addProject": {
      const flow = screen.flow;
      if (flow.mode === "review" && flow.editingId !== undefined) {
        const transition = transitionAddProjectFlow(flow, { type: "editIdCancel" });
        return { ...state, screen: { name: "addProject", flow: transition.state ?? flow } };
      }
      if (flow.mode === "choose" && (flow.filterMode || flow.filter.length > 0)) {
        const transition = transitionAddProjectFlow(flow, { type: "filterClear" });
        return reconcileAddProjectSelection(
          {
            ...state,
            screen: { name: "addProject", flow: transition.state ?? flow },
          },
          flow,
          true,
        );
      }
      return toDashboard(state);
    }
    case "newSession": {
      const flow = transitionNewSessionFlow(screen.flow, { type: "cancel" });
      return flow === undefined
        ? toDashboard(state)
        : { ...state, screen: { name: "newSession", flow } };
    }
    case "widgetSettings":
      return screen.focus === "picker"
        ? { ...state, screen: { ...screen, focus: "list" } }
        : toDashboard(state);
    case "help":
    case "projectCollapse":
    case "projectSettingsPicker":
    case "projectDefaultAgent":
    case "projectSettings":
      return toDashboard(state);
  }
  return assertNever(screen);
}

export function createInitialTuiState(options: CreateInitialTuiStateOptions = {}): TuiState {
  const runtime = createRuntimeState(options.runtime);
  const state: TuiState = {
    loading: options.initialSnapshot === undefined,
    screen: { name: "dashboard" },
    toasts: [],
    observerConnectionStatus: { state: "connected" },
    searchQuery: options.searchQuery ?? "",
    collapsedProjectIds: new Set(options.collapsedProjectIds ?? []),
    scrollOffset: options.scrollOffset ?? 0,
    terminalRows: options.terminalRows ?? 24,
    localRows: options.localRows ?? createEmptyTuiLocalRows(),
    selection: new Map(),
    widgets: options.widgets ?? [],
    widgetsPersisted: options.widgetsPersisted ?? true,
    runtime,
  };
  if (options.initialSnapshot !== undefined) {
    state.snapshot = options.initialSnapshot;
  }
  if (options.focusedRowId !== undefined) {
    state.focusedRowId = options.focusedRowId;
  }
  return state;
}

export function replaceSnapshot(state: TuiState, snapshot: StationSnapshot): TuiState {
  return {
    ...state,
    snapshot,
    loading: false,
    localRows: pruneLocalRowsForSnapshot(state.localRows, snapshot),
  };
}

function createRuntimeState(runtime: Partial<TuiRuntimeState> | undefined): TuiRuntimeState {
  const built: TuiRuntimeState = {
    persistentPopup: runtime?.persistentPopup ?? false,
    canDismissPopup: runtime?.canDismissPopup ?? false,
    exitOnFocusSuccess: runtime?.exitOnFocusSuccess ?? false,
    canResolveFocusOrigin: runtime?.canResolveFocusOrigin ?? false,
    hasFocusSuccessCallback: runtime?.hasFocusSuccessCallback ?? false,
  };
  if (runtime?.focusOrigin !== undefined) {
    built.focusOrigin = runtime.focusOrigin;
  }
  return built;
}

function toDashboard(state: TuiState): TuiState {
  return { ...state, screen: { name: "dashboard" } };
}

function assertNever(_value: never): never {
  throw new Error("Unhandled TUI screen variant.");
}
