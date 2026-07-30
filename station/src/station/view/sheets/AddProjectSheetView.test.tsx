import { afterEach, describe, expect, it } from "bun:test";
import { rgbToHex } from "@opentui/core";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import {
  createAddProjectFlow,
  transitionAddProjectFlow,
  type AddProjectFlowState,
} from "@station/dashboard-core";
import { act } from "react";
import { spanAtFrameCell } from "../../../terminal/testing/frameProbe.js";
import type { StationMouseTarget } from "../../input/stationMouse.js";
import { StationHoverProvider, StationMouseProvider } from "../stationMouseContext.js";
import { STATION_COLORS } from "../theme.js";
import { AddProjectSheetView } from "./AddProjectSheetView.js";

const teardowns: Array<() => void> = [];
afterEach(() => {
  for (const teardown of teardowns.splice(0)) teardown();
});

function reviewFlow(gitRoot: boolean): AddProjectFlowState {
  const started = createAddProjectFlow({ cwd: "/workspace", homeDir: "/home/example" });
  const reviewed = transitionAddProjectFlow(started, {
    type: "folderReviewed",
    review: {
      selectedPath: "/workspace/station",
      ...(gitRoot ? { gitRoot: "/workspace/station" } : {}),
      id: "station",
      label: "Station",
    },
  }).state;
  if (reviewed === undefined) throw new Error("expected review flow");
  return reviewed;
}

async function render(flow: AddProjectFlowState, width = 80) {
  const targets: StationMouseTarget[] = [];
  const setup = await testRender(
    <StationHoverProvider value>
      <StationMouseProvider value={(target) => targets.push(target)}>
        <AddProjectSheetView
          state={flow}
          selection={new Map()}
          columns={width}
          rows={24}
        />
      </StationMouseProvider>
    </StationHoverProvider>,
    { width, height: 24 },
  );
  teardowns.push(() => setup.renderer.destroy());
  await setup.renderOnce();
  return { setup, targets };
}

describe("AddProjectSheetView", () => {
  it("renders focused actions as pointer targets with hover contrast", async () => {
    const { setup, targets } = await render(reviewFlow(true));
    const lines = setup.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("Add project (A)"));
    const col = lines[row]?.indexOf("Add project") ?? -1;
    expect(row).toBeGreaterThan(0);
    expect(col).toBeGreaterThan(0);
    expect(lines[row]).toContain("▸");

    await act(async () => {
      await setup.mockMouse.moveTo(col, row);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await setup.flush();
    const span = spanAtFrameCell(setup.captureSpans(), row, col);
    expect(span?.fg === undefined ? undefined : rgbToHex(span.fg)).toBe(STATION_COLORS.background);
    expect(span?.bg === undefined ? undefined : rgbToHex(span.bg)).toBe(STATION_COLORS.cyan);

    await setup.mockMouse.click(col, row, MouseButtons.LEFT);
    expect(targets.at(-1)).toEqual({ kind: "addProjectAction", actionId: "review.submit" });
  });

  it("renders Git-invalid submit disabled without an action target", async () => {
    const { setup, targets } = await render(reviewFlow(false));
    const lines = setup.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("Add project (A)"));
    const col = lines[row]?.indexOf("Add project") ?? -1;
    expect(setup.captureCharFrame()).toContain(
      "Choose a folder inside an existing Git repository",
    );

    await setup.mockMouse.click(col, row, MouseButtons.LEFT);
    expect(
      targets.some(
        (target) =>
          target.kind === "addProjectAction" && target.actionId === "review.submit",
      ),
    ).toBe(false);
  });

  it("keeps compact start actions visible at narrow widths", async () => {
    const flow = createAddProjectFlow({ cwd: "/workspace", homeDir: "/home/example" });
    const { setup } = await render(flow, 40);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Open");
    expect(frame).toContain("Cancel");
    expect(frame).toContain("Click selects");
  });
});
