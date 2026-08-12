import { TextAttributes } from "@opentui/core";
import type {
  DashboardScreenView,
  ProjectMenuActionId,
} from "@station/dashboard-core/state";
import { toOpenTuiColor, toOpenTuiOpaqueColor, useStationTheme } from "../../theme/index.js";
import {
  stationMouseProps,
  useStationHoverState,
  useStationMouse,
} from "./stationMouseContext.js";

const PROJECT_MENU_ITEMS: readonly { id: ProjectMenuActionId; label: string }[] = [
  { id: "quickGroup", label: "Quick Group" },
  { id: "newGroup", label: "New Group…" },
  { id: "defaultAgent", label: "Set default agent" },
  { id: "settings", label: "Project settings…" },
];
const MENU_WIDTH = 24;
const MENU_HEIGHT = PROJECT_MENU_ITEMS.length + 2;

export type ProjectMenuViewProps = {
  screen: Extract<DashboardScreenView, { name: "projectMenu" }>;
  columns: number;
  rows: number;
  anchorTop: number;
};

export function ProjectMenuView({ screen, columns, rows, anchorTop }: ProjectMenuViewProps) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const width = Math.min(Math.max(1, columns), MENU_WIDTH);
  const height = Math.min(Math.max(1, rows), MENU_HEIGHT);
  const below = anchorTop + 1;
  const top = Math.max(0, Math.min(rows - height, below + height <= rows ? below : anchorTop - height));

  return (
    <box
      position="absolute"
      left={Math.max(0, columns - width)}
      top={top}
      width={width}
      height={height}
      zIndex={10}
      border
      borderColor={toOpenTuiColor(theme.contextMenu.border)}
      backgroundColor={toOpenTuiOpaqueColor(theme.contextMenu.surface)}
      flexDirection="column"
      overflow="hidden"
      {...stationMouseProps(dispatch, { kind: "sheetBackdrop" })}
    >
      {PROJECT_MENU_ITEMS.slice(0, Math.max(0, height - 2)).map((item) => (
        <ProjectMenuItem
          key={item.id}
          item={item}
          focused={screen.focus === item.id}
          width={Math.max(1, width - 2)}
          dispatch={dispatch}
        />
      ))}
    </box>
  );
}

function ProjectMenuItem({
  item,
  focused,
  width,
  dispatch,
}: {
  item: (typeof PROJECT_MENU_ITEMS)[number];
  focused: boolean;
  width: number;
  dispatch: ReturnType<typeof useStationMouse>;
}) {
  const theme = useStationTheme();
  const [hover, setHover] = useStationHoverState();
  const active = focused || hover;
  return (
    <text
      width={width}
      fg={toOpenTuiColor(theme.text.menu)}
      bg={toOpenTuiOpaqueColor(active ? theme.contextMenu.selected : theme.contextMenu.surface)}
      attributes={focused ? TextAttributes.BOLD : TextAttributes.NONE}
      {...stationMouseProps(dispatch, { kind: "projectMenuAction", actionId: item.id })}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      {` ${item.label}`.padEnd(width).slice(0, width)}
    </text>
  );
}
