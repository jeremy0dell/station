import { afterEach, describe, expect, it } from "bun:test";
import { rgbToHex } from "@opentui/core";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import type { TuiScreen } from "@station/dashboard-core";
import { act } from "react";
import { spanAtFrameCell } from "../../../terminal/testing/frameProbe.js";
import type { StationMouseTarget } from "../../input/stationMouse.js";
import { StationHoverProvider, StationMouseProvider } from "../stationMouseContext.js";
import { STATION_COLORS } from "../theme.js";
import { RemoveSessionSheetView } from "./RemoveSessionSheetView.js";

type RemoveConfirmScreen = Extract<
  TuiScreen,
  { name: "removeWorktree"; step: "confirm" }
>;

const teardowns: Array<() => void> = [];
afterEach(() => {
  for (const teardown of teardowns.splice(0)) teardown();
});

function confirmScreen(actionFocus: RemoveConfirmScreen["actionFocus"]): RemoveConfirmScreen {
  return {
    name: "removeWorktree",
    step: "confirm",
    rowId: "ses_example" as RemoveConfirmScreen["rowId"],
    forceRequired: false,
    label: "cli-help-man",
    actionFocus,
  };
}

async function render(actionFocus: RemoveConfirmScreen["actionFocus"], width = 80) {
  const targets: StationMouseTarget[] = [];
  const setup = await testRender(
    <StationHoverProvider value>
      <StationMouseProvider value={(target) => targets.push(target)}>
        <RemoveSessionSheetView
          screen={confirmScreen(actionFocus)}
          columns={width}
          rows={16}
        />
      </StationMouseProvider>
    </StationHoverProvider>,
    { width, height: 16 },
  );
  teardowns.push(() => setup.renderer.destroy());
  await setup.renderOnce();
  return { setup, targets };
}

describe("RemoveSessionSheetView", () => {
  it("renders explicit actions with safe Keep focus and danger-only Delete styling", async () => {
    const { setup } = await render("keep");
    const lines = setup.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("Delete (Y)"));
    const deleteCol = lines[row]?.indexOf("Delete") ?? -1;
    const keepCol = lines[row]?.indexOf("Keep session") ?? -1;

    expect(lines[row]).toContain("▸ Keep session (N)");
    const deleteSpan = spanAtFrameCell(setup.captureSpans(), row, deleteCol);
    const keepSpan = spanAtFrameCell(setup.captureSpans(), row, keepCol);
    expect(deleteSpan?.fg === undefined ? undefined : rgbToHex(deleteSpan.fg)).toBe(
      STATION_COLORS.red,
    );
    expect(keepSpan?.bg === undefined ? undefined : rgbToHex(keepSpan.bg)).toBe(
      STATION_COLORS.focusBackground,
    );
  });

  it("keeps button targets and hover fills bounded", async () => {
    const { setup, targets } = await render("keep");
    const lines = setup.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("Delete (Y)"));
    const deleteCol = lines[row]?.indexOf("Delete") ?? -1;
    const keepCol = lines[row]?.indexOf("Keep session") ?? -1;

    await act(async () => {
      await setup.mockMouse.moveTo(deleteCol, row);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await setup.flush();
    const deleteSpan = spanAtFrameCell(setup.captureSpans(), row, deleteCol);
    expect(deleteSpan?.bg === undefined ? undefined : rgbToHex(deleteSpan.bg)).toBe(
      STATION_COLORS.red,
    );

    await setup.mockMouse.click(deleteCol, row, MouseButtons.LEFT);
    await setup.mockMouse.click(keepCol, row, MouseButtons.LEFT);
    await setup.mockMouse.click(58, row, MouseButtons.LEFT);
    expect(targets).toEqual([
      { kind: "removeWorktreeAction", actionId: "confirm.delete" },
      { kind: "removeWorktreeAction", actionId: "confirm.keep" },
    ]);
  });

  it("uses compact Delete and Keep labels when constrained", async () => {
    const { setup } = await render("keep", 28);
    const frame = setup.captureCharFrame();

    expect(frame).toContain("Delete");
    expect(frame).toContain("▸ Keep");
    expect(frame).not.toContain("Keep session");
  });
});
