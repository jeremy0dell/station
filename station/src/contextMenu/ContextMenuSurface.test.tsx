import { describe, expect, it } from "bun:test";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import type { MouseTargetRef } from "../input/router.js";
import type { StationMouseEvent } from "../input/mouse.js";
import type { ContextMenuItem } from "./types.js";
import { ContextMenuSurface } from "./ContextMenuSurface.js";

const ITEMS: readonly ContextMenuItem[] = [
  { id: "pane.splitRight", label: "Split Right", disabled: true, action: { kind: "noop" } },
  { id: "pane.splitBelow", label: "Split Below", disabled: true, action: { kind: "noop" } },
  { id: "pane.close", label: "Close Pane", action: { kind: "closePane", paneId: "pane-a" } },
];

describe("ContextMenuSurface", () => {
  it("renders menu labels inside a bounded surface", async () => {
    const setup = await renderSurface();
    try {
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Split Right");
      expect(frame).toContain("Split Below");
      expect(frame).toContain("Close Pane");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("routes item mouse targets with normalized click events", async () => {
    const calls: Array<{ target: MouseTargetRef; event: StationMouseEvent }> = [];
    const setup = await renderSurface((target, event) => {
      calls.push({ target, event });
      return true;
    });
    try {
      await setup.mockMouse.click(2, 3, MouseButtons.LEFT);
      expect(calls).toEqual([
        {
          target: { kind: "contextMenuItem", itemIndex: 2 },
          event: {
            type: "down",
            button: "left",
            rawButton: 0,
            x: 2,
            y: 3,
            modifiers: { shift: false, alt: false, ctrl: false },
          },
        },
      ]);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("routes item hover targets on mouse move", async () => {
    const calls: Array<{ target: MouseTargetRef; event: StationMouseEvent }> = [];
    const setup = await renderSurface((target, event) => {
      calls.push({ target, event });
      return true;
    });
    try {
      await setup.mockMouse.moveTo(2, 2);
      // Hover over the middle row highlights it (index 1) without selecting.
      expect(calls.at(-1)?.target).toEqual({ kind: "contextMenuItemHover", itemIndex: 1 });
      expect(calls.at(-1)?.event.type).toBe("move");
    } finally {
      setup.renderer.destroy();
    }
  });
});

async function renderSurface(
  dispatchMouse: (target: MouseTargetRef, event: StationMouseEvent) => boolean = () => true,
) {
  const setup = await testRender(
    <ContextMenuSurface
      items={ITEMS}
      activeIndex={2}
      width={18}
      height={5}
      dispatchMouse={dispatchMouse}
    />,
    { width: 24, height: 8 },
  );
  await setup.flush();
  return setup;
}
