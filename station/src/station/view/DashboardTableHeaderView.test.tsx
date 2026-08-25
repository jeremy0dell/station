import { afterEach, describe, expect, it } from "bun:test";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { nativeStationTheme, StationThemeProvider } from "../../theme/index.js";
import { textSegment } from "@station/dashboard-core/selectors";
import type { DashboardTableHeaderModel, RowGridLayout } from "@station/dashboard-core/selectors";
import type { StationMouseTarget } from "../input/stationMouse.js";
import {
  DashboardScrollIndicatorView,
  DashboardTableHeaderView,
} from "./DashboardTableHeaderView.js";
import { StationMouseProvider } from "./stationMouseContext.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

const HEADER_TEXT = "       SESSION  AGENT  STATUS  DIFF · PR";
const HEADER_LAYOUT: RowGridLayout = {
  id: "header",
  segments: [textSegment(HEADER_TEXT)],
  hidden: { cells: [], metadata: [] },
};
const teardowns: Array<() => void> = [];

afterEach(() => {
  for (const teardown of teardowns.splice(0)) {
    teardown();
  }
});

async function renderHeader(
  model: DashboardTableHeaderModel,
  dispatch?: (target: StationMouseTarget) => void,
) {
  const header = <DashboardTableHeaderView model={model} />;
  const setup = await testRender(
    <StationThemeProvider theme={nativeStationTheme}>
      {dispatch === undefined ? (
        header
      ) : (
        <StationMouseProvider value={(target) => dispatch(target)}>{header}</StationMouseProvider>
      )}
    </StationThemeProvider>,
    { width: 60, height: 2 },
  );
  teardowns.push(() => setup.renderer.destroy());
  await setup.renderOnce();
  return setup;
}

describe("DashboardTableHeaderView", () => {
  it("renders the column layout exactly", async () => {
    const setup = await renderHeader({ kind: "columns", layout: HEADER_LAYOUT });

    expect(setup.captureCharFrame().split("\n")[0]?.trimEnd()).toBe(HEADER_TEXT);
  });

  it("lets a persistent filter model replace the complete columns and overflow row", async () => {
    const setup = await renderHeader({
      kind: "persistentFilter",
      filter: {
        kind: "applied",
        zeroMatches: false,
        segments: [
          { text: "FILTER ", role: "label" },
          { text: "working", role: "query" },
          { text: "  2/8 matches", role: "count" },
        ],
      },
    });
    const line = setup.captureCharFrame().split("\n")[0]?.trimEnd() ?? "";

    expect(line).toBe("FILTER working  2/8 matches");
    expect(line).not.toContain("SESSION");
  });

  it("renders above-overflow content", async () => {
    const setup = await renderHeader({
      kind: "aboveOverflow",
      overflow: { above: 3, below: 2, visible: 4, total: 9 },
    });

    expect(setup.captureCharFrame().split("\n")[0]?.trimEnd()).toBe("▲ 3 sessions above");
  });

  it("keeps the upward scroll pointer target", async () => {
    const targets: StationMouseTarget[] = [];
    const setup = await renderHeader(
      {
        kind: "aboveOverflow",
        overflow: { above: 3, below: 2, visible: 4, total: 9 },
      },
      (target) => targets.push(target),
    );

    await setup.mockMouse.click(0, 0, MouseButtons.LEFT);

    expect(targets).toEqual([{ kind: "scrollIndicator", direction: "up" }]);
  });

  it("does not reserve a row for an absent below-overflow indicator", async () => {
    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <box flexDirection="column">
          <DashboardScrollIndicatorView
            direction="below"
            overflow={{ above: 0, below: 0, visible: 4, total: 4 }}
          />
          <text>NEXT</text>
        </box>
      </StationThemeProvider>,
      { width: 60, height: 2 },
    );
    teardowns.push(() => setup.renderer.destroy());
    await setup.renderOnce();

    const lines = setup.captureCharFrame().split("\n");
    expect(lines[0]?.trimEnd()).toBe("NEXT");
  });
});
