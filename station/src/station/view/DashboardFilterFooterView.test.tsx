import { afterEach, describe, expect, it } from "bun:test";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import type { DashboardFilterFooterSegment } from "@station/dashboard-core";
import { act } from "react";
import { nativeStationTheme, StationThemeProvider } from "../../theme/index.js";
import type { StationMouseTarget } from "../input/stationMouse.js";
import { DashboardFilterFooterView } from "./DashboardFilterFooterView.js";
import { StationMouseProvider } from "./stationMouseContext.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

const teardowns: Array<() => void> = [];

afterEach(async () => {
  await act(async () => {
    for (const teardown of teardowns.splice(0)) {
      teardown();
    }
  });
});

const APPLIED_SEGMENTS: readonly DashboardFilterFooterSegment[] = [
  { text: "/ edit", role: "key", action: "persistentFilter.edit" },
  { text: "  ", role: "spacer" },
  { text: "Esc clear", role: "key", action: "persistentFilter.clear" },
  { text: "  Q:close", role: "description" },
];

describe("DashboardFilterFooterView", () => {
  it("renders the applied footer neutrally and exposes bounded edit/clear targets", async () => {
    const targets: StationMouseTarget[] = [];
    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <StationMouseProvider value={(target) => targets.push(target)}>
          <DashboardFilterFooterView segments={APPLIED_SEGMENTS} variant="applied" />
        </StationMouseProvider>
      </StationThemeProvider>,
      { width: 40, height: 1 },
    );
    teardowns.push(() => setup.renderer.destroy());
    await act(async () => {
      await setup.renderOnce();
    });

    expect(setup.captureCharFrame().split("\n")[0]?.trimEnd()).toBe(
      "/ edit  Esc clear  Q:close",
    );
    await act(async () => {
      await setup.mockMouse.click(1, 0, MouseButtons.LEFT);
      await setup.mockMouse.click(9, 0, MouseButtons.LEFT);
      await setup.mockMouse.click(18, 0, MouseButtons.LEFT);
    });

    expect(targets).toEqual([
      { kind: "persistentFilterAction", actionId: "persistentFilter.edit" },
      { kind: "persistentFilterAction", actionId: "persistentFilter.clear" },
    ]);
  });
});
