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
  | "station.forkSession"
  | "station.removeWorktree"
  | "station.noActions"
  // One per configured automation; the id carries the automation id.
  | `pane.automation.${string}`;

export type ContextMenuItemAction =
  | { kind: "noop" }
  | { kind: "splitPane"; paneId: PaneId; direction: PaneSplitDirection }
  | { kind: "closePane"; paneId: PaneId }
  | { kind: "renameSession"; rowId: string }
  | { kind: "forkSession"; rowId: string }
  | { kind: "removeWorktree"; rowId: string }
  // Run a configured automation, anchored on the pane the menu opened over.
  | { kind: "runAutomation"; automationId: string; paneId: PaneId };

export type ContextMenuItem = {
  id: ContextMenuItemId;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  action: ContextMenuItemAction;
};
