// Renderer-owned overlay: OpenTUI centers and clips the semantic help entries,
// while the structural panel owns its border and padding.
import { DASHBOARD_FILTER_CONDITION_KEYS } from "@station/dashboard-core/selectors";
import {
  dashboardBindingHelp,
  type TuiDashboardBindingId,
} from "@station/dashboard-core/state";
import { stationKeymapHelp } from "../../input/keymap/stationBindings.js";
import { toOpenTuiColor, toOpenTuiOpaqueColor, useStationTheme } from "../../theme/index.js";
import { SemanticScrollRegion } from "./layout/SemanticScrollViewport.js";
import { semanticItemRenderableId } from "./layout/scrollViewport.js";
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

const STATION_HELP_CONTENT = [
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

type HelpEntry = (typeof STATION_HELP_CONTENT)[number];

export function HelpOverlayView({ columns, rows }: { columns: number; rows: number }) {
  const theme = useStationTheme();
  const helpBackground = toOpenTuiOpaqueColor(theme.surfaces.help);
  const dispatch = useStationMouse();

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width={Math.max(1, columns)}
      height={Math.max(1, rows)}
      zIndex={10}
      alignItems="center"
      justifyContent="center"
      {...stationMouseProps(dispatch, { kind: "screenBackdrop" })}
    >
      <box
        id="station-help-surface"
        width="90%"
        maxWidth={64}
        maxHeight="90%"
        flexDirection="column"
        flexShrink={1}
        border
        borderStyle="rounded"
        borderColor={toOpenTuiColor(theme.interaction.hairline)}
        backgroundColor={helpBackground}
        overflow="hidden"
        {...stationMouseProps(dispatch, { kind: "sheetBackdrop" })}
      >
        <SemanticScrollRegion
          itemIds={STATION_HELP_CONTENT.map((entry) => entry.id)}
          fill={false}
          viewportId="station-help-content"
        >
          <box width="100%" flexDirection="column" paddingLeft={2} paddingRight={2}>
            {STATION_HELP_CONTENT.map((entry) => (
              <HelpEntryView key={entry.id} entry={entry} />
            ))}
          </box>
        </SemanticScrollRegion>
      </box>
    </box>
  );
}

function HelpEntryView({ entry }: { entry: HelpEntry }) {
  const theme = useStationTheme();
  const foreground = toOpenTuiColor(theme.text.primary);
  if ("text" in entry) {
    return (
      <box
        id={semanticItemRenderableId(entry.id)}
        width="100%"
        flexDirection="row"
        justifyContent="center"
      >
        <text fg={foreground} selectable={false}>
          {entry.text}
        </text>
      </box>
    );
  }
  return (
    <box
      id={semanticItemRenderableId(entry.id)}
      width="100%"
      flexDirection="row"
      columnGap={2}
    >
      <text width={11} flexShrink={1} fg={foreground} selectable={false}>
        {entry.key}
      </text>
      <text
        minWidth={1}
        flexGrow={1}
        flexShrink={1}
        fg={foreground}
        wrapMode="word"
        selectable={false}
      >
        {entry.description}
      </text>
    </box>
  );
}
