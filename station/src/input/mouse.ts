import type { MouseEvent } from "@opentui/core";

export type StationMouseButton =
  | "left"
  | "middle"
  | "right"
  | "wheel-up"
  | "wheel-down"
  | "unknown";

export type StationMouseEvent = {
  type: MouseEvent["type"];
  button: StationMouseButton;
  rawButton: number;
  x: number;
  y: number;
  modifiers: {
    shift: boolean;
    alt: boolean;
    ctrl: boolean;
  };
  scrollDirection?: "up" | "down" | "left" | "right";
};

export function normalizeStationMouseEvent(event: MouseEvent): StationMouseEvent {
  const normalized: StationMouseEvent = {
    type: event.type,
    button: normalizeButton(event),
    rawButton: event.button,
    x: event.x,
    y: event.y,
    modifiers: {
      shift: event.modifiers.shift,
      alt: event.modifiers.alt,
      ctrl: event.modifiers.ctrl,
    },
  };
  if (event.scroll?.direction !== undefined) {
    normalized.scrollDirection = event.scroll.direction;
  }
  return normalized;
}

export function isRightMouseEvent(event: StationMouseEvent): boolean {
  return event.type === "down" && event.button === "right";
}

export function isPrimaryMouseEvent(event: StationMouseEvent): boolean {
  return event.type === "down" && event.button === "left";
}

/** Vertical wheel direction for a scroll event, or null for anything else. */
export function wheelDirection(event: StationMouseEvent): "up" | "down" | null {
  if (event.type !== "scroll") {
    return null;
  }
  if (event.scrollDirection === "up" || event.button === "wheel-up") {
    return "up";
  }
  if (event.scrollDirection === "down" || event.button === "wheel-down") {
    return "down";
  }
  return null;
}

function normalizeButton(event: MouseEvent): StationMouseButton {
  if (event.type === "scroll") {
    switch (event.scroll?.direction) {
      case "up":
        return "wheel-up";
      case "down":
        return "wheel-down";
      default:
        return "unknown";
    }
  }
  switch (event.button) {
    case 0:
      return "left";
    case 1:
      return "middle";
    case 2:
      return "right";
    case 4:
      return "wheel-up";
    case 5:
      return "wheel-down";
    default:
      return "unknown";
  }
}
