// OpenTUI port of apps/tui's HelpOverlay: centered box-drawn panel above the
// dashboard (absolute + zIndex; the dashboard must never reflow for it).
// Lines come from the shared panel generator over Station's visible help copy.
import { DASHBOARD_FILTER_CONDITION_KEYS, helpPanelLayout, helpPanelLines } from "@station/dashboard-core/selectors";
import {
  dashboardBindingHelp,
  type TuiDashboardBindingId,
} from "@station/dashboard-core/state";
import { stationKeymapHelp } from "../../input/keymap/stationBindings.js";
import { toOpenTuiColor, toOpenTuiOpaqueColor, useStationTheme } from "../../theme/index.js";
import { useStationMouse, stationMouseProps } from "./stationMouseContext.js";

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
const sessionShortcut = dashboardHelp("tui.dashboard.slotActivate");
const shortcutPrefix = dashboardHelp("tui.dashboard.shortcutPrefix");

const STATION_HELP_CONTENT = [
  { text: "station help", align: "center" as const },
  ...stationKeymapHelp(),
  { text: "station project view", align: "center" as const },
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
  {
    key: `${sessionShortcut.key} · ${shortcutPrefix.key}`,
    description: "session/command · condition toggle",
  },
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
] as const;

export function HelpOverlayView({ columns, rows }: { columns: number; rows: number }) {
  const theme = useStationTheme();
  const helpBackground = toOpenTuiOpaqueColor(theme.surfaces.help);
  const dispatch = useStationMouse();
  const layout = helpPanelLayout(columns, rows, STATION_HELP_CONTENT);
  const panelLines = helpPanelLines(layout.width, layout.height, STATION_HELP_CONTENT);

  return (
    <box
      position="absolute"
      top={layout.top}
      left={layout.left}
      width={layout.width}
      height={layout.height}
      zIndex={10}
      flexDirection="column"
      backgroundColor={helpBackground}
      {...stationMouseProps(dispatch, { kind: "sheetBackdrop" })}
    >
      {panelLines.map((line, index) => (
        <text
          key={`${index}:${line}`}
          fg={toOpenTuiColor(theme.text.primary)}
          bg={helpBackground}
        >
          {line}
        </text>
      ))}
    </box>
  );
}
