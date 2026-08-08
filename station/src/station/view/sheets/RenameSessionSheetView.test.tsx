import { afterEach, describe, expect, it } from "bun:test";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { nativeStationTheme, StationThemeProvider } from "../../../theme/index.js";
import { createEditableTextInputState } from "@station/dashboard-core/selectors";
import { act } from "react";
import type { StationMouseTarget } from "../../input/stationMouse.js";
import { StationHoverProvider, StationMouseProvider } from "../stationMouseContext.js";
import { RenameSessionSheetView } from "./RenameSessionSheetView.js";

const teardowns: Array<() => void> = [];
afterEach(async () => {
  await act(async () => {
    for (const teardown of teardowns.splice(0)) teardown();
  });
});

describe("RenameSessionSheetView", () => {
  it("renders Rename as a bounded semantic button", async () => {
    const targets: StationMouseTarget[] = [];
    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <StationHoverProvider value>
          <StationMouseProvider value={(target) => targets.push(target)}>
            <RenameSessionSheetView
              state={{
                name: "renameSession",
                step: "editName",
                rowId: "ses_example",
                sessionId: "ses_example",
                currentTitle: "Current title",
                draftTitle: createEditableTextInputState("Updated title"),
              }}
              columns={80}
              rows={20}
            />
          </StationMouseProvider>
        </StationHoverProvider>
      </StationThemeProvider>,
      { width: 80, height: 20 },
    );
    teardowns.push(() => setup.renderer.destroy());
    await setup.renderOnce();

    const lines = setup.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("Rename (enter)"));
    const column = lines[row]?.indexOf("Rename") ?? -1;
    expect(row).toBeGreaterThan(0);
    expect(column).toBeGreaterThan(0);

    await act(async () => {
      await setup.mockMouse.click(column, row, MouseButtons.LEFT);
      await setup.mockMouse.click(column + 30, row, MouseButtons.LEFT);
    });

    expect(targets.filter((target) => target.kind === "renameSessionSubmit")).toEqual([
      { kind: "renameSessionSubmit" },
    ]);
  });
});
