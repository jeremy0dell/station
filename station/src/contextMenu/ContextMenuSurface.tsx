import type { ColorInput, MouseEvent } from "@opentui/core";
import { Fragment } from "react";
import { normalizeStationMouseEvent, type StationMouseEvent } from "../input/mouse.js";
import type { MouseTargetRef } from "../input/router.js";
import { SemanticScrollRegion } from "../station/view/layout/scroll/SemanticScrollViewport.js";
import { semanticItemRenderableId } from "../station/view/layout/scroll/scrollViewport.js";
import { semanticItemIdAtPointer } from "../station/view/layout/semanticPointerTarget.js";
import {
  toOpenTuiColor,
  toOpenTuiOpaqueColor,
  useStationTheme,
  type StationTheme,
} from "../theme/index.js";
import { resolveContextMenuActiveItem } from "./selection.js";
import type { ContextMenuAnchor, ContextMenuItem, ContextMenuItemId } from "./types.js";
import { usePointerAnchoredMenuPlacement } from "./usePointerAnchoredMenuPlacement.js";

const CONTEXT_MENU_VIEWPORT_ID = "station-context-menu-items";

export function contextMenuItemRenderableId(itemId: string): string {
  return semanticItemRenderableId(itemId);
}

export type ContextMenuSurfaceProps = {
  items: readonly ContextMenuItem[];
  activeItemId: ContextMenuItemId | undefined;
  anchor: ContextMenuAnchor;
  preferredWidth: number;
  boundaryId: string;
  dispatchMouse: (target: MouseTargetRef, event: StationMouseEvent) => boolean;
};

export function ContextMenuSurface({
  items,
  activeItemId,
  anchor,
  preferredWidth,
  boundaryId,
  dispatchMouse,
}: ContextMenuSurfaceProps) {
  const theme = useStationTheme();
  const surfaceRef = usePointerAnchoredMenuPlacement({
    boundaryId,
    anchor,
    contentViewportId: CONTEXT_MENU_VIEWPORT_ID,
    preferredWidth,
  });
  const itemIds = items.map((item) => item.id);
  const followedItemId = resolveContextMenuActiveItem(items, activeItemId)?.id;
  const dispatchPointer = (
    event: MouseEvent,
    kind: "contextMenuItem" | "contextMenuItemHover",
  ): void => {
    event.stopPropagation();
    const itemId = semanticItemIdAtPointer(
      surfaceRef.current,
      CONTEXT_MENU_VIEWPORT_ID,
      itemIds,
      event.x,
      event.y,
    );
    if (itemId === undefined || (kind === "contextMenuItemHover" && itemId === followedItemId)) {
      return;
    }
    dispatchMouse({ kind, itemId }, normalizeStationMouseEvent(event));
  };
  return (
    <box
      id="station-context-menu-surface"
      ref={surfaceRef}
      position="absolute"
      left={anchor.x}
      top={anchor.y + 1}
      width={preferredWidth}
      maxWidth="100%"
      border
      borderColor={toOpenTuiColor(theme.contextMenu.border)}
      backgroundColor={toOpenTuiOpaqueColor(theme.contextMenu.surface)}
      flexDirection="column"
      overflow="hidden"
      onMouseDown={(event: MouseEvent) => {
        dispatchPointer(event, "contextMenuItem");
      }}
      onMouseMove={(event: MouseEvent) => {
        dispatchPointer(event, "contextMenuItemHover");
      }}
    >
      <SemanticScrollRegion
        itemIds={itemIds}
        followedItemId={followedItemId}
        fill={false}
        viewportId={CONTEXT_MENU_VIEWPORT_ID}
      >
        {items.map((item) => (
          <Fragment key={item.id}>
            {item.separatorBefore === true ? <ContextMenuSeparator /> : null}
            <ContextMenuItemRow
              item={item}
              active={item.id === followedItemId}
            />
          </Fragment>
        ))}
      </SemanticScrollRegion>
    </box>
  );
}

function ContextMenuSeparator() {
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

function ContextMenuItemRow({
  item,
  active,
}: {
  item: ContextMenuItem;
  active: boolean;
}) {
  const theme = useStationTheme();
  const disabled = item.disabled === true;

  return (
    <box
      id={contextMenuItemRenderableId(item.id)}
      width="100%"
      flexDirection="row"
      backgroundColor={toOpenTuiOpaqueColor(
        active ? theme.contextMenu.selected : theme.contextMenu.surface,
      )}
    >
      <text flexShrink={0} fg={menuRowColor(theme, item, disabled)}>
        {active ? "▸" : " "}
      </text>
      <box
        flexGrow={1}
        flexShrink={1}
        minWidth={0}
        overflow="hidden"
      >
        <text fg={menuRowColor(theme, item, disabled)}>
          {item.label}
        </text>
      </box>
      {item.shortcut === undefined ? null : (
        <text
          flexShrink={0}
          fg={menuRowColor(theme, item, disabled)}
        >
          {` ${item.shortcut}`}
        </text>
      )}
    </box>
  );
}

function menuRowColor(theme: StationTheme, item: ContextMenuItem, disabled: boolean): ColorInput {
  if (disabled) {
    return toOpenTuiColor(theme.text.disabled);
  }
  return toOpenTuiColor(item.danger === true ? theme.status.danger : theme.text.menu);
}
