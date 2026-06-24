import type { MouseEvent } from "@opentui/core";
import { normalizeStationMouseEvent, type StationMouseEvent } from "../input/mouse.js";
import type { MouseTargetRef } from "../input/router.js";
import type { ContextMenuItem } from "./types.js";

export type ContextMenuSurfaceProps = {
  items: readonly ContextMenuItem[];
  activeIndex: number;
  width: number;
  height: number;
  dispatchMouse: (target: MouseTargetRef, event: StationMouseEvent) => boolean;
};

const MENU_BACKGROUND = "#15191e";
const ROW_ACTIVE = "#2f3842";
const ROW_TEXT = "#f4f4f5";
const ROW_DISABLED = "#7a828c";
const ROW_DANGER = "#fca5a5";
const BORDER_TEXT = "#5b6470";

export function ContextMenuSurface({
  items,
  activeIndex,
  width,
  height,
  dispatchMouse,
}: ContextMenuSurfaceProps) {
  const contentWidth = Math.max(1, width - 2);
  const visibleRows = Math.max(0, height - 2);
  return (
    <box
      width={width}
      height={height}
      backgroundColor={MENU_BACKGROUND}
      flexDirection="column"
      overflow="hidden"
      onMouseDown={(event: MouseEvent) => {
        event.stopPropagation();
      }}
    >
      <text fg={BORDER_TEXT}>{borderLine(contentWidth)}</text>
      {items.slice(0, visibleRows).map((item, index) => {
        const active = index === activeIndex;
        const disabled = item.disabled === true;
        const onItemMouseDown = (event: MouseEvent): void => {
          event.stopPropagation();
          dispatchMouse(
            { kind: "contextMenuItem", itemIndex: index },
            normalizeStationMouseEvent(event),
          );
        };
        // Hovering a row highlights it, matching keyboard arrow navigation;
        // without this the highlight only ever tracks the keyboard. Skip the
        // already-active row so a stream of same-row moves allocates nothing.
        const onItemMouseMove = (event: MouseEvent): void => {
          event.stopPropagation();
          if (active) {
            return;
          }
          dispatchMouse(
            { kind: "contextMenuItemHover", itemIndex: index },
            normalizeStationMouseEvent(event),
          );
        };
        return (
          <box
            key={item.id}
            width="100%"
            height={1}
            backgroundColor={active ? ROW_ACTIVE : MENU_BACKGROUND}
            onMouseDown={onItemMouseDown}
            onMouseMove={onItemMouseMove}
          >
            <text fg={rowColor(item, disabled)} onMouseDown={onItemMouseDown} onMouseMove={onItemMouseMove}>
              {`|${fitLabel(item.label, contentWidth)}|`}
            </text>
          </box>
        );
      })}
      <text fg={BORDER_TEXT}>{borderLine(contentWidth)}</text>
    </box>
  );
}

function borderLine(width: number): string {
  return `+${"-".repeat(width)}+`;
}

function rowColor(item: ContextMenuItem, disabled: boolean): string {
  if (disabled) {
    return ROW_DISABLED;
  }
  return item.danger === true ? ROW_DANGER : ROW_TEXT;
}

function fitLabel(label: string, width: number): string {
  if (label.length >= width) {
    return label.slice(0, width);
  }
  return ` ${label}`.padEnd(width, " ");
}
