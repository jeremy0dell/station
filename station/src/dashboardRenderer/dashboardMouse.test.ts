import { describe, expect, it } from "bun:test";
import { dashboardRowIds } from "@station/dashboard-core/selectors";
import type { StationMouseEvent } from "../input/mouse.js";
import { makeStationTestRuntime } from "../station/test/support/makeStationTestRuntime.js";
import { routeDashboardMouse } from "./dashboardMouse.js";

const LEFT_DOWN: StationMouseEvent = {
  type: "down",
  button: "left",
  rawButton: 0,
  x: 10,
  y: 5,
  modifiers: { shift: false, alt: false, ctrl: false },
};

describe("routeDashboardMouse", () => {
  it("forwards Station targets to the shared router", () => {
    const { runtime } = makeStationTestRuntime();

    routeDashboardMouse(
      {
        kind: "dashboardCell",
        rowId: dashboardRowIds.project("station"),
        cellId: "identity",
      },
      LEFT_DOWN,
      runtime,
      () => {},
    );

    expect([...runtime.state.getState().collapsedProjectIds]).toEqual(["station"]);
  });

  it("sends shared open-url outcomes to the supplied callback", () => {
    const { runtime } = makeStationTestRuntime();
    const opened: string[] = [];

    routeDashboardMouse(
      { kind: "link", url: "https://example.com/docs" },
      LEFT_DOWN,
      runtime,
      (url) => opened.push(url),
    );

    expect(opened).toEqual(["https://example.com/docs"]);
  });
});
