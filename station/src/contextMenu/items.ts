import { normalize } from "node:path";
import type { ProjectId, SessionGroupId } from "@station/contracts";
import type { Automation } from "../config/stationConfig.js";
import { MAIN_PANE_ID, worktreeIdFromAgentPaneId, type StationState } from "../state/types.js";
import { selectDashboardSlots } from "@station/dashboard-core/selectors";
import type { DashboardSessionRow } from "@station/dashboard-core/selectors";
import { GROUP_MENU_ITEMS, isAgentRemovalUnavailable } from "@station/dashboard-core/state";
import type { DashboardStateView, GroupMenuActionId } from "@station/dashboard-core/state";
import type {
  ContextMenuItem,
  ContextMenuItemAction,
  ContextMenuTarget,
} from "./types.js";

export function buildContextMenuItems(
  target: ContextMenuTarget,
  state: StationState,
  stationState?: DashboardStateView,
  automations: readonly Automation[] = [],
): readonly ContextMenuItem[] {
  switch (target.kind) {
    case "pane":
      return buildPaneItems(target.paneId, state, automations);
    case "header":
      return [noActionsItem()];
    case "station":
      return buildStationItems(target.target, stationState);
  }
}

export function resolveContextMenuAction(
  item: ContextMenuItem | undefined,
): ContextMenuItemAction | undefined {
  if (item === undefined || item.disabled === true) {
    return undefined;
  }
  return item.action;
}

function buildPaneItems(
  paneId: string,
  state: StationState,
  automations: readonly Automation[],
): readonly ContextMenuItem[] {
  const pane = state.workspace.panes.find((candidate) => candidate.id === paneId);
  const paneExists = pane !== undefined;
  const closeDisabled =
    !paneExists || paneId === MAIN_PANE_ID || state.workspace.panes.length <= 1;
  const closeItem: ContextMenuItem = {
    id: "pane.close",
    label: "Close Pane",
    danger: true,
    action: { kind: "closePane", paneId },
  };
  if (closeDisabled) {
    closeItem.disabled = true;
  }
  const automationItems: ContextMenuItem[] = automations
    .filter((automation) => automation.enabled)
    .map((automation) => ({
      id: `pane.automation.${automation.id}`,
      label: automation.label,
      action: { kind: "runAutomation", automationId: automation.id, paneId },
    }));
  // Split has no pane-count guard; automations sit after the splits so a benign Split Right stays
  // the default-Enter target (menu opens on index 0) rather than a command-executing automation.
  const items: ContextMenuItem[] = [];
  // Rename is offered only for primary-agent panes and leads the menu so the
  // direct rename flow stays one keystroke from the dashboard.
  const rowId = pane?.role === "primary-agent" ? worktreeIdFromAgentPaneId(pane.id) : undefined;
  if (rowId !== undefined) {
    items.push({
      id: "station.renameSession",
      label: "Rename",
      action: { kind: "renameSession", rowId },
    });
  }
  items.push(
    {
      id: "pane.splitRight",
      label: "Split Right",
      action: { kind: "splitPane", paneId, direction: "right" },
    },
    {
      id: "pane.splitBelow",
      label: "Split Below",
      action: { kind: "splitPane", paneId, direction: "below" },
    },
    ...automationItems,
    closeItem,
  );
  return items;
}

function buildStationItems(
  target: Extract<ContextMenuTarget, { kind: "station" }>["target"],
  state: DashboardStateView | undefined,
): readonly ContextMenuItem[] {
  if (state?.screen.name !== "dashboard" || state.snapshot === undefined) {
    return [noActionsItem()];
  }
  if (target.kind !== "dashboardCell") {
    return [noActionsItem()];
  }
  const slots = selectDashboardSlots(state.snapshot, state, state.screen);
  const row = slots.tree.rowById.get(target.rowId);
  if (row === undefined || !row.cells.includes(target.cellId)) {
    return [noActionsItem()];
  }
  switch (row.payload.type) {
    case "projectHeader":
      return buildProjectItems(row.payload.project.id, state);
    case "groupHeader":
      return buildGroupItems(row.payload.group.id, row.payload.group.projectId, state);
    case "session": {
      const sessionRow = row.payload.row;
      return slots.rowChoices.some((choice) => choice.value.id === sessionRow.id)
        ? buildSessionItems(sessionRow, state)
        : [noActionsItem()];
    }
    case "createLocalRow":
    case "emptyProject":
      return [noActionsItem()];
  }
}

function buildSessionItems(
  row: DashboardSessionRow,
  state: DashboardStateView,
): readonly ContextMenuItem[] {
  if (state.snapshot === undefined) {
    return [noActionsItem()];
  }
  const project = state.snapshot.projects.find(
    (candidate) => candidate.id === row.worktree.projectId,
  );
  const items: ContextMenuItem[] = [];
  if (row.session.origin === "station") {
    items.push({
      id: "station.renameSession",
      label: "Rename Session",
      action: { kind: "renameSession", rowId: row.id },
    });
  }
  items.push({
    id: "station.moveToGroup",
    label: "Move to Group…",
    action: { kind: "moveToGroup", rowId: row.id },
  });
  // Any worktree can be forked (branch off its HEAD, copy its dirty tree).
  items.push({
    id: "station.forkSession",
    label: "Fork Session",
    action: { kind: "forkSession", rowId: row.id },
  });
  if (project === undefined || !samePath(row.worktree.path, project.root)) {
    items.push({
      id: "station.removeWorktree",
      label: isAgentRemovalUnavailable(row, state.snapshot)
        ? "Delete Worktree…"
        : "Delete Session",
      danger: true,
      action: { kind: "removeWorktree", rowId: row.id },
    });
  }
  return items.length === 0 ? [noActionsItem()] : items;
}

const GROUP_CONTEXT_ITEM_IDS: Record<GroupMenuActionId, ContextMenuItem["id"]> = {
  quickSession: "group.quickSession",
  newSession: "group.newSession",
  settings: "group.openSettings",
  remove: "group.remove",
};

function buildGroupItems(
  groupId: SessionGroupId,
  projectId: ProjectId,
  state: DashboardStateView,
): readonly ContextMenuItem[] {
  const group = state.snapshot?.sessionGroups.find(
    (candidate) => candidate.id === groupId && candidate.projectId === projectId,
  );
  if (group === undefined) return [noActionsItem()];
  return GROUP_MENU_ITEMS.map((item) => ({
    id: GROUP_CONTEXT_ITEM_IDS[item.id],
    label: item.label,
    shortcut: item.shortcut,
    ...(item.separatorBefore === true ? { separatorBefore: true as const } : {}),
    ...(item.danger === true ? { danger: true } : {}),
    action: {
      kind: "groupMenuAction" as const,
      projectId: group.projectId,
      groupId: group.id,
      actionId: item.id,
    },
  }));
}

function buildProjectItems(
  projectId: string,
  state: DashboardStateView,
): readonly ContextMenuItem[] {
  const project = state.snapshot?.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) {
    return [noActionsItem()];
  }
  // The default-agent picker refuses unavailable projects, so disable the item
  // there rather than offer an action that silently no-ops.
  const setDefaultAgent: ContextMenuItem = {
    id: "project.setDefaultAgent",
    label: "Set Default Agent",
    action: { kind: "setProjectDefaultAgent", projectId: project.id },
  };
  if (project.health.status === "unavailable") {
    setDefaultAgent.disabled = true;
  }
  return [
    {
      id: "project.quickGroup",
      label: "Quick Group",
      action: { kind: "quickGroup", projectId: project.id },
    },
    {
      id: "project.newGroup",
      label: "New Group…",
      action: { kind: "newGroup", projectId: project.id },
    },
    setDefaultAgent,
    {
      id: "project.openSettings",
      label: "Project Settings…",
      action: { kind: "openProjectSettings", projectId: project.id },
    },
  ];
}

function noActionsItem(): ContextMenuItem {
  return {
    id: "station.noActions",
    label: "No Actions Available",
    disabled: true,
    action: { kind: "noop" },
  };
}

function samePath(left: string, right: string): boolean {
  return normalize(left) === normalize(right);
}
