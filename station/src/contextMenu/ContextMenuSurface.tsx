import type { ColorInput, MouseEvent } from "@opentui/core";
import { Fragment } from "react";
import { normalizeStationMouseEvent, type StationMouseEvent } from "../input/mouse.js";
import type { MouseTargetRef } from "../input/router.js";
import { formatMenuRow } from "../menu/formatMenuRow.js";
import {
  visibleMenuItems,
  type VisibleMenuItem,
} from "../menu/visibleMenuItems.js";
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
  const visibleItems = visibleMenuItems(items, Math.max(0, height - 2));
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
      <ContextMenuSeparator width={contentWidth} />
      {visibleItems.map((entry) => (
        <Fragment key={entry.item.id}>
          {entry.item.separatorBefore === true ? (
            <ContextMenuSeparator width={contentWidth} />
          ) : null}
          <ContextMenuItemRow
            entry={entry}
            activeIndex={activeIndex}
            contentWidth={contentWidth}
            dispatchMouse={dispatchMouse}
          />
        </Fragment>
      ))}
      <ContextMenuSeparator width={contentWidth} />
    </box>
  );
}

function ContextMenuSeparator({ width }: { width: number }) {
  const theme = useStationTheme();
  return (
    <text fg={toOpenTuiColor(theme.contextMenu.border)}>{borderLine(width)}</text>
  );
}

function ContextMenuItemRow({
  entry,
  activeIndex,
  contentWidth,
  dispatchMouse,
}: {
  entry: VisibleMenuItem<ContextMenuItem>;
  activeIndex: number;
  contentWidth: number;
  dispatchMouse: ContextMenuSurfaceProps["dispatchMouse"];
}) {
  const theme = useStationTheme();
  const { item, itemIndex } = entry;
  const active = itemIndex === activeIndex;
  const disabled = item.disabled === true;
  const target = { kind: "contextMenuItem" as const, itemIndex };
  const hoverTarget = { kind: "contextMenuItemHover" as const, itemIndex };
  const content = formatMenuRow(item.label, item.shortcut, Math.max(0, contentWidth - 1));
  const onMouseDown = (event: MouseEvent): void => {
    event.stopPropagation();
    dispatchMouse(target, normalizeStationMouseEvent(event));
  };
  const onMouseMove = (event: MouseEvent): void => {
    event.stopPropagation();
    if (!active) dispatchMouse(hoverTarget, normalizeStationMouseEvent(event));
  };

  return (
    <box
      width="100%"
      height={1}
      backgroundColor={toOpenTuiOpaqueColor(
        active ? theme.contextMenu.selected : theme.contextMenu.surface,
      )}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
    >
      <text
        fg={menuRowColor(theme, item, disabled)}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
      >
        {`|${active ? "▸" : " "}${content}|`}
      </text>
    </box>
  );
}

function borderLine(width: number): string {
  return `+${"-".repeat(width)}+`;
}

function menuRowColor(theme: StationTheme, item: ContextMenuItem, disabled: boolean): ColorInput {
  if (disabled) {
    return toOpenTuiColor(theme.text.disabled);
  }
  return toOpenTuiColor(item.danger === true ? theme.status.danger : theme.text.menu);
}
