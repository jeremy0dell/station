import type { ColorInput, MouseEvent } from "@opentui/core";
import { normalizeStationMouseEvent, type StationMouseEvent } from "../input/mouse.js";
import type { MouseTargetRef } from "../input/router.js";
import {
  toOpenTuiColor,
  toOpenTuiOpaqueColor,
  useStationTheme,
  type StationTheme,
} from "../theme/index.js";
import type { ContextMenuItem } from "./types.js";

export type ContextMenuSurfaceProps = {
  items: readonly ContextMenuItem[];
  activeIndex: number;
  width: number;
  height: number;
  dispatchMouse: (target: MouseTargetRef, event: StationMouseEvent) => boolean;
};

export function ContextMenuSurface({
  items,
  activeIndex,
  width,
  height,
  dispatchMouse,
}: ContextMenuSurfaceProps) {
  const theme = useStationTheme();
  const contentWidth = Math.max(1, width - 2);
  const visibleRows = Math.max(0, height - 2);
  return (
    <box
      width={width}
      height={height}
      backgroundColor={toOpenTuiOpaqueColor(theme.contextMenu.surface)}
      flexDirection="column"
      overflow="hidden"
      onMouseDown={(event: MouseEvent) => {
        event.stopPropagation();
      }}
    >
      <text fg={toOpenTuiColor(theme.contextMenu.border)}>{borderLine(contentWidth)}</text>
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
            backgroundColor={toOpenTuiColor(
              active ? theme.contextMenu.selected : theme.contextMenu.surface,
            )}
            onMouseDown={onItemMouseDown}
            onMouseMove={onItemMouseMove}
          >
            <text
              fg={menuRowColor(theme, item, disabled)}
              onMouseDown={onItemMouseDown}
              onMouseMove={onItemMouseMove}
            >
              {`|${fitLabel(item.label, contentWidth)}|`}
            </text>
          </box>
        );
      })}
      <text fg={toOpenTuiColor(theme.contextMenu.border)}>{borderLine(contentWidth)}</text>
    </box>
  );
}

function borderLine(width: number): string {
  return `+${"-".repeat(width)}+`;
}

function menuRowColor(
  theme: StationTheme,
  item: ContextMenuItem,
  disabled: boolean,
): ColorInput {
  if (disabled) {
    return toOpenTuiColor(theme.text.disabled);
  }
  return toOpenTuiColor(item.danger === true ? theme.status.danger : theme.text.menu);
}

function fitLabel(label: string, width: number): string {
  if (label.length >= width) {
    return label.slice(0, width);
  }
  return ` ${label}`.padEnd(width, " ");
}
