import type { TuiStore } from "@station/dashboard-core";
import {
  deriveTuiInputMode,
  focusProjectSettingsItem,
  isRemoveProjectArmed,
  LIST_REGISTRY,
  openWidgetSettings,
  scrollDashboard,
  selectAddProjectRow,
  selectDashboardViewport,
  tuiScreenBehavior,
  widgetSettingsAddFromPicker,
  widgetSettingsOpenPicker,
  widgetSettingsRemoveAt,
  widgetSettingsToggleAt,
  type ProjectHeaderControl,
  type TuiInputMode,
} from "@station/dashboard-core";
import type { StoreApi } from "zustand/vanilla";
import { isPrimaryMouseEvent, wheelDirection, type StationMouseEvent } from "../input/mouse.js";
import type { StationMouseTarget } from "../station/input/stationMouse.js";
import {
  executeDashboardControlIntent,
  openDashboardRowShell,
  showStaleDashboardTargetNotice,
  type DashboardRendererEffects,
} from "./dashboardEffects.js";

const ROW_INTERACTIVE_MODES: ReadonlySet<TuiInputMode> = new Set([
  "dashboard",
  "removeChooseSlot",
  "renameChooseSlot",
  "forkChooseSlot",
]);
const SHEET_CHOICE_MODES: ReadonlySet<string> = new Set(Object.keys(LIST_REGISTRY));
const ADD_PROJECT_ROW_MODES: ReadonlySet<TuiInputMode> = new Set([
  "addProjectStart",
  "addProjectChoose",
  "addProjectFilter",
]);
const SCROLL_PAGE_ROWS = 5;

/** Translates standalone semantic targets into shared dashboard actions and renderer effects. */
export function routeDashboardMouse(
  target: StationMouseTarget,
  event: StationMouseEvent,
  store: StoreApi<TuiStore>,
  effects: DashboardRendererEffects,
): void {
  const mode = deriveTuiInputMode(store.getState());
  const scrollDirection = wheelDirection(event);
  if (scrollDirection !== null) {
    if (
      target.kind !== "screenBackdrop" &&
      target.kind !== "sheetBackdrop" &&
      ROW_INTERACTIVE_MODES.has(mode)
    ) {
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
  effects: DashboardRendererEffects,
): boolean {
  switch (target.kind) {
    case "row":
      activateRowInMode(store, target.rowId, mode);
      return true;
    case "projectHeader":
      activateProjectHeaderInMode(store, target.projectId, "primary", mode, effects);
      return true;
    case "link":
      openLinkInMode(target.url, mode, effects);
      return true;
    case "openShellForRow":
      openRowShellInMode(store, target.rowId, mode, effects);
      return true;
    case "openShellForProject":
      activateProjectHeaderInMode(store, target.projectId, "shell", mode, effects);
      return true;
    case "quickSessionForProject":
      activateProjectHeaderInMode(store, target.projectId, "quickSession", mode, effects);
      return true;
    case "emptyProjectAction":
      activateEmptyProjectInMode(store, target.projectId, mode, effects);
      return true;
    case "showDefaultAgentPickerForProject":
      activateProjectHeaderInMode(store, target.projectId, "defaultAgent", mode, effects);
      return true;
    case "firstProjectAdd":
      if (mode === "dashboard") {
        store.getState().handleAction({ type: "dashboard.addProject" });
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

function activateRowInMode(store: StoreApi<TuiStore>, rowId: string, mode: TuiInputMode): void {
  if (ROW_INTERACTIVE_MODES.has(mode)) {
    activateCurrentRow(store, rowId);
  }
}

function activateProjectHeaderInMode(
  store: StoreApi<TuiStore>,
  projectId: string,
  actionId: ProjectHeaderControl,
  mode: TuiInputMode,
  effects: DashboardRendererEffects,
): void {
  if (mode !== "dashboard") {
    return;
  }
  const result = store.getState().handleAction({
    type: "dashboard.projectHeader.activate",
    projectId,
    actionId,
  });
  if (result.controlIntent !== undefined) {
    executeDashboardControlIntent(result.controlIntent, store, effects);
  }
}

function activateEmptyProjectInMode(
  store: StoreApi<TuiStore>,
  projectId: string,
  mode: TuiInputMode,
  effects: DashboardRendererEffects,
): void {
  if (mode !== "dashboard") {
    return;
  }
  const result = store.getState().handleAction({
    type: "dashboard.emptyProject.activate",
    projectId,
  });
  if (result.controlIntent !== undefined) {
    executeDashboardControlIntent(result.controlIntent, store, effects);
  }
}

function openLinkInMode(url: string, mode: TuiInputMode, effects: DashboardRendererEffects): void {
  if (mode === "dashboard") {
    effects.openUrl(url);
  }
}

function openRowShellInMode(
  store: StoreApi<TuiStore>,
  rowId: string,
  mode: TuiInputMode,
  effects: DashboardRendererEffects,
): void {
  if (mode === "dashboard") {
    openDashboardRowShell(store, rowId, effects);
  }
}

function pageInMode(store: StoreApi<TuiStore>, direction: "up" | "down", mode: TuiInputMode): void {
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
  if (target.kind === "screenBackdrop") {
    const state = store.getState();
    const clickAway = tuiScreenBehavior(state.screen).clickAway;
    if (clickAway !== undefined) {
      store.setState(clickAway(state));
    }
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
      if (ADD_PROJECT_ROW_MODES.has(mode)) {
        store.setState(selectAddProjectRow(store.getState(), target.index));
      }
      return true;
    case "addProjectAction":
      store.getState().handleAction({
        type: "addProject.activate",
        actionId: target.actionId,
      });
      return true;
    case "newSessionAction":
      store.getState().handleAction({
        type: "newSession.activate",
        actionId: target.actionId,
      });
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
    showStaleDashboardTargetNotice(store);
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
    showStaleDashboardTargetNotice(store);
    return;
  }
  store.getState().handleKey({ input: choice.key });
}
