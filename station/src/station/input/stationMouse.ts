import type { SessionId } from "@station/contracts";
import type { DashboardActions, DashboardStateSource } from "@station/dashboard-core/runtime";
import type {
  CreateGroupActionId,
  DashboardCellId,
  DashboardRowId,
} from "@station/dashboard-core/selectors";
import { deriveTuiInputMode, isRemoveProjectArmed, LIST_REGISTRY } from "@station/dashboard-core/state";
import type {
  AddProjectActionId,
  DashboardFilterConditionField,
  ForkSessionActionId,
  FreshStartActionId,
  GroupMenuActionId,
  GroupSettingsDetailFocus,
  GroupSettingsSection,
  NewSessionActionId,
  PersistentFilterActionId,
  ProjectSettingsItemId,
  ProjectMenuInputActionId,
  RemoveWorktreeActionId,
  TuiInputMode,
 } from "@station/dashboard-core/state";
import type { StationMouseEvent } from "../../input/mouse.js";
import {
  dismissStationToasts,
  dispatchRowSlot,
  dispatchStationAction,
} from "./stationActions.js";
import type { DashboardScrollController } from "../view/layout/scrollViewport.js";

/** Read/action surface required by the pointer router shared by both Station renderers. */
export type DashboardMouseRuntime = {
  state: DashboardStateSource;
  actions: Pick<DashboardActions, "dismissToasts" | "dispatch" | "handleKey">;
  layout: DashboardScrollController;
};

export type StationMouseTarget =
  | { kind: "dashboardCell"; rowId: DashboardRowId; cellId: DashboardCellId }
  | { kind: "link"; url: string }
  | { kind: "openShellForRow"; rowId: string }
  | { kind: "firstProjectAdd" }
  | { kind: "persistentFilterAction"; actionId: PersistentFilterActionId }
  | { kind: "persistentFilterConditionField"; field: DashboardFilterConditionField }
  | {
      kind: "persistentFilterConditionValue";
      field: DashboardFilterConditionField;
      valueId: string;
    }
  | {
      kind: "persistentFilterConditionAction";
      actionId: "back" | "close" | "done" | "applyFilter";
    }
  | { kind: "body" }
  | { kind: "scrollIndicator"; direction: "up" | "down" }
  | { kind: "toast" }
  | { kind: "sheetListItem"; itemId: string }
  | { kind: "removeWorktreeAction"; actionId: RemoveWorktreeActionId }
  | { kind: "freshStartAction"; actionId: FreshStartActionId }
  | { kind: "projectSettingsItem"; itemId: ProjectSettingsItemId }
  | { kind: "projectSettingsConfirmRemove" }
  | { kind: "groupSettingsSection"; section: GroupSettingsSection }
  | { kind: "groupSettingsControl"; control: GroupSettingsDetailFocus }
  | { kind: "groupSettingsSession"; sessionId: SessionId }
  | { kind: "groupSettingsAction"; actionId: "save" | "back" }
  | { kind: "widgetSettingsOpen" }
  | { kind: "widgetSettingsRow"; index: number }
  | { kind: "widgetSettingsRemove"; index: number }
  | { kind: "widgetSettingsAdd" }
  | { kind: "widgetSettingsPickerChoice"; index: number }
  | { kind: "addProjectRow"; itemId: string }
  | { kind: "addProjectAction"; actionId: AddProjectActionId }
  | { kind: "newSessionAction"; actionId: NewSessionActionId }
  | { kind: "projectMenuAction"; actionId: ProjectMenuInputActionId }
  | { kind: "groupMenuAction"; actionId: GroupMenuActionId }
  | { kind: "createGroupAction"; actionId: CreateGroupActionId }
  | { kind: "moveToGroupCreateSubmit" }
  | { kind: "renameSessionSubmit" }
  | { kind: "forkSessionAction"; actionId: ForkSessionActionId }
  | { kind: "screenBackdrop" }
  | { kind: "sheetBackdrop" };

export type StationMouseEventKind = "down" | "scroll-up" | "scroll-down";
export type StationMouseOutcome = { kind: "handled" } | { kind: "open-url"; url: string };

const ROW_INTERACTIVE_MODES: ReadonlySet<TuiInputMode> = new Set([
  "dashboard",
  "removeChooseSlot",
  "renameChooseSlot",
  "forkChooseSlot",
]);
const ADD_PROJECT_ROW_MODES: ReadonlySet<TuiInputMode> = new Set([
  "addProjectStart",
  "addProjectChoose",
  "addProjectFilter",
]);
const SHEET_CHOICE_MODES: ReadonlySet<TuiInputMode> = new Set(
  Object.keys(LIST_REGISTRY) as TuiInputMode[],
);

/** Dispatch dashboard pointer targets through the same semantic actions as keyboard input. */
export function routeStationMouse(
  target: StationMouseTarget,
  event: StationMouseEvent,
  runtime: DashboardMouseRuntime,
): StationMouseOutcome {
  const eventKind = stationMouseEventKind(event);
  if (eventKind === undefined) {
    return { kind: "handled" };
  }
  const mode = deriveTuiInputMode(runtime.state.getState());
  if (eventKind !== "down") {
    routeStationWheel(target, eventKind, runtime, mode);
    return { kind: "handled" };
  }

  switch (target.kind) {
    case "dashboardCell":
      if (ROW_INTERACTIVE_MODES.has(mode)) {
        if (mode === "dashboard") {
          runtime.actions.dispatch({
            type: "dashboard.cell.activate",
            rowId: target.rowId,
            cellId: target.cellId,
          });
        } else if (target.cellId === "identity") {
          dispatchRowSlot(runtime, target.rowId);
        }
      }
      return { kind: "handled" };
    case "link":
      return mode === "dashboard" ? { kind: "open-url", url: target.url } : { kind: "handled" };
    case "openShellForRow":
      if (mode === "dashboard") {
        runtime.actions.dispatch({ type: "dashboard.rowShell.open", rowId: target.rowId });
      }
      return { kind: "handled" };
    case "firstProjectAdd":
      if (mode === "dashboard") runtime.actions.dispatch({ type: "dashboard.addProject" });
      return { kind: "handled" };
    case "persistentFilterAction":
      if (mode === "dashboard") runtime.actions.dispatch({ type: target.actionId });
      return { kind: "handled" };
    case "persistentFilterConditionField":
      if (mode === "persistentFilterConditionField") {
        runtime.actions.dispatch({
          type: "persistentFilter.condition.selectField",
          field: target.field,
        });
      }
      return { kind: "handled" };
    case "persistentFilterConditionValue":
      if (mode === "persistentFilterConditionValues") {
        runtime.actions.dispatch({
          type: "persistentFilter.condition.toggleValue",
          field: target.field,
          valueId: target.valueId,
        });
      }
      return { kind: "handled" };
    case "persistentFilterConditionAction":
      routePersistentFilterConditionAction(runtime, mode, target.actionId);
      return { kind: "handled" };
    case "scrollIndicator":
      if (ROW_INTERACTIVE_MODES.has(mode)) {
        runtime.layout.scrollPage(target.direction === "up" ? -1 : 1);
      }
      return { kind: "handled" };
    case "toast":
      dismissStationToasts(runtime);
      return { kind: "handled" };
    case "sheetListItem":
      if (SHEET_CHOICE_MODES.has(mode)) {
        runtime.actions.dispatch({ type: "selection.item.activate", itemId: target.itemId });
      }
      return { kind: "handled" };
    case "removeWorktreeAction":
      dispatchStationAction(runtime, {
        type: "removeWorktree.activate",
        actionId: target.actionId,
      });
      return { kind: "handled" };
    case "freshStartAction":
      dispatchStationAction(runtime, {
        type: "freshStart.activate",
        actionId: target.actionId,
      });
      return { kind: "handled" };
    case "projectSettingsItem":
      if (mode === "projectSettings") {
        runtime.actions.dispatch({ type: "projectSettings.focusItem", itemId: target.itemId });
      }
      return { kind: "handled" };
    case "projectSettingsConfirmRemove":
      confirmProjectRemoval(runtime, mode);
      return { kind: "handled" };
    case "groupSettingsSection":
      if (mode === "groupSettings") {
        runtime.actions.dispatch({
          type: "groupSettings.section.select",
          section: target.section,
        });
      }
      return { kind: "handled" };
    case "groupSettingsControl":
      if (mode === "groupSettings") {
        runtime.actions.dispatch({
          type: "groupSettings.control.focus",
          control: target.control,
        });
      }
      return { kind: "handled" };
    case "groupSettingsSession":
      if (mode === "groupSettings") {
        runtime.actions.dispatch({
          type: "groupSettings.session.toggle",
          sessionId: target.sessionId,
        });
      }
      return { kind: "handled" };
    case "groupSettingsAction":
      if (mode === "groupSettings") {
        runtime.actions.dispatch({
          type: target.actionId === "save" ? "groupSettings.save" : "groupSettings.back",
        });
      }
      return { kind: "handled" };
    case "widgetSettingsOpen":
      if (mode === "dashboard") runtime.actions.dispatch({ type: "widgetSettings.open" });
      return { kind: "handled" };
    case "widgetSettingsRow":
      if (mode === "widgetSettings") {
        runtime.actions.dispatch({ type: "widgetSettings.toggle", index: target.index });
      }
      return { kind: "handled" };
    case "widgetSettingsRemove":
      if (mode === "widgetSettings") {
        runtime.actions.dispatch({ type: "widgetSettings.remove", index: target.index });
      }
      return { kind: "handled" };
    case "widgetSettingsAdd":
      if (mode === "widgetSettings") runtime.actions.dispatch({ type: "widgetSettings.openPicker" });
      return { kind: "handled" };
    case "widgetSettingsPickerChoice":
      if (mode === "widgetSettings") {
        runtime.actions.dispatch({ type: "widgetSettings.addFromPicker", index: target.index });
      }
      return { kind: "handled" };
    case "addProjectRow":
      if (ADD_PROJECT_ROW_MODES.has(mode)) {
        runtime.actions.dispatch({ type: "addProject.selectRow", itemId: target.itemId });
      }
      return { kind: "handled" };
    case "addProjectAction":
      dispatchStationAction(runtime, { type: "addProject.activate", actionId: target.actionId });
      return { kind: "handled" };
    case "newSessionAction":
      dispatchStationAction(runtime, { type: "newSession.activate", actionId: target.actionId });
      return { kind: "handled" };
    case "projectMenuAction":
      dispatchStationAction(runtime, { type: "projectMenu.activate", actionId: target.actionId });
      return { kind: "handled" };
    case "groupMenuAction":
      dispatchStationAction(runtime, { type: "groupMenu.activate", actionId: target.actionId });
      return { kind: "handled" };
    case "createGroupAction":
      dispatchStationAction(runtime, { type: "createGroup.activate", actionId: target.actionId });
      return { kind: "handled" };
    case "moveToGroupCreateSubmit":
      dispatchStationAction(runtime, { type: "moveToGroup.create.submit" });
      return { kind: "handled" };
    case "renameSessionSubmit":
      dispatchStationAction(runtime, { type: "renameSession.submit" });
      return { kind: "handled" };
    case "forkSessionAction":
      dispatchStationAction(runtime, {
        type: "forkSession.activate",
        actionId: target.actionId,
      });
      return { kind: "handled" };
    case "screenBackdrop":
      runtime.actions.dispatch({ type: "screen.clickAway" });
      return { kind: "handled" };
    case "body":
    case "sheetBackdrop":
      return { kind: "handled" };
  }
}

export function stationMouseEventKind(event: StationMouseEvent): StationMouseEventKind | undefined {
  if (event.type === "scroll") {
    if (event.scrollDirection === "up") return "scroll-up";
    if (event.scrollDirection === "down") return "scroll-down";
    return undefined;
  }
  return event.type === "down" && event.button === "left" ? "down" : undefined;
}

function routePersistentFilterConditionAction(
  runtime: DashboardMouseRuntime,
  mode: TuiInputMode,
  actionId: "back" | "close" | "done" | "applyFilter",
): void {
  if (actionId === "close") {
    if (mode === "persistentFilterConditionField" || mode === "persistentFilterConditionValues") {
      runtime.actions.dispatch({ type: "persistentFilter.condition.close" });
    }
    return;
  }
  if (actionId === "applyFilter") {
    if (mode === "persistentFilterConditionField") {
      runtime.actions.dispatch({ type: "persistentFilter.applyDraft" });
    }
    return;
  }
  if (mode === "persistentFilterConditionValues") {
    runtime.actions.dispatch({
      type:
        actionId === "back"
          ? "persistentFilter.condition.back"
          : "persistentFilter.condition.done",
    });
  }
}

function confirmProjectRemoval(runtime: DashboardMouseRuntime, mode: TuiInputMode): void {
  const screen = runtime.state.getState().screen;
  if (
    mode === "projectSettings" &&
    screen.name === "projectSettings" &&
    isRemoveProjectArmed(screen)
  ) {
    runtime.actions.handleKey({ input: "r" });
  }
}

function routeStationWheel(
  target: StationMouseTarget,
  eventKind: "scroll-up" | "scroll-down",
  runtime: DashboardMouseRuntime,
  mode: TuiInputMode,
): void {
  if (
    target.kind === "screenBackdrop" ||
    target.kind === "sheetBackdrop" ||
    !ROW_INTERACTIVE_MODES.has(mode)
  ) {
    return;
  }
  runtime.layout.scrollBy(eventKind === "scroll-up" ? -1 : 1);
}
