import type { TuiStore } from "@station/dashboard-core";
import {
  clampDashboardStateScroll,
  deriveTuiInputMode,
  focusProjectSettingsItem,
  isRemoveProjectArmed,
  LIST_REGISTRY,
  openProjectDefaultAgentPicker,
  openWidgetSettings,
  scrollDashboard,
  selectAddProjectRow,
  selectDashboardSessionRow,
  selectDashboardViewport,
  widgetSettingsAddFromPicker,
  widgetSettingsOpenPicker,
  widgetSettingsRemoveAt,
  widgetSettingsToggleAt,
  type TuiInputMode,
} from "@station/dashboard-core";
import type { StoreApi } from "zustand/vanilla";
import {
  isPrimaryMouseEvent,
  wheelDirection,
  type StationMouseEvent,
} from "../input/mouse.js";
import type { StationMouseTarget } from "../station/input/stationMouse.js";

export type DashboardMouseEffects = {
  openShell(target: { cwd: string }): void;
  openUrl(url: string): void;
};

const ROW_INTERACTIVE_MODES: ReadonlySet<TuiInputMode> = new Set([
  "dashboard",
  "removeChooseSlot",
  "renameChooseSlot",
  "forkChooseSlot",
]);
const SHEET_CHOICE_MODES: ReadonlySet<string> = new Set(Object.keys(LIST_REGISTRY));
const SCROLL_PAGE_ROWS = 5;
const STALE_TARGET_MESSAGE = "That dashboard item is no longer available.";

/** Translates standalone semantic targets into shared dashboard actions and renderer effects. */
export function routeDashboardMouse(
  target: StationMouseTarget,
  event: StationMouseEvent,
  store: StoreApi<TuiStore>,
  effects: DashboardMouseEffects,
): void {
  const mode = deriveTuiInputMode(store.getState());
  const scrollDirection = wheelDirection(event);
  if (scrollDirection !== null) {
    if (target.kind !== "sheetBackdrop" && ROW_INTERACTIVE_MODES.has(mode)) {
      store.getState().handleKey({ input: "", mouseScroll: scrollDirection });
    }
    return;
  }
  if (!isPrimaryMouseEvent(event)) {
    return;
  }

  if (routeSurfaceClick(target, store, mode, effects)) {
    return;
  }
  if (routeModalClick(target, store, mode)) {
    return;
  }
  routeWidgetClick(target, store, mode);
}

function routeSurfaceClick(
  target: StationMouseTarget,
  store: StoreApi<TuiStore>,
  mode: TuiInputMode,
  effects: DashboardMouseEffects,
): boolean {
  switch (target.kind) {
    case "row":
      activateRowInMode(store, target.rowId, mode);
      return true;
    case "projectHeader":
      toggleProjectInMode(store, target.projectId, mode);
      return true;
    case "link":
      openLinkInMode(target.url, mode, effects);
      return true;
    case "openShellForRow":
      openRowShellInMode(store, target.rowId, mode, effects);
      return true;
    case "openShellForProject":
      openProjectShellInMode(store, target.projectId, mode, effects);
      return true;
    case "quickSessionForProject":
      if (mode === "dashboard") {
        store.getState().createQuickSession(target.projectId);
      }
      return true;
    case "showDefaultAgentPickerForProject":
      if (mode === "dashboard") {
        store.setState(openProjectDefaultAgentPicker(store.getState(), target.projectId));
      }
      return true;
    case "scrollIndicator":
      pageInMode(store, target.direction, mode);
      return true;
    case "toast":
      store.getState().dismissToasts();
      return true;
    case "body":
      return true;
    default:
      return false;
  }
}

function activateRowInMode(
  store: StoreApi<TuiStore>,
  rowId: string,
  mode: TuiInputMode,
): void {
  if (ROW_INTERACTIVE_MODES.has(mode)) {
    activateCurrentRow(store, rowId);
  }
}

function toggleProjectInMode(
  store: StoreApi<TuiStore>,
  projectId: string,
  mode: TuiInputMode,
): void {
  if (mode === "dashboard") {
    toggleCurrentProject(store, projectId);
  }
}

function openLinkInMode(
  url: string,
  mode: TuiInputMode,
  effects: DashboardMouseEffects,
): void {
  if (mode === "dashboard") {
    effects.openUrl(url);
  }
}

function openRowShellInMode(
  store: StoreApi<TuiStore>,
  rowId: string,
  mode: TuiInputMode,
  effects: DashboardMouseEffects,
): void {
  if (mode !== "dashboard") return;
  const snapshot = store.getState().snapshot;
  if (snapshot === undefined) return;
  const sessionRow = selectDashboardSessionRow(snapshot, rowId);
  if (sessionRow === undefined) {
    showNotice(store, STALE_TARGET_MESSAGE);
    return;
  }
  effects.openShell({ cwd: sessionRow.worktree.path });
}

function openProjectShellInMode(
  store: StoreApi<TuiStore>,
  projectId: string,
  mode: TuiInputMode,
  effects: DashboardMouseEffects,
): void {
  if (mode !== "dashboard") return;
  const project = store.getState().snapshot?.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) {
    showNotice(store, STALE_TARGET_MESSAGE);
    return;
  }
  effects.openShell({ cwd: project.root });
}

function pageInMode(
  store: StoreApi<TuiStore>,
  direction: "up" | "down",
  mode: TuiInputMode,
): void {
  if (!ROW_INTERACTIVE_MODES.has(mode)) {
    return;
  }
  store.setState(
    scrollDashboard(store.getState(), direction === "up" ? -SCROLL_PAGE_ROWS : SCROLL_PAGE_ROWS),
  );
}

function routeModalClick(
  target: StationMouseTarget,
  store: StoreApi<TuiStore>,
  mode: TuiInputMode,
): boolean {
  if (target.kind === "sheetBackdrop") {
    return true;
  }
  switch (target.kind) {
    case "sheetChoice":
      if (SHEET_CHOICE_MODES.has(mode)) {
        store.getState().handleKey({ input: target.choiceKey });
      }
      return true;
    case "sheetButton":
      if (mode === "removeConfirm") {
        store.getState().handleKey({ input: target.key });
      }
      return true;
    case "projectSettingsItem":
      if (mode === "projectSettings") {
        store.setState(focusProjectSettingsItem(store.getState(), target.itemId));
      }
      return true;
    case "projectSettingsConfirmRemove":
      confirmProjectRemoval(store, mode);
      return true;
    case "addProjectRow":
      if (mode === "addProject") {
        store.setState(selectAddProjectRow(store.getState(), target.index));
      }
      return true;
    case "sheetSubmit":
      if (mode === "forkDetails") {
        store.getState().handleKey({ input: "\r", return: true });
      }
      return true;
    default:
      return false;
  }
}

function confirmProjectRemoval(store: StoreApi<TuiStore>, mode: TuiInputMode): void {
  const screen = store.getState().screen;
  if (
    mode === "projectSettings" &&
    screen.name === "projectSettings" &&
    isRemoveProjectArmed(screen)
  ) {
    store.getState().handleKey({ input: "r" });
  }
}

function routeWidgetClick(
  target: StationMouseTarget,
  store: StoreApi<TuiStore>,
  mode: TuiInputMode,
): boolean {
  switch (target.kind) {
    case "widgetSettingsOpen":
      if (mode === "dashboard") {
        store.setState(openWidgetSettings(store.getState()));
      }
      return true;
    case "widgetSettingsRow":
      if (mode === "widgetSettings") {
        store.setState(widgetSettingsToggleAt(store.getState(), target.index));
      }
      return true;
    case "widgetSettingsRemove":
      if (mode === "widgetSettings") {
        store.setState(widgetSettingsRemoveAt(store.getState(), target.index));
      }
      return true;
    case "widgetSettingsAdd":
      if (mode === "widgetSettings") {
        store.setState(widgetSettingsOpenPicker(store.getState()));
      }
      return true;
    case "widgetSettingsPickerChoice":
      if (mode === "widgetSettings") {
        store.setState(widgetSettingsAddFromPicker(store.getState(), target.index));
      }
      return true;
    default:
      return false;
  }
}

function activateCurrentRow(store: StoreApi<TuiStore>, rowId: string): void {
  const state = store.getState();
  if (state.snapshot === undefined) {
    showNotice(store, STALE_TARGET_MESSAGE);
    return;
  }
  const viewport = selectDashboardViewport(state.snapshot, state);
  const item = viewport.visibleItems.find(
    (candidate) => candidate.type === "session" && candidate.row.id === rowId,
  );
  if (
    item?.type === "session" &&
    (item.pendingRemove !== undefined || item.pendingStart !== undefined)
  ) {
    return;
  }
  const choice = viewport.rowChoices.find((candidate) => candidate.value.id === rowId);
  if (choice === undefined) {
    showNotice(store, STALE_TARGET_MESSAGE);
    return;
  }
  store.getState().handleKey({ input: choice.key });
}

function toggleCurrentProject(store: StoreApi<TuiStore>, projectId: string): void {
  const state = store.getState();
  if (state.snapshot?.projects.some((project) => project.id === projectId) !== true) {
    showNotice(store, STALE_TARGET_MESSAGE);
    return;
  }
  // Validate the exact id before mutating, then reuse shared clamping after the item count changes.
  const collapsedProjectIds = new Set(state.collapsedProjectIds);
  const wasCollapsed = collapsedProjectIds.delete(projectId);
  if (!wasCollapsed) {
    collapsedProjectIds.add(projectId);
  }
  store.setState(clampDashboardStateScroll({ ...state, collapsedProjectIds }));
}

function showNotice(store: StoreApi<TuiStore>, message: string): void {
  store.getState().pushToast({ kind: "info", message });
}
