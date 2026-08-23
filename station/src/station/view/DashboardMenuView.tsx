import { TextAttributes } from "@opentui/core";
import { Fragment } from "react";
import type { StationMouseTarget } from "../input/stationMouse.js";
import { toOpenTuiColor, toOpenTuiOpaqueColor, useStationTheme } from "../../theme/index.js";
import { SemanticScrollRegion } from "./layout/SemanticScrollViewport.js";
import { semanticItemRenderableId } from "./layout/scrollViewport.js";
import { useAnchoredMenuPlacement } from "./layout/useAnchoredMenuPlacement.js";

const DASHBOARD_MENU_VIEWPORT_ID = "station-dashboard-menu-items";
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
  readonly preferredWidth: number;
  readonly title?: string;
};

export type DashboardMenuViewProps = {
  menu: DashboardMenuModel;
  boundaryId: string;
  anchorRenderableId: string;
};

/** Shared semantic item presentation for structurally anchored dashboard menus. */
export function DashboardMenuView({ menu, boundaryId, anchorRenderableId }: DashboardMenuViewProps) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const menuRef = useAnchoredMenuPlacement(
    boundaryId,
    anchorRenderableId,
    DASHBOARD_MENU_VIEWPORT_ID,
  );
  const itemIds = menu.items.map((item) => item.id);
  const followedItemId = menu.items.find((item) => item.focused)?.id;
  const titleProps: { title?: string } = {};
  if (menu.title !== undefined) titleProps.title = menu.title;

  return (
    <box
      id="station-dashboard-menu"
      ref={menuRef}
      position="absolute"
      right={0}
      top={0}
      width={menu.preferredWidth}
      maxWidth="100%"
      zIndex={10}
      border
      {...titleProps}
      borderColor={toOpenTuiColor(theme.contextMenu.border)}
      backgroundColor={toOpenTuiOpaqueColor(theme.contextMenu.surface)}
      flexDirection="column"
      overflow="hidden"
      {...stationMouseProps(dispatch, { kind: "sheetBackdrop" })}
    >
      <SemanticScrollRegion
        itemIds={itemIds}
        followedItemId={followedItemId}
        fill={false}
        viewportId={DASHBOARD_MENU_VIEWPORT_ID}
      >
        {menu.items.map((item) => (
          <Fragment key={item.id}>
            {item.separatorBefore === true ? <DashboardMenuSeparator /> : null}
            <DashboardMenuItem item={item} />
          </Fragment>
        ))}
      </SemanticScrollRegion>
    </box>
  );
}

function DashboardMenuSeparator() {
  const theme = useStationTheme();
  return (
    <box
      width="100%"
      height={1}
      flexShrink={0}
      border={["top"]}
      borderColor={toOpenTuiColor(theme.contextMenu.border)}
    />
  );
}

function DashboardMenuItem({ item }: { item: DashboardMenuItemView }) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  const active = item.focused || hover;
  const color = toOpenTuiColor(
    item.danger === true ? theme.status.danger : theme.text.menu,
  );
  const attributes = item.focused ? TextAttributes.BOLD : TextAttributes.NONE;
  return (
    <box
      id={semanticItemRenderableId(item.id)}
      width="100%"
      flexDirection="row"
      backgroundColor={toOpenTuiOpaqueColor(
        active ? theme.contextMenu.selected : theme.contextMenu.surface,
      )}
      {...stationMouseProps(dispatch, item.target)}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      <text flexShrink={0} fg={color} attributes={attributes}>
        {item.focused ? "▸" : " "}
      </text>
      <box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
        <text fg={color} attributes={attributes}>
          {item.label}
        </text>
      </box>
      {item.shortcut === undefined ? null : (
        <text flexShrink={0} fg={color} attributes={attributes}>
          {` ${item.shortcut}`}
        </text>
      )}
    </box>
  );
}
