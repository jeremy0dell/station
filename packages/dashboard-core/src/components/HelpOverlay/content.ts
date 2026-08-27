import { DASHBOARD_FILTER_CONDITION_KEYS } from "../../selectors/dashboardFilterConditions.js";
import {
  dashboardBindingHelp,
  type TuiDashboardBindingId,
  type TuiHelpContentLine,
} from "../../state/keymap.js";

const FILTER_CONDITION_KEY_HINT = DASHBOARD_FILTER_CONDITION_KEYS.join("/");

function dashboardHelp(id: TuiDashboardBindingId): { key: string; description: string } {
  const help = dashboardBindingHelp(id);
  if (help === undefined) throw new Error(`Dashboard binding ${id} has no Help metadata.`);
  return {
    key: help.panelKeys ?? help.keys,
    description: help.panelLabel ?? help.label,
  };
}

function dashboardHelpGroup(ids: readonly TuiDashboardBindingId[]): {
  key: string;
  description: string;
} {
  const entries = ids.map(dashboardHelp);
  return {
    key: entries.map(({ key }) => key).join("/"),
    description: [...new Set(entries.map(({ description }) => description))].join("/"),
  };
}

function dashboardKeys(ids: readonly TuiDashboardBindingId[]): string {
  return ids.map((id) => dashboardHelp(id).key).join(" ");
}

function dashboardProjectViewHelpLines(): TuiHelpContentLine[] {
  const navigation = dashboardHelpGroup(["tui.dashboard.focusUp", "tui.dashboard.focusDown"]);
  const helpAliases = dashboardHelpGroup(["tui.dashboard.help", "tui.dashboard.helpAlias"]);
  const refresh = dashboardHelp("tui.dashboard.refresh");
  return [
    { key: navigation.key, description: `${navigation.description} · wheel scroll` },
    dashboardHelp("tui.dashboard.focusActivate"),
    dashboardHelp("tui.dashboard.nextNeedsMe"),
    dashboardHelpGroup(["tui.dashboard.quickGroup", "tui.dashboard.moveToGroup"]),
    {
      key: dashboardKeys([
        "tui.dashboard.filter",
        "tui.dashboard.focusActivate",
        "tui.dashboard.dismissEsc",
        "tui.dashboard.quit",
      ]),
      description: "edit/apply/cancel-clear/retain-close filter",
    },
    {
      key: `Tab ${FILTER_CONDITION_KEY_HINT}`,
      description: "build filter conditions · F applies builder",
    },
    dashboardHelp("tui.dashboard.slotActivate"),
    dashboardHelpGroup([
      "tui.dashboard.newSession",
      "tui.dashboard.addProject",
      "tui.dashboard.rename",
      "tui.dashboard.collapse",
      "tui.dashboard.fork",
      "tui.dashboard.projectSettings",
    ]),
    dashboardHelp("tui.dashboard.widgetSettings"),
    dashboardHelp("tui.dashboard.remove"),
    {
      key: helpAliases.key,
      description: `${helpAliases.description} · ${refresh.key} ${refresh.description}`,
    },
  ];
}

const DASHBOARD_PROJECT_VIEW_HELP_LINE_COUNT = dashboardProjectViewHelpLines().length;

/** Full Help overlay copy: Station keymap lines, then the dashboard project-view bindings. */
export function helpOverlayContent(
  keymapHelp: readonly TuiHelpContentLine[],
): TuiHelpContentLine[] {
  return [
    { text: "station help", align: "center" },
    ...keymapHelp,
    { text: "station project view", align: "center" },
    ...dashboardProjectViewHelpLines(),
  ];
}

export function helpOverlayLineCount(keymapHelpCount: number): number {
  return 2 + Math.max(0, Math.floor(keymapHelpCount)) + DASHBOARD_PROJECT_VIEW_HELP_LINE_COUNT;
}
