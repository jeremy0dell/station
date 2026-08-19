import { describe, expect, it } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { createInitialTuiState, openGroupMenu } from "@station/dashboard-core/state";
import { nativeStationTheme, StationThemeProvider } from "../../theme/index.js";
import { spanAtFrameCell } from "../../terminal/testing/frameProbe.js";
import { groupedManyProjectsSnapshot } from "../fixtures/scenarios.js";
import { GroupMenuView } from "./GroupMenuView.js";

describe("GroupMenuView", () => {
  it("renders the Q/N/S/R keyboard shortcuts", async () => {
    const snapshot = groupedManyProjectsSnapshot();
    const opened = openGroupMenu(
      createInitialTuiState({ initialSnapshot: snapshot }),
      "group_design_refresh",
    );
    if (opened.screen.name !== "groupMenu") throw new Error("Group menu did not open.");
    const viewport = { columns: 40, rows: 12, anchorTop: 2 };
    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <GroupMenuView
          snapshot={snapshot}
          screen={opened.screen}
          viewport={viewport}
        />
      </StationThemeProvider>,
      { width: 40, height: 12 },
    );
    await setup.flush();
    try {
      const frame = setup.captureCharFrame();
      const spans = setup.captureSpans();
      const lines = frame.split("\n");
      expect(frame).toContain("Design refresh");
      expect(lines.find((line) => line.includes("Quick session"))).toMatch(/Quick session\s+Q/);
      expect(lines.find((line) => line.includes("New session…"))).toMatch(/New session…\s+N/);
      expect(lines.find((line) => line.includes("Group settings…"))).toMatch(
        /Group settings…\s+S/,
      );
      expect(lines.find((line) => line.includes("Remove Group…"))).toMatch(/Remove Group…\s+R/);
      expect(spanAtFrameCell(spans, 9, 14)?.fg).not.toEqual(
        spanAtFrameCell(spans, 4, 14)?.fg,
      );
    } finally {
      setup.renderer.destroy();
    }
  });
});
