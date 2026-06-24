import { describe, expect, it } from "bun:test";
import { rgbToHex } from "@opentui/core";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import type { StationMouseEvent } from "../input/mouse.js";
import type { MouseTargetRef } from "../input/router.js";
import { spanAtFrameCell } from "../terminal/testing/frameProbe.js";
import { WelcomeScreen, WELCOME_BUTTON_SHIMMER_BG } from "./WelcomeScreen.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

const SURFACE = { width: 88, height: 28 };

describe("WelcomeScreen", () => {
  it("renders the full station banner without repeating station below the wordmark", async () => {
    const setup = await renderWelcomeScreen();
    try {
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Welcome to");
      expect(frame).toContain("Open project view");
      expect(hasStandaloneStationLine(frame)).toBe(false);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("routes the CTA through the welcome project-view mouse target", async () => {
    const calls: Array<{ target: MouseTargetRef; event: StationMouseEvent }> = [];
    const setup = await renderWelcomeScreen((target, event) => {
      calls.push({ target, event });
      return true;
    });
    try {
      const { row, col } = labelCell(setup.captureCharFrame());
      await setup.mockMouse.click(col, row, MouseButtons.LEFT);
      expect(calls).toEqual([
        {
          target: { kind: "welcomeOpenProjectView" },
          event: {
            type: "down",
            button: "left",
            rawButton: 0,
            x: col,
            y: row,
            modifiers: { shift: false, alt: false, ctrl: false },
          },
        },
      ]);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("shows both CTAs when restored sessions can be continued", async () => {
    const setup = await testRender(
      <WelcomeScreen dispatchMouse={() => true} canContinue />,
      SURFACE,
    );
    await setup.flush();
    try {
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Continue");
      expect(frame).toContain("Open project view");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("paints a shimmer band on CTA hover", async () => {
    const setup = await renderWelcomeScreen();
    try {
      const { row, col } = labelCell(setup.captureCharFrame());
      await setup.mockMouse.moveTo(col, row);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await setup.renderOnce();

      const spans = setup.captureSpans();
      const line = setup.captureCharFrame().split("\n")[row] ?? "";
      const backgrounds = new Set<string>();
      for (let index = 0; index < line.length; index += 1) {
        const bg = spanAtFrameCell(spans, row, index)?.bg;
        if (bg !== undefined) {
          backgrounds.add(rgbToHex(bg as Parameters<typeof rgbToHex>[0]));
        }
      }
      expect(backgrounds.has(WELCOME_BUTTON_SHIMMER_BG)).toBe(true);
    } finally {
      setup.renderer.destroy();
    }
  });
});

async function renderWelcomeScreen(
  dispatchMouse: (target: MouseTargetRef, event: StationMouseEvent) => boolean = () => true,
) {
  const setup = await testRender(<WelcomeScreen dispatchMouse={dispatchMouse} />, SURFACE);
  await setup.flush();
  return setup;
}

function labelCell(frame: string): { row: number; col: number } {
  const lines = frame.split("\n");
  const row = lines.findIndex((line) => line.includes("Open project view"));
  const col = lines[row]?.indexOf("Open project view") ?? -1;
  if (row < 0 || col < 0) {
    throw new Error(`welcome button label not found:\n${frame}`);
  }
  return { row, col };
}

function hasStandaloneStationLine(frame: string): boolean {
  return frame.split("\n").some((line) => line.trim() === "station");
}
