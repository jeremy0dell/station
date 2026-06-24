import { describe, expect, it } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { DynamicStationButton } from "./DynamicStationButton.js";
import { ANIM_MS, STATION_ICON } from "./layout.js";

// OpenTUI's reconciler commits async layout updates outside React's act(),
// matching the StationApp integration test's stance for these render checks.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

const SURFACE = { width: 40, height: 12 };

async function captureFrame(node: Parameters<typeof testRender>[0]): Promise<string> {
  const setup = await testRender(node, SURFACE);
  try {
    await setup.flush();
    return setup.captureCharFrame();
  } finally {
    setup.renderer.destroy();
  }
}

describe("DynamicStationButton", () => {
  it("collapsed base shows only the station icon", async () => {
    const frame = await captureFrame(
      <DynamicStationButton attention={false} workingCount={2} idleCount={14} />,
    );
    expect(frame).toContain(STATION_ICON);
    expect(frame).not.toContain("session");
  });

  it("collapsed attention frames the icon with exclamation marks", async () => {
    const frame = await captureFrame(
      <DynamicStationButton attention={true} workingCount={0} idleCount={0} sessionName="hook-scope" />,
    );
    expect(frame).toContain(STATION_ICON);
    // Framed alert: solid "!" rows top and bottom around the centered icon.
    expect(frame).toContain("!!!!");
    expect(frame).not.toContain("needs user");
  });

  it("expanded base shows the working/idle summary", async () => {
    const frame = await captureFrame(
      <DynamicStationButton attention={false} workingCount={2} idleCount={14} hovered />,
    );
    expect(frame).toContain(STATION_ICON);
    expect(frame).toContain("2 sessions working");
    expect(frame).toContain("14 sessions idle");
  });

  it("expanded attention shows the session name and intervention message", async () => {
    const frame = await captureFrame(
      <DynamicStationButton
        attention={true}
        workingCount={0}
        idleCount={0}
        sessionName="hook-scope"
        hovered
      />,
    );
    expect(frame).toContain("hook-scope");
    expect(frame).toContain("needs your attention");
    expect(frame).toContain("click to focus");

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

  it("switches the mouse pointer to a hand on hover and back on leave", async () => {
    const setup = await testRender(
      <DynamicStationButton attention={false} workingCount={1} idleCount={2} />,
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
