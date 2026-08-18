import { TextAttributes } from "@opentui/core";
import { Fragment } from "react";
import { formatMenuRow } from "../../menu/formatMenuRow.js";
import { visibleMenuItems } from "../../menu/visibleMenuItems.js";
import type { StationMouseTarget } from "../input/stationMouse.js";
import { toOpenTuiColor, toOpenTuiOpaqueColor, useStationTheme } from "../../theme/index.js";
import {
  stationMouseProps,
  useStationHoverState,
  useStationMouse,
} from "./stationMouseContext.js";

export type DashboardMenuItemView = {
  readonly id: string;
  readonly label: string;
  readonly shortcut?: string;
  readonly separatorBefore?: true;
  readonly danger?: true;
  readonly focused: boolean;
  readonly target: StationMouseTarget;
};

export type DashboardMenuModel = {
  readonly items: readonly DashboardMenuItemView[];
  readonly width: number;
  readonly title?: string;
};

export type DashboardMenuViewport = {
  readonly columns: number;
  readonly rows: number;
  readonly anchorTop: number;
};

export type DashboardMenuViewProps = {
  menu: DashboardMenuModel;
  viewport: DashboardMenuViewport;
};

/** Shared anchored-menu geometry and row presentation for dashboard feature menus. */
export function DashboardMenuView({ menu, viewport }: DashboardMenuViewProps) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const width = Math.min(Math.max(1, viewport.columns), menu.width);
  const requestedHeight =
    menu.items.length + menu.items.filter((item) => item.separatorBefore === true).length + 2;
  const height = Math.min(Math.max(1, viewport.rows), requestedHeight);
  const below = viewport.anchorTop + 1;
  const top = Math.max(
    0,
    Math.min(
      viewport.rows - height,
      below + height <= viewport.rows ? below : viewport.anchorTop - height,
    ),
  );
  const contentWidth = Math.max(1, width - 2);
  const items = visibleMenuItems(menu.items, Math.max(0, height - 2));
  const titleProps: { title?: string } = {};
  if (menu.title !== undefined) titleProps.title = menu.title;

  return (
    <box
      position="absolute"
      left={Math.max(0, viewport.columns - width)}
      top={top}
      width={width}
      height={height}
      zIndex={10}
      border
      {...titleProps}
      borderColor={toOpenTuiColor(theme.contextMenu.border)}
      backgroundColor={toOpenTuiOpaqueColor(theme.contextMenu.surface)}
      flexDirection="column"
      overflow="hidden"
      {...stationMouseProps(dispatch, { kind: "sheetBackdrop" })}
    >
      {items.map(({ item }) => (
        <Fragment key={item.id}>
          {item.separatorBefore === true ? (
            <DashboardMenuSeparator width={contentWidth} />
          ) : null}
          <DashboardMenuItem item={item} width={contentWidth} dispatch={dispatch} />
        </Fragment>
      ))}
    </box>
  );
}

function DashboardMenuSeparator({ width }: { width: number }) {
  const theme = useStationTheme();
  return (
    <text fg={toOpenTuiColor(theme.contextMenu.border)}>
      {"─".repeat(width)}
    </text>
  );
}

function DashboardMenuItem({
  item,
  width,
  dispatch,
}: {
  item: DashboardMenuItemView;
  width: number;
  dispatch: ReturnType<typeof useStationMouse>;
}) {
  const theme = useStationTheme();
  const [hover, setHover] = useStationHoverState();
  const active = item.focused || hover;
  const content = formatMenuRow(item.label, item.shortcut, Math.max(0, width - 1));
  return (
    <text
      width={width}
      fg={toOpenTuiColor(item.danger === true ? theme.status.danger : theme.text.menu)}
      bg={toOpenTuiOpaqueColor(active ? theme.contextMenu.selected : theme.contextMenu.surface)}
      attributes={item.focused ? TextAttributes.BOLD : TextAttributes.NONE}
      {...stationMouseProps(dispatch, item.target)}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      {` ${content}`}
    </text>
  );
}
