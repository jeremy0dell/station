import type { MouseEvent } from "@opentui/core";
import { normalizeStationMouseEvent, type StationMouseEvent } from "../input/mouse.js";
import type { MouseTargetRef } from "../input/router.js";
import type { ContextMenuPlacement } from "./placement.js";
import type { ContextMenuItem } from "./types.js";
import { ContextMenuSurface } from "./ContextMenuSurface.js";

export type ContextMenuLayerProps = {
  terminalWidth: number;
  terminalHeight: number;
  placement: ContextMenuPlacement;
  items: readonly ContextMenuItem[];
  activeIndex: number;
  dispatchMouse: (target: MouseTargetRef, event: StationMouseEvent) => boolean;
};

export function ContextMenuLayer({
  terminalWidth,
  terminalHeight,
  placement,
  items,
  activeIndex,
  dispatchMouse,
}: ContextMenuLayerProps) {
  return (
    <box
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
      <box position="absolute" left={placement.left} top={placement.top} zIndex={41}>
        <ContextMenuSurface
          items={items}
          activeIndex={activeIndex}
          width={placement.width}
          height={placement.height}
          dispatchMouse={dispatchMouse}
        />
      </box>
    </box>
  );
}
