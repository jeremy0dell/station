import type { StationClientStateSource } from "@station/client";
import type { DashboardActions, DashboardStateSource } from "@station/dashboard-core";
import {
  deriveTuiInputMode,
  isRemoveProjectArmed,
  LIST_REGISTRY,
  selectDashboardViewport,
  type ProjectHeaderControl,
  type TuiInputMode,
} from "@station/dashboard-core";
import { isPrimaryMouseEvent, wheelDirection, type StationMouseEvent } from "../input/mouse.js";
import type { StationMouseTarget } from "../station/input/stationMouse.js";
import {
  executeDashboardControlIntent,
  openDashboardRowShell,
  showStaleDashboardTargetNotice,
  type DashboardRendererEffects,
} from "./dashboardEffects.js";

type DashboardMouseInput = {
  state: DashboardStateSource;
  clientState: StationClientStateSource;
  actions: Pick<
    DashboardActions,
    "createQuickSession" | "dismissToasts" | "dispatch" | "handleKey" | "pushToast"
  >;
};

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
  store: DashboardMouseInput,
  effects: DashboardRendererEffects,
): void {
  const mode = deriveTuiInputMode(store.state.getState());
  const scrollDirection = wheelDirection(event);
  if (scrollDirection !== null) {
    if (
      target.kind !== "screenBackdrop" &&
      target.kind !== "sheetBackdrop" &&
      ROW_INTERACTIVE_MODES.has(mode)
    ) {
      store.actions.dispatch({
        type: "dashboard.scroll",
        delta: scrollDirection === "up" ? -1 : 1,
      });
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
  store: DashboardMouseInput,
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
        store.actions.dispatch({ type: "dashboard.addProject" });
      }
      return true;
    case "persistentFilterAction":
      if (mode === "dashboard") {
        store.actions.dispatch({ type: target.actionId });
      }
      return true;
    case "scrollIndicator":
      pageInMode(store, target.direction, mode);
      return true;
    case "toast":
      store.actions.dismissToasts();
      return true;
    case "body":
      return true;
    default:
      return false;
  }
}

function activateRowInMode(
  store: DashboardMouseInput,
  rowId: string,
  mode: TuiInputMode,
): void {
  if (ROW_INTERACTIVE_MODES.has(mode)) {
    activateCurrentRow(store, rowId);
  }
}

function activateProjectHeaderInMode(
  store: DashboardMouseInput,
  projectId: string,
  actionId: ProjectHeaderControl,
  mode: TuiInputMode,
  effects: DashboardRendererEffects,
): void {
  if (mode !== "dashboard") {
    return;
  }
  const result = store.actions.dispatch({
    type: "dashboard.projectHeader.activate",
    projectId,
    actionId,
  });
  if (result.controlIntent !== undefined) {
    executeDashboardControlIntent(result.controlIntent, store, effects);
  }
}

function activateEmptyProjectInMode(
  store: DashboardMouseInput,
  projectId: string,
  mode: TuiInputMode,
  effects: DashboardRendererEffects,
): void {
  if (mode !== "dashboard") {
    return;
  }
  const result = store.actions.dispatch({
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
  store: DashboardMouseInput,
  rowId: string,
  mode: TuiInputMode,
  effects: DashboardRendererEffects,
): void {
  if (mode === "dashboard") {
    openDashboardRowShell(store, rowId, effects);
  }
}

function pageInMode(
  store: DashboardMouseInput,
  direction: "up" | "down",
  mode: TuiInputMode,
): void {
  if (!ROW_INTERACTIVE_MODES.has(mode)) {
    return;
  }
  store.actions.dispatch({
    type: "dashboard.scroll",
    delta: direction === "up" ? -SCROLL_PAGE_ROWS : SCROLL_PAGE_ROWS,
  });
}

function routeModalClick(
  target: StationMouseTarget,
  store: DashboardMouseInput,
  mode: TuiInputMode,
): boolean {
  if (target.kind === "sheetBackdrop") {
    return true;
  }
  if (target.kind === "screenBackdrop") {
    store.actions.dispatch({ type: "screen.clickAway" });
    return true;
  }
  switch (target.kind) {
    case "persistentFilterConditionField":
      if (mode === "persistentFilterConditionField") {
        store.actions.dispatch({
          type: "persistentFilter.condition.selectField",
          field: target.field,
        });
      }
      return true;
    case "persistentFilterConditionValue":
      if (mode === "persistentFilterConditionValues") {
        store.actions.dispatch({
          type: "persistentFilter.condition.toggleValue",
          field: target.field,
          valueId: target.valueId,
        });
      }
      return true;
    case "persistentFilterConditionAction":
      if (target.actionId === "close") {
        if (
          mode === "persistentFilterConditionField" ||
          mode === "persistentFilterConditionValues"
        ) {
          store.actions.dispatch({ type: "persistentFilter.condition.close" });
        }
        return true;
      }
      if (target.actionId === "applyFilter") {
        if (mode === "persistentFilterConditionField") {
          store.actions.dispatch({ type: "persistentFilter.applyDraft" });
        }
        return true;
      }
      if (mode === "persistentFilterConditionValues") {
        store.actions.dispatch({
          type:
            target.actionId === "back"
              ? "persistentFilter.condition.back"
              : "persistentFilter.condition.done",
        });
      }
      return true;
    case "sheetChoice":
      if (SHEET_CHOICE_MODES.has(mode)) {
        store.actions.handleKey({ input: target.choiceKey });
      }
      return true;
    case "removeWorktreeAction":
      store.actions.dispatch({
        type: "removeWorktree.activate",
        actionId: target.actionId,
      });
      return true;
    case "projectSettingsItem":
      if (mode === "projectSettings") {
        store.actions.dispatch({
          type: "projectSettings.focusItem",
          itemId: target.itemId,
        });
      }
      return true;
    case "projectSettingsConfirmRemove":
      confirmProjectRemoval(store, mode);
      return true;
    case "addProjectRow":
      if (ADD_PROJECT_ROW_MODES.has(mode)) {
        store.actions.dispatch({ type: "addProject.selectRow", index: target.index });
      }
      return true;
    case "addProjectAction":
      store.actions.dispatch({
        type: "addProject.activate",
        actionId: target.actionId,
      });
      return true;
    case "newSessionAction":
      store.actions.dispatch({
        type: "newSession.activate",
        actionId: target.actionId,
      });
      return true;
    case "forkSessionAction":
      store.actions.dispatch({
        type: "forkSession.activate",
        actionId: target.actionId,
      });
      return true;
    default:
      return false;
  }
}

function confirmProjectRemoval(store: DashboardMouseInput, mode: TuiInputMode): void {
  const screen = store.state.getState().screen;
  if (
    mode === "projectSettings" &&
    screen.name === "projectSettings" &&
    isRemoveProjectArmed(screen)
  ) {
    store.actions.handleKey({ input: "r" });
  }
}

function routeWidgetClick(
  target: StationMouseTarget,
  store: DashboardMouseInput,
  mode: TuiInputMode,
): boolean {
  switch (target.kind) {
    case "widgetSettingsOpen":
      if (mode === "dashboard") {
        store.actions.dispatch({ type: "widgetSettings.open" });
      }
      return true;
    case "widgetSettingsRow":
      if (mode === "widgetSettings") {
        store.actions.dispatch({ type: "widgetSettings.toggle", index: target.index });
      }
      return true;
    case "widgetSettingsRemove":
      if (mode === "widgetSettings") {
        store.actions.dispatch({ type: "widgetSettings.remove", index: target.index });
      }
      return true;
    case "widgetSettingsAdd":
      if (mode === "widgetSettings") {
        store.actions.dispatch({ type: "widgetSettings.openPicker" });
      }
      return true;
    case "widgetSettingsPickerChoice":
      if (mode === "widgetSettings") {
        store.actions.dispatch({ type: "widgetSettings.addFromPicker", index: target.index });
      }
      return true;
    default:
      return false;
  }
}

function activateCurrentRow(store: DashboardMouseInput, rowId: string): void {
  const state = store.state.getState();
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
  store.actions.handleKey({ input: choice.key });
}
