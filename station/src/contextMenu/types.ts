import type { ProjectId, SessionGroupId } from "@station/contracts";
import type { GroupMenuActionId } from "@station/dashboard-core/state";
import type { PaneId, PaneSplitDirection } from "../state/types.js";
import type { StationMouseTarget } from "../station/input/stationMouse.js";

export type ContextMenuAnchor = {
  x: number;
  y: number;
};

export type ContextMenuTarget =
  | { kind: "header" }
  | { kind: "pane"; paneId: PaneId }
  | { kind: "station"; target: StationMouseTarget };

export type ContextMenuState = {
  target: ContextMenuTarget;
  anchor: ContextMenuAnchor;
  activeIndex: number;
};

export type ContextMenuItemId =
  | "pane.splitRight"
  | "pane.splitBelow"
  | "pane.close"
  | "station.renameSession"
  | "station.moveToGroup"
  | "station.forkSession"
  | "station.removeWorktree"
  | "project.quickGroup"
  | "project.newGroup"
  | "project.setDefaultAgent"
  | "project.openSettings"
  | "group.quickSession"
  | "group.newSession"
  | "group.openSettings"
  | "group.remove"
  | "station.noActions"
  // One per configured automation; the id carries the automation id.
  | `pane.automation.${string}`;

export type ContextMenuItemAction =
  | { kind: "noop" }
  | { kind: "splitPane"; paneId: PaneId; direction: PaneSplitDirection }
  | { kind: "closePane"; paneId: PaneId }
  | { kind: "renameSession"; rowId: string }
  | { kind: "moveToGroup"; rowId: string }
  | { kind: "forkSession"; rowId: string }
  | { kind: "removeWorktree"; rowId: string }
  | { kind: "quickGroup"; projectId: ProjectId }
  | { kind: "newGroup"; projectId: ProjectId }
  | { kind: "setProjectDefaultAgent"; projectId: ProjectId }
  | { kind: "openProjectSettings"; projectId: ProjectId }
  | {
      kind: "groupMenuAction";
      projectId: ProjectId;
      groupId: SessionGroupId;
      actionId: GroupMenuActionId;
    }
  // Run a configured automation, anchored on the pane the menu opened over.
  | { kind: "runAutomation"; automationId: string; paneId: PaneId };

export type ContextMenuItem = {
  id: ContextMenuItemId;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  shortcut?: string;
  separatorBefore?: true;
  action: ContextMenuItemAction;
};
