import { normalize } from "node:path";
import type { Automation } from "../config/stationConfig.js";
import { MAIN_PANE_ID, worktreeIdFromAgentPaneId, type StationState } from "../state/types.js";
import {
  selectDashboardViewport,
  sessionForWorktreeRow,
  type TuiState,
} from "@station/dashboard-core";
import type {
  ContextMenuItem,
  ContextMenuItemAction,
  ContextMenuTarget,
} from "./types.js";

export function buildContextMenuItems(
  target: ContextMenuTarget,
  state: StationState,
  stationState?: TuiState,
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
  state: TuiState | undefined,
): readonly ContextMenuItem[] {
  if (state?.screen.name !== "dashboard" || state.snapshot === undefined) {
    return [noActionsItem()];
  }
  // Any project-header affordance (header text, [▾], [+], [+sh]) opens the
  // project menu, so a right-click anywhere on the header row is consistent.
  const projectId = projectIdFromStationTarget(target);
  if (projectId !== undefined) {
    return buildProjectItems(projectId, state);
  }
  if (target.kind !== "row") {
    return [noActionsItem()];
  }
  const row = selectDashboardViewport(state.snapshot, state).rowChoices.find(
    (choice) => choice.value.id === target.rowId,
  )?.value;
  if (row === undefined) {
    return [noActionsItem()];
  }
  const project = state.snapshot.projects.find((candidate) => candidate.id === row.projectId);
  const items: ContextMenuItem[] = [];
  if (sessionForWorktreeRow(row, state.snapshot.sessions) !== undefined) {
    items.push({
      id: "station.renameSession",
      label: "Rename Session",
      action: { kind: "renameSession", rowId: row.id },
    });
  }
  if (project === undefined || !samePath(row.path, project.root)) {
    items.push({
      id: "station.removeWorktree",
      label: "Delete Session",
      danger: true,
      action: { kind: "removeWorktree", rowId: row.id },
    });
  }
  return items.length === 0 ? [noActionsItem()] : items;
}

/** The projectId behind any project-scoped station mouse target, else undefined. */
function projectIdFromStationTarget(
  target: Extract<ContextMenuTarget, { kind: "station" }>["target"],
): string | undefined {
  switch (target.kind) {
    case "projectHeader":
    case "openShellForProject":
    case "quickSessionForProject":
    case "showDefaultAgentPickerForProject":
      return target.projectId;
    default:
      return undefined;
  }
}

function buildProjectItems(projectId: string, state: TuiState): readonly ContextMenuItem[] {
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
