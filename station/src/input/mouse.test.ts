import type { MouseEvent } from "@opentui/core";
import { describe, expect, it } from "bun:test";
import { isPrimaryMouseEvent, isRightMouseEvent, normalizeStationMouseEvent } from "./mouse.js";

describe("normalizeStationMouseEvent", () => {
  it("normalizes right-click coordinates and modifiers", () => {
    const event = normalizeStationMouseEvent(
      opentuiMouse({ type: "down", button: 2, x: 12, y: 7, modifiers: { shift: true } }),
    );

    expect(event).toEqual({
      type: "down",
      button: "right",
      rawButton: 2,
      x: 12,
      y: 7,
      modifiers: { shift: true, alt: false, ctrl: false },
    });
    expect(isRightMouseEvent(event)).toBe(true);
    expect(isPrimaryMouseEvent(event)).toBe(false);
  });

  it("preserves scroll direction", () => {
    const event = normalizeStationMouseEvent(
      opentuiMouse({ type: "scroll", button: 5, scroll: { direction: "down", delta: 1 } }),
    );

    expect(event.button).toBe("wheel-down");
    expect(event.scrollDirection).toBe("down");
  });
});

function opentuiMouse(
  overrides: Partial<Omit<MouseEvent, "modifiers">> & {
    type: MouseEvent["type"];
    button: number;
    modifiers?: Partial<MouseEvent["modifiers"]>;
  },
): MouseEvent {
  const modifiers = {
    shift: overrides.modifiers?.shift ?? false,
    alt: overrides.modifiers?.alt ?? false,
    ctrl: overrides.modifiers?.ctrl ?? false,
  };
  return {
    x: 1,
    y: 1,
    ...overrides,
    modifiers,
  } as MouseEvent;
}
