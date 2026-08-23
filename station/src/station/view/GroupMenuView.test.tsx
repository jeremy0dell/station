import { describe, expect, it } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { createInitialTuiState, openGroupMenu } from "@station/dashboard-core/state";
import { act } from "react";
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
    const menuScreen = opened.screen;
    const group = snapshot.sessionGroups.find(
      (candidate) => candidate.id === menuScreen.groupId,
    );
    if (group === undefined) throw new Error("Group fixture is missing.");
    const boundaryId = "group-menu-test-boundary";
    const anchorRenderableId = "group-menu-test-anchor";
    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <box id={boundaryId} width={40} height={12} flexDirection="column">
          <box height={2} flexShrink={0} />
          <box id={anchorRenderableId} height={1} flexShrink={0} />
          <GroupMenuView
            screen={menuScreen}
            groupName={group.name}
            boundaryId={boundaryId}
            anchorRenderableId={anchorRenderableId}
          />
        </box>
      </StationThemeProvider>,
      { width: 40, height: 12 },
    );
    await setup.flush();
    try {
      const frame = setup.captureCharFrame();
      const spans = setup.captureSpans();
      const lines = frame.split("\n");
      const quickSessionRow = lines.findIndex((line) => line.includes("Quick session"));
      const newSessionRow = lines.findIndex((line) => line.includes("New session…"));
      expect(frame).toContain("Design refresh");
      expect(lines[quickSessionRow]).toMatch(/▸Quick session\s+Q/);
      expect(lines.find((line) => line.includes("New session…"))).toMatch(/New session…\s+N/);
      expect(lines.find((line) => line.includes("Group settings…"))).toMatch(
        /Group settings…\s+S/,
      );
      expect(lines.find((line) => line.includes("Remove Group…"))).toMatch(/Remove Group…\s+R/);
      expect(lines.filter((line) => line.includes("▸"))).toHaveLength(1);
      expect(spanAtFrameCell(spans, 9, 14)?.fg).not.toEqual(
        spanAtFrameCell(spans, 4, 14)?.fg,
      );

      await act(async () => {
        await setup.mockMouse.moveTo(
          lines[newSessionRow]?.indexOf("New session…") ?? -1,
          newSessionRow,
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      await setup.flush();
      const hoveredLines = setup.captureCharFrame().split("\n");
      expect(hoveredLines[quickSessionRow]).toContain("▸Quick session");
      expect(hoveredLines[newSessionRow]).not.toContain("▸");
    } finally {
      setup.renderer.destroy();
    }
  });
});
