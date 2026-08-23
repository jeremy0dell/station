import type { MouseEvent } from "@opentui/core";
import { normalizeStationMouseEvent, type StationMouseEvent } from "../input/mouse.js";
import type { MouseTargetRef } from "../input/router.js";
import type { ContextMenuAnchor, ContextMenuItem } from "./types.js";
import { ContextMenuSurface } from "./ContextMenuSurface.js";

export type ContextMenuLayerProps = {
  terminalWidth: number;
  terminalHeight: number;
  anchor: ContextMenuAnchor;
  preferredWidth: number;
  items: readonly ContextMenuItem[];
  activeIndex: number;
  dispatchMouse: (target: MouseTargetRef, event: StationMouseEvent) => boolean;
};

export function ContextMenuLayer({
  terminalWidth,
  terminalHeight,
  anchor,
  preferredWidth,
  items,
  activeIndex,
  dispatchMouse,
}: ContextMenuLayerProps) {
  return (
    <box
      id="station-context-menu-boundary"
      position="absolute"
      left={0}
      top={0}
      width={terminalWidth}
      height={terminalHeight}
      zIndex={40}
      onMouseDown={(event: MouseEvent) => {
        event.stopPropagation();
        dispatchMouse({ kind: "contextMenuBackdrop" }, normalizeStationMouseEvent(event));
      }}
    >
      <ContextMenuSurface
        items={items}
        activeIndex={activeIndex}
        anchor={anchor}
        preferredWidth={preferredWidth}
        boundaryId="station-context-menu-boundary"
        dispatchMouse={dispatchMouse}
      />
    </box>
  );
}
