import { DASHBOARD_FILTER_CONDITION_KEYS } from "@station/dashboard-core/selectors";
import {
  dashboardBindingHelp,
  type TuiDashboardBindingId,
} from "@station/dashboard-core/state";
import type { HelpEntryOrderSource } from "@station/dashboard-core/runtime";
import { stationKeymapHelp } from "../input/keymap/stationBindings.js";

const FILTER_CONDITION_KEY_HINT = DASHBOARD_FILTER_CONDITION_KEYS.join("/");

function dashboardHelp(id: TuiDashboardBindingId): { key: string; description: string } {
  const help = dashboardBindingHelp(id);
  if (help === undefined) throw new Error(`Dashboard binding ${id} has no Help metadata.`);
  return {
    key: help.panelKeys ?? help.keys,
    description: help.panelLabel ?? help.label,
  };
}

function dashboardHelpGroup(
  ids: readonly TuiDashboardBindingId[],
): { key: string; description: string } {
  const entries = ids.map(dashboardHelp);
  return {
    key: entries.map(({ key }) => key).join("/"),
    description: [...new Set(entries.map(({ description }) => description))].join("/"),
  };
}

function dashboardKeys(ids: readonly TuiDashboardBindingId[]): string {
  return ids.map((id) => dashboardHelp(id).key).join(" ");
}

const navigation = dashboardHelpGroup(["tui.dashboard.focusUp", "tui.dashboard.focusDown"]);
const helpAliases = dashboardHelpGroup(["tui.dashboard.help", "tui.dashboard.helpAlias"]);
const refresh = dashboardHelp("tui.dashboard.refresh");

export const STATION_HELP_ENTRIES = [
  { id: "help:heading:station", text: "station help" },
  ...stationKeymapHelp().map((entry) => ({ ...entry, id: `help:station:${entry.id}` })),
  { id: "help:heading:dashboard", text: "station project view" },
  {
    id: "help:dashboard:navigation",
    key: navigation.key,
    description: `${navigation.description} · wheel scroll`,
  },
  { id: "help:dashboard:activate", ...dashboardHelp("tui.dashboard.focusActivate") },
  { id: "help:dashboard:attention", ...dashboardHelp("tui.dashboard.nextNeedsMe") },
  {
    id: "help:dashboard:group",
    ...dashboardHelpGroup(["tui.dashboard.quickGroup", "tui.dashboard.moveToGroup"]),
  },
  {
    id: "help:dashboard:filter",
    key: dashboardKeys([
      "tui.dashboard.filter",
      "tui.dashboard.focusActivate",
      "tui.dashboard.dismissEsc",
      "tui.dashboard.quit",
    ]),
    description: "edit/apply/cancel-clear/retain-close filter",
  },
  {
    id: "help:dashboard:condition",
    key: `Tab ${FILTER_CONDITION_KEY_HINT}`,
    description: "build filter conditions · F applies builder",
  },
  { id: "help:dashboard:slot", ...dashboardHelp("tui.dashboard.slotActivate") },
  {
    id: "help:dashboard:session-actions",
    ...dashboardHelpGroup([
      "tui.dashboard.newSession",
      "tui.dashboard.addProject",
      "tui.dashboard.rename",
      "tui.dashboard.collapse",
      "tui.dashboard.fork",
      "tui.dashboard.projectSettings",
    ]),
  },
  { id: "help:dashboard:widgets", ...dashboardHelp("tui.dashboard.widgetSettings") },
  { id: "help:dashboard:remove", ...dashboardHelp("tui.dashboard.remove") },
  {
    id: "help:dashboard:help-refresh",
    key: helpAliases.key,
    description: `${helpAliases.description} · ${refresh.key} ${refresh.description}`,
  },
] as const;

export type StationHelpEntry = (typeof STATION_HELP_ENTRIES)[number];

export const STATION_HELP_ENTRY_IDS = STATION_HELP_ENTRIES.map((entry) => entry.id);

export const stationHelpEntryOrder: HelpEntryOrderSource = {
  entryIds: () => STATION_HELP_ENTRY_IDS,
};
