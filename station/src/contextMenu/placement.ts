import stringWidth from "string-width";
import type { ContextMenuAnchor, ContextMenuItem } from "./types.js";

export type ContextMenuSize = {
  width: number;
  height: number;
};

export type TerminalBounds = {
  width: number;
  height: number;
};

export type ContextMenuPlacement = ContextMenuSize & {
  left: number;
  top: number;
};

const HORIZONTAL_PADDING = 2;
const BORDER_CELLS = 2;

export function measureContextMenu(items: readonly ContextMenuItem[]): ContextMenuSize {
  const labelWidth = Math.max(1, ...items.map((item) => stringWidth(item.label)));
  return {
    width: labelWidth + HORIZONTAL_PADDING + BORDER_CELLS,
    height: Math.max(1, items.length + BORDER_CELLS),
  };
}

export function placeContextMenu(
  anchor: ContextMenuAnchor,
  menu: ContextMenuSize,
  bounds: TerminalBounds,
): ContextMenuPlacement {
  const width = clampDimension(menu.width, bounds.width);
  const height = clampDimension(menu.height, bounds.height);
  let left = anchor.x;
  let top = anchor.y + 1;

  if (top + height > bounds.height) {
    top = anchor.y - height;
  }
  if (left + width > bounds.width) {
    left = bounds.width - width;
  }

  return {
    left: clamp(left, 0, Math.max(0, bounds.width - width)),
    top: clamp(top, 0, Math.max(0, bounds.height - height)),
    width,
    height,
  };
}

function clampDimension(value: number, bound: number): number {
  return Math.max(1, Math.min(value, Math.max(1, bound)));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
