import { afterEach, describe, expect, it } from "bun:test";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import type { StationMouseEvent } from "../input/mouse.js";
import type { MouseTargetRef } from "../input/router.js";
import { makeStationTestStore } from "./test/support/makeStationTestStore.js";
import { StationOverlay, stationPopupLayout } from "./StationOverlay.js";

const SURFACE = { width: 100, height: 28 };
const teardowns: Array<() => void> = [];

describe("StationOverlay", () => {
  afterEach(() => {
    for (const teardown of teardowns.splice(0)) {
      teardown();
    }
  });

  it("routes primary clicks outside the popup through the STATION backdrop target", async () => {
    const calls: Array<{ target: MouseTargetRef; event: StationMouseEvent }> = [];
    const setup = await renderOverlay((target, event) => {
      calls.push({ target, event });
      return true;
    });
    const layout = stationPopupLayout(SURFACE.width, SURFACE.height);

    await setup.mockMouse.click(layout.left - 1, layout.top - 1, MouseButtons.LEFT);

    expect(calls).toEqual([
      {
        target: { kind: "stationBackdrop" },
        event: {
          type: "down",
          button: "left",
          rawButton: 0,
          x: layout.left - 1,
          y: layout.top - 1,
          modifiers: { shift: false, alt: false, ctrl: false },
        },
      },
    ]);
  });

  it("routes right-clicks outside the popup through the STATION backdrop target", async () => {
    const calls: Array<{ target: MouseTargetRef; event: StationMouseEvent }> = [];
    const setup = await renderOverlay((target, event) => {
      calls.push({ target, event });
      return true;
    });
    const layout = stationPopupLayout(SURFACE.width, SURFACE.height);

    await setup.mockMouse.click(layout.left - 1, layout.top - 1, MouseButtons.RIGHT);

    expect(calls[0]).toMatchObject({
      target: { kind: "stationBackdrop" },
      event: { type: "down", button: "right", rawButton: 2 },
    });
  });

  it("routes wheel outside the popup through the STATION backdrop target", async () => {
    const calls: Array<{ target: MouseTargetRef; event: StationMouseEvent }> = [];
    const setup = await renderOverlay((target, event) => {
      calls.push({ target, event });
      return true;
    });
    const layout = stationPopupLayout(SURFACE.width, SURFACE.height);

    await setup.mockMouse.scroll(layout.left - 1, layout.top - 1, "down");

    expect(calls[0]).toMatchObject({
      target: { kind: "stationBackdrop" },
      event: { type: "scroll", button: "wheel-down", scrollDirection: "down" },
    });
  });

  it("does not route popup border clicks as backdrop clicks", async () => {
    const calls: Array<{ target: MouseTargetRef; event: StationMouseEvent }> = [];
    const setup = await renderOverlay((target, event) => {
      calls.push({ target, event });
      return true;
    });
    const layout = stationPopupLayout(SURFACE.width, SURFACE.height);

    await setup.mockMouse.click(layout.left, layout.top, MouseButtons.LEFT);

    expect(calls).toEqual([]);
  });

  it("keeps existing STATION child mouse targets inside the popup", async () => {
    const calls: Array<{ target: MouseTargetRef; event: StationMouseEvent }> = [];
    const setup = await renderOverlay((target, event) => {
      calls.push({ target, event });
      return true;
    });
    const frame = setup.captureCharFrame();
    const lines = frame.split("\n");
    // Exclude the pinned FLEET bar (which also contains "working") so we target
    // an actual working session row.
    const row = lines.findIndex((line) => line.includes("working") && !line.includes("FLEET"));
    const col = lines[row]?.indexOf("working") ?? -1;
    expect(row).toBeGreaterThan(0);
    expect(col).toBeGreaterThan(0);

    await setup.mockMouse.click(col, row, MouseButtons.LEFT);

    expect(calls.at(-1)?.target).toEqual({
      kind: "station",
      target: { kind: "row", rowId: "ses_wt_station_working" },
    });
  });
});

async function renderOverlay(
  dispatchMouse: (target: MouseTargetRef, event: StationMouseEvent) => boolean = () => true,
) {
  const { store } = makeStationTestStore();
  const setup = await testRender(
    <StationOverlay store={store} dispatchMouse={dispatchMouse} />,
    SURFACE,
  );
  await setup.flush();
  teardowns.push(() => setup.renderer.destroy());
  return setup;
}
