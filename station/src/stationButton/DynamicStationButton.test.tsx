import { describe, expect, it } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { useState } from "react";
import { DynamicStationButton } from "./DynamicStationButton.js";
import {
  ANIM_MS,
  FRAME_MS,
  type IslandCelebration,
  type IslandDisplayInput,
  islandDisplay,
  STATION_ICON,
  targetDims,
} from "./layout.js";
import type { StationButtonStatus } from "./status.js";

// OpenTUI's reconciler commits async layout updates outside React's act(),
// matching the StationApp integration test's stance for these render checks.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

const SURFACE = { width: 40, height: 12 };

const CALM_STATUS: StationButtonStatus = {
  attention: false,
  needsYouCount: 0,
  workingCount: 0,
  readyCount: 0,
  idleCount: 0,
};

function input(
  status: Partial<StationButtonStatus> = {},
  extra: Omit<IslandDisplayInput, "status"> = {},
): IslandDisplayInput {
  return { status: { ...CALM_STATUS, ...status }, ...extra };
}

async function captureFrame(node: Parameters<typeof testRender>[0]): Promise<string> {
  const setup = await testRender(node, SURFACE);
  try {
    await setup.flush();
    return setup.captureCharFrame();
  } finally {
    setup.renderer.destroy();
  }
}

function renderedButtonWidth(frame: string): number {
  const top = frame.split("\n")[0] ?? "";
  const left = top.indexOf("╭");
  const right = top.indexOf("╮", left + 1);
  if (left < 0 || right < 0) {
    throw new Error("Station button border was not rendered.");
  }
  return right - left + 1;
}

describe("DynamicStationButton", () => {
  it("collapsed base shows only the station icon", async () => {
    const frame = await captureFrame(
      <DynamicStationButton input={input({ workingCount: 2, idleCount: 14 })} />,
    );
    expect(frame).toContain(STATION_ICON);
    expect(frame).not.toContain("session");
  });

  it("collapsed attention frames the icon with exclamation marks", async () => {
    const frame = await captureFrame(
      <DynamicStationButton
        input={input({ attention: true, needsYouCount: 1, sessionName: "hook-scope" })}
      />,
    );
    expect(frame).toContain(STATION_ICON);
    // Framed alert: solid "!" rows top and bottom around the centered icon.
    expect(frame).toContain("!!!!");
    expect(frame).not.toContain("needs user");
  });

  it("collapsed rest counts paint working without zero or idle lanes", async () => {
    const frame = await captureFrame(
      <DynamicStationButton
        input={input({ workingCount: 2, idleCount: 6 }, { restCounts: true })}
      />,
    );
    expect(frame).toContain(STATION_ICON);
    expect(frame).toContain("2");
    expect(frame).not.toContain("●");
    expect(frame).not.toContain("○");
    expect(frame).not.toContain("0");
    expect(frame).not.toContain("session");
  });

  it("collapsed rest counts paint ready without working or idle lanes", async () => {
    const frame = await captureFrame(
      <DynamicStationButton input={input({ readyCount: 1, idleCount: 6 }, { restCounts: true })} />,
    );
    expect(frame).toContain(STATION_ICON);
    expect(frame).toContain("●1");
    expect(frame).not.toContain("⠿0");
    expect(frame).not.toContain("○");
    expect(frame).not.toContain("session");
  });

  it("collapsed rest counts fall back to the glyph for zero or idle-only counts", async () => {
    const zeroFrame = await captureFrame(
      <DynamicStationButton input={input({}, { restCounts: true })} />,
    );
    const idleFrame = await captureFrame(
      <DynamicStationButton input={input({ idleCount: 6 }, { restCounts: true })} />,
    );

    expect(zeroFrame).toContain(STATION_ICON);
    expect(zeroFrame).not.toContain("0");
    expect(zeroFrame).not.toContain("○");
    expect(idleFrame).toContain(STATION_ICON);
    expect(idleFrame).not.toContain("○6");
    expect(idleFrame).not.toContain("●");
  });

  it("collapsed celebration announces the merged PR", async () => {
    const frame = await captureFrame(
      <DynamicStationButton input={input({ idleCount: 3 }, { celebration: { prNumber: 42 } })} />,
    );
    expect(frame).toContain(STATION_ICON);
    expect(frame).toContain("✓ #42 merged");
  });

  it("tweens the merged notification in and out", async () => {
    let updateCelebration: ((value: IslandCelebration | undefined) => void) | undefined;
    function Harness() {
      const [celebration, setCelebration] = useState<IslandCelebration>();
      updateCelebration = setCelebration;
      return <DynamicStationButton input={input({ idleCount: 3 }, { celebration })} />;
    }

    const restingWidth = targetDims(islandDisplay(input({ idleCount: 3 }), false)).width;
    const notifiedWidth = targetDims(
      islandDisplay(input({ idleCount: 3 }, { celebration: { prNumber: 42 } }), false),
    ).width;
    const setup = await testRender(<Harness />, SURFACE);
    try {
      await setup.flush();
      const setCelebration = updateCelebration;
      if (setCelebration === undefined) {
        throw new Error("Celebration harness did not mount.");
      }
      const waitForWidth = async (predicate: (width: number) => boolean): Promise<number> => {
        const deadline = Date.now() + ANIM_MS * 4;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, FRAME_MS));
          await setup.renderOnce();
          const width = renderedButtonWidth(setup.captureCharFrame());
          if (predicate(width)) {
            return width;
          }
        }
        throw new Error("Station button did not reach the expected animated width.");
      };

      setCelebration({ prNumber: 42 });
      const openingWidth = await waitForWidth(
        (width) => width > restingWidth && width < notifiedWidth,
      );
      expect(openingWidth).toBeGreaterThan(restingWidth);
      await waitForWidth((width) => width === notifiedWidth);
      expect(setup.captureCharFrame()).toContain("✓ #42 merged");

      setCelebration(undefined);
      const closingWidth = await waitForWidth(
        (width) => width > restingWidth && width < notifiedWidth,
      );
      expect(closingWidth).toBeLessThan(notifiedWidth);
      await waitForWidth((width) => width === restingWidth);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await setup.renderOnce();
      expect(setup.captureCharFrame()).not.toContain("#42");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("attention wins over the celebration", async () => {
    const frame = await captureFrame(
      <DynamicStationButton
        input={input(
          { attention: true, needsYouCount: 1, sessionName: "hook-scope" },
          { celebration: { prNumber: 42 } },
        )}
      />,
    );
    expect(frame).toContain("!!!!");
    expect(frame).not.toContain("#42");
  });

  it("expanded base shows the working/idle summary", async () => {
    const frame = await captureFrame(
      <DynamicStationButton input={input({ workingCount: 2, readyCount: 5, idleCount: 9 })} hovered />,
    );
    expect(frame).toContain(STATION_ICON);
    expect(frame).toContain("2 sessions working");
    // Ready sessions read as idle in the totals card (5 ready + 9 idle).
    expect(frame).toContain("14 sessions idle");
  });

  it("expanded roll-up lists each project's worst status and folds the rest", async () => {
    const projects = [
      { projectId: "p1", name: "station", status: "needsYou" as const },
      { projectId: "p2", name: "docs", status: "idle" as const },
      { projectId: "p3", name: "web", status: "ready" as const },
      { projectId: "p4", name: "cli", status: "idle" as const },
      { projectId: "p5", name: "api", status: "idle" as const },
      { projectId: "p6", name: "infra", status: "idle" as const },
      { projectId: "p7", name: "tools", status: "idle" as const },
    ];
    const frame = await captureFrame(
      <DynamicStationButton input={input({ projectRollup: projects })} hovered />,
    );
    expect(frame).toContain("! station");
    expect(frame).toContain("○ docs");
    expect(frame).toContain("● web");
    expect(frame).toContain("+2 more");
    expect(frame).not.toContain("tools");
    expect(frame).not.toContain("sessions working");
  });

  it("expanded attention shows the session name and intervention message", async () => {
    const frame = await captureFrame(
      <DynamicStationButton
        input={input({ attention: true, needsYouCount: 1, sessionName: "hook-scope" })}
        hovered
      />,
    );
    expect(frame).toContain("hook-scope");
    expect(frame).toContain("needs your attention");
    expect(frame).toContain("↵ or click to focus");

    const lines = frame.split("\n");
    const [topBorder, iconRow, titleRow] = lines;
    const buttonLeft = topBorder.indexOf("╭");
    expect(buttonLeft).toBeGreaterThanOrEqual(0);
    expect(iconRow.slice(buttonLeft)).toContain(STATION_ICON);
    expect(iconRow.slice(buttonLeft)).not.toContain("hook-scope");
    expect(titleRow.slice(buttonLeft)).toContain("hook-scope");
    const bottomBorder = lines.findIndex((line) => line.slice(buttonLeft).startsWith("╰"));
    expect(bottomBorder).toBeGreaterThan(0);
    expect(lines[bottomBorder - 1]?.slice(buttonLeft).replace(/[│ ]/g, "")).toBe("");
  });

  it("expanded attention shows the queue when several sessions ask", async () => {
    const frame = await captureFrame(
      <DynamicStationButton
        input={input({ attention: true, needsYouCount: 3, sessionName: "hook-scope" })}
        hovered
      />,
    );
    expect(frame).toContain("! 3 need you ›");
    expect(frame).not.toContain("needs your attention");
  });

  it("switches the mouse pointer to a hand on hover and back on leave", async () => {
    const setup = await testRender(
      <DynamicStationButton input={input({ workingCount: 1, idleCount: 2 })} />,
      SURFACE,
    );
    try {
      await setup.flush();
      const calls: string[] = [];
      const real = setup.renderer.setMousePointer.bind(setup.renderer);
      setup.renderer.setMousePointer = ((shape: string) => {
        calls.push(shape);
        real(shape as Parameters<typeof real>[0]);
      }) as typeof setup.renderer.setMousePointer;
      // Top-right cell sits inside the button (anchored top={0} right={0}).
      await setup.mockMouse.moveTo(SURFACE.width - 1, 0);
      expect(calls).toContain("pointer");
      await new Promise((resolve) => setTimeout(resolve, ANIM_MS + 30));
      await setup.renderOnce();
      // Moving over the expanded text must keep the hand cursor; child hit
      // targets change during the grow animation.
      await setup.mockMouse.moveTo(SURFACE.width - 18, 2);
      expect(calls.at(-1)).toBe("pointer");
      expect(calls).not.toContain("default");
      // Move off the button (bottom-left of the surface).
      await setup.mockMouse.moveTo(0, SURFACE.height - 1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(calls.at(-1)).toBe("default");
    } finally {
      setup.renderer.destroy();
    }
  });
});
