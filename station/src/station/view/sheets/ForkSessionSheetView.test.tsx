import { afterEach, describe, expect, it } from "bun:test";
import { rgbToHex } from "@opentui/core";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { createEditableTextInputState } from "@station/dashboard-core/selectors";
import type { DashboardScreenView } from "@station/dashboard-core/state";
import { act } from "react";
import { spanAtFrameCell } from "../../../terminal/testing/frameProbe.js";
import type { StationMouseTarget } from "../../input/stationMouse.js";
import { StationHoverProvider, StationMouseProvider } from "../stationMouseContext.js";
import {
  nativeStationTheme,
  stationColorSnapshotValue,
  StationThemeProvider,
} from "../../../theme/index.js";
import { ForkSessionSheetView } from "./ForkSessionSheetView.js";

type ForkDetailsScreen = Extract<DashboardScreenView, { name: "fork"; step: "details" }>;

const teardowns: Array<() => void> = [];
afterEach(() => {
  for (const teardown of teardowns.splice(0)) teardown();
});

function detailsScreen(
  focus: ForkDetailsScreen["focus"],
  options: { grouped?: boolean; inheritSourceGroup?: boolean } = {},
): ForkDetailsScreen {
  const screen: ForkDetailsScreen = {
    name: "fork",
    step: "details",
    sourceSessionId: "ses_example" as ForkDetailsScreen["sourceSessionId"],
    sourceWorktreeId: "wt_example" as ForkDetailsScreen["sourceWorktreeId"],
    projectId: "station" as ForkDetailsScreen["projectId"],
    projectLabel: "station",
    sourceBranch: "main",
    sourceDirty: true,
    sourceAgentRunning: true,
    branch: "main-fork-aaaaaa",
    draftTitle: createEditableTextInputState("fork-title"),
    ...(options.grouped === true
      ? {
          sourceGroup: {
            id: "group_long" as NonNullable<ForkDetailsScreen["sourceGroup"]>["id"],
            name: "Input parity and minimum-width interaction verification",
          },
        }
      : {}),
    inheritSourceGroup: options.inheritSourceGroup ?? true,
    copyDirty: true,
    focus,
  };
  return screen;
}

async function render(
  focus: ForkDetailsScreen["focus"],
  width = 80,
  options: { grouped?: boolean; inheritSourceGroup?: boolean } = {},
) {
  const targets: StationMouseTarget[] = [];
  const setup = await testRender(
    <StationThemeProvider theme={nativeStationTheme}>
      <StationHoverProvider value>
        <StationMouseProvider value={(target) => targets.push(target)}>
          <ForkSessionSheetView screen={detailsScreen(focus, options)} columns={width} rows={16} />
        </StationMouseProvider>
      </StationHoverProvider>
    </StationThemeProvider>,
    { width, height: 16 },
  );
  teardowns.push(() => setup.renderer.destroy());
  await setup.renderOnce();
  return { setup, targets };
}

describe("ForkSessionSheetView", () => {
  it("shows the cursor only while Name owns focus", async () => {
    const name = await render("name");
    expect(name.setup.captureCharFrame()).toContain("▸ Name");
    expect(name.setup.captureCharFrame()).toContain("fork-title|");

    const copy = await render("copyDirty");
    expect(copy.setup.captureCharFrame()).toContain("▸ Copy");
    expect(copy.setup.captureCharFrame()).not.toContain("fork-title|");
    expect(copy.setup.captureCharFrame()).toContain("Space/Enter toggle");
  });

  it("renders an ungrouped source as a read-only row without a checkbox target", async () => {
    const { setup, targets } = await render("name");
    const lines = setup.captureCharFrame().split("\n");
    const groupRow = lines.findIndex((line) => line.includes("Group"));
    const groupCol = lines[groupRow]?.indexOf("Group") ?? -1;

    expect(setup.captureCharFrame()).toContain("Group  (Ungrouped)");
    expect(setup.captureCharFrame()).not.toContain("[ ] (Ungrouped)");
    await setup.mockMouse.click(groupCol, groupRow, MouseButtons.LEFT);
    expect(
      targets.some(
        (target) =>
          target.kind === "forkSessionAction" && target.actionId === "details.group",
      ),
    ).toBe(false);
  });

  it("renders checked and unchecked grouped states with normal truncation", async () => {
    const checked = await render("group", 40, { grouped: true });
    expect(checked.setup.captureCharFrame()).toContain("▸ Group");
    expect(checked.setup.captureCharFrame()).toContain("[x] create in Input parity");
    expect(checked.setup.captureCharFrame()).toContain("Space/↵ toggle");

    const unchecked = await render("group", 40, {
      grouped: true,
      inheritSourceGroup: false,
    });
    expect(unchecked.setup.captureCharFrame()).toContain("[ ] (Ungrouped)");
  });

  it("emits exact bounded targets for Name, Copy, and Fork", async () => {
    const { setup, targets } = await render("name");
    const lines = setup.captureCharFrame().split("\n");
    const nameRow = lines.findIndex((line) => line.includes("Name"));
    const copyRow = lines.findIndex((line) => line.includes("Copy"));
    const forkRow = lines.findIndex((line) => line.includes("Fork (enter)"));
    const nameCol = lines[nameRow]?.indexOf("Name") ?? -1;
    const copyCol = lines[copyRow]?.indexOf("Copy") ?? -1;
    const forkCol = lines[forkRow]?.indexOf("Fork") ?? -1;

    await setup.mockMouse.click(nameCol, nameRow, MouseButtons.LEFT);
    await setup.mockMouse.click(copyCol, copyRow, MouseButtons.LEFT);
    await setup.mockMouse.click(forkCol, forkRow, MouseButtons.LEFT);
    await setup.mockMouse.click(58, copyRow, MouseButtons.LEFT);

    expect(targets).toEqual([
      { kind: "forkSessionAction", actionId: "details.name" },
      { kind: "forkSessionAction", actionId: "details.copyDirty" },
      { kind: "forkSessionAction", actionId: "details.submit" },
    ]);
  });

  it("emits one Group target only for a grouped source", async () => {
    const { setup, targets } = await render("group", 80, { grouped: true });
    const lines = setup.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("Group"));
    const col = lines[row]?.indexOf("Group") ?? -1;

    await setup.mockMouse.click(col, row, MouseButtons.LEFT);
    expect(targets).toEqual([{ kind: "forkSessionAction", actionId: "details.group" }]);
  });

  it("keeps Copy hover bounded to its control cells", async () => {
    const { setup } = await render("name");
    const lines = setup.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("Copy"));
    const copyCol = lines[row]?.indexOf("Copy") ?? -1;

    await act(async () => {
      await setup.mockMouse.moveTo(copyCol, row);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await setup.flush();

    const inside = spanAtFrameCell(setup.captureSpans(), row, copyCol);
    const trailing = spanAtFrameCell(setup.captureSpans(), row, 58);
    expect(inside?.bg === undefined ? undefined : rgbToHex(inside.bg)).toBe(
      stationColorSnapshotValue(nativeStationTheme.interaction.hover),
    );
    expect(trailing?.bg === undefined ? undefined : rgbToHex(trailing.bg)).not.toBe(
      stationColorSnapshotValue(nativeStationTheme.interaction.hover),
    );
  });

  it("keeps controls and contextual help readable when narrow", async () => {
    const { setup } = await render("copyDirty", 40);
    const frame = setup.captureCharFrame();

    expect(frame).toContain("Name");
    expect(frame).toContain("▸ Copy");
    expect(frame).toContain("Fork (enter)");
    expect(frame).toContain("Space/↵ toggle · ↑↓ · Esc back");
    expect(frame).toContain("Source running; copy is read-only.");
  });
});
