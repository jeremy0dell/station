import { afterEach, describe, expect, it } from "bun:test";
import { rgbToHex } from "@opentui/core";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { ADD_PROJECT_CHOOSE_LIST_ID, createAddProjectFlow, transitionAddProjectFlow } from "@station/dashboard-core/state";
import type { TuiSelectionState } from "@station/dashboard-core/state";
import { act } from "react";
import { spanAtFrameCell } from "../../../terminal/testing/frameProbe.js";
import type { StationMouseTarget } from "../../input/stationMouse.js";
import { StationHoverProvider, StationMouseProvider } from "../stationMouseContext.js";
import {
  nativeStationTheme,
  stationColorSnapshotValue,
  StationThemeProvider,
} from "../../../theme/index.js";
import { AddProjectSheetView } from "./AddProjectSheetView.js";

const teardowns: Array<() => void> = [];
afterEach(() => {
  for (const teardown of teardowns.splice(0)) teardown();
});

/** Flow state named through the public transition contract rather than the private mutable model. */
type AddProjectSheetFlowState = Parameters<typeof transitionAddProjectFlow>[0];

function reviewFlow(gitRoot: boolean): AddProjectSheetFlowState {
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

async function render(
  flow: AddProjectSheetFlowState,
  width = 80,
  selection: TuiSelectionState = new Map(),
  height = 24,
) {
  const targets: StationMouseTarget[] = [];
  const setup = await testRender(
    <StationThemeProvider theme={nativeStationTheme}>
      <StationHoverProvider value>
        <StationMouseProvider value={(target) => targets.push(target)}>
          <AddProjectSheetView state={flow} selection={selection} columns={width} rows={height} />
        </StationMouseProvider>
      </StationHoverProvider>
    </StationThemeProvider>,
    { width, height },
  );
  teardowns.push(() => setup.renderer.destroy());
  await setup.renderOnce();
  await setup.flush();
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
    expect(lines[row]).toContain("Edit id (N)");
    expect(lines[row]).toContain("Choose folder (B)");
    expect(lines[row]).toContain("Cancel (Esc)");
    const shortcutCol = lines[row]?.indexOf("A)") ?? -1;
    const shortcutSpan = spanAtFrameCell(setup.captureSpans(), row, shortcutCol);
    expect(shortcutSpan?.fg === undefined ? undefined : rgbToHex(shortcutSpan.fg)).toBe(
      stationColorSnapshotValue(nativeStationTheme.status.warning),
    );

    await act(async () => {
      await setup.mockMouse.moveTo(col, row);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await setup.flush();
    const span = spanAtFrameCell(setup.captureSpans(), row, col);
    expect(span?.fg === undefined ? undefined : rgbToHex(span.fg)).toBe(
      stationColorSnapshotValue(nativeStationTheme.text.inverse),
    );
    expect(span?.bg === undefined ? undefined : rgbToHex(span.bg)).toBe(
      stationColorSnapshotValue(nativeStationTheme.action.primary),
    );
    const gapCol = (lines[row]?.indexOf("Edit id") ?? 0) - 1;
    const gapSpan = spanAtFrameCell(setup.captureSpans(), row, gapCol);
    expect(gapSpan?.bg === undefined ? undefined : rgbToHex(gapSpan.bg)).not.toBe(
      stationColorSnapshotValue(nativeStationTheme.action.primary),
    );

    await setup.mockMouse.click(col, row, MouseButtons.LEFT);
    expect(targets.at(-1)).toEqual({ kind: "addProjectAction", actionId: "review.submit" });
  });

  it("renders Git-invalid submit disabled without an action target", async () => {
    const { setup, targets } = await render(reviewFlow(false));
    const lines = setup.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("Add project (A)"));
    const col = lines[row]?.indexOf("Add project") ?? -1;
    expect(setup.captureCharFrame()).toContain("Choose a folder inside an existing Git repository");

    await setup.mockMouse.click(col, row, MouseButtons.LEFT);
    expect(
      targets.some(
        (target) => target.kind === "addProjectAction" && target.actionId === "review.submit",
      ),
    ).toBe(false);
  });

  it("enables folder actions only when their semantic target exists", async () => {
    const started = createAddProjectFlow({ cwd: "/workspace", homeDir: "/home/example" });
    const choosing = transitionAddProjectFlow(started, {
      type: "folderLoaded",
      result: {
        path: "/workspace",
        entries: [{ name: "station", path: "/workspace/station", kind: "directory" }],
      },
    }).state;
    if (choosing?.mode !== "choose") throw new Error("expected chooser");

    const current = await render(
      choosing,
      80,
      new Map([[ADD_PROJECT_CHOOSE_LIST_ID, "/workspace"]]),
    );
    const currentLines = current.setup.captureCharFrame().split("\n");
    const currentRow = currentLines.findIndex((line) => line.includes("Open (→)"));
    const currentCol = currentLines[currentRow]?.indexOf("Open") ?? -1;
    await current.setup.mockMouse.click(currentCol, currentRow, MouseButtons.LEFT);
    expect(
      current.targets.some(
        (target) => target.kind === "addProjectAction" && target.actionId === "choose.open",
      ),
    ).toBe(false);

    const child = await render(
      choosing,
      80,
      new Map([[ADD_PROJECT_CHOOSE_LIST_ID, "/workspace/station"]]),
    );
    const childLines = child.setup.captureCharFrame().split("\n");
    const childRow = childLines.findIndex((line) => line.includes("Open (→)"));
    const childCol = childLines[childRow]?.indexOf("Open") ?? -1;
    await child.setup.mockMouse.click(childCol, childRow, MouseButtons.LEFT);
    expect(
      child.targets.some(
        (target) => target.kind === "addProjectAction" && target.actionId === "choose.open",
      ),
    ).toBe(true);

    const pasted = transitionAddProjectFlow(choosing, {
      type: "filterInput",
      value: "/missing/project",
    }).state;
    if (pasted?.mode !== "choose") throw new Error("expected chooser");
    const fullPath = await render(pasted);
    const pathLines = fullPath.setup.captureCharFrame().split("\n");
    const chooseRow = pathLines.findIndex((line) => line.includes("Choose (↵)"));
    const chooseCol = pathLines[chooseRow]?.indexOf("Choose") ?? -1;
    await fullPath.setup.mockMouse.click(chooseCol, chooseRow, MouseButtons.LEFT);
    expect(
      fullPath.targets.some(
        (target) => target.kind === "addProjectAction" && target.actionId === "choose.choose",
      ),
    ).toBe(true);
  });

  it("keeps compact start actions visible at narrow widths", async () => {
    const flow = createAddProjectFlow({ cwd: "/workspace", homeDir: "/home/example" });
    const { setup } = await render(flow, 40);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Open");
    expect(frame).toContain("Cancel");
    expect(frame).toContain("Click selects");
  });

  it("keeps one bounded frame through short, long, and review stages", async () => {
    const started = createAddProjectFlow({ cwd: "/workspace", homeDir: "/home/example" });
    const entries = Array.from({ length: 40 }, (_, index) => ({
      name: `project-${String(index).padStart(2, "0")}`,
      path: `/workspace/project-${String(index).padStart(2, "0")}`,
      kind: "directory" as const,
    }));
    const choosing = transitionAddProjectFlow(started, {
      type: "folderLoaded",
      result: { path: "/workspace", entries },
    }).state;
    if (choosing?.mode !== "choose") throw new Error("expected chooser");

    const start = await render(started, 80, new Map(), 40);
    const choose = await render(
      choosing,
      80,
      new Map([[ADD_PROJECT_CHOOSE_LIST_ID, entries.at(-1)?.path ?? "/workspace"]]),
      40,
    );
    const review = await render(reviewFlow(true), 80, new Map(), 40);

    expect(start.setup.renderer.root.findDescendantById("station-bottom-sheet")?.height).toBe(12);
    expect(choose.setup.renderer.root.findDescendantById("station-bottom-sheet")?.height).toBe(12);
    expect(review.setup.renderer.root.findDescendantById("station-bottom-sheet")?.height).toBe(12);
    expect(choose.setup.captureCharFrame()).toContain("Folder  /workspace");
    expect(choose.setup.captureCharFrame()).toContain("project-39/");
    expect(choose.setup.captureCharFrame()).not.toContain("project-00/");
    const lines = choose.setup.captureCharFrame().split("\n");
    const selectedRow = lines.findIndex((line) => line.includes("project-39/"));
    await choose.setup.mockMouse.click(
      lines[selectedRow]?.indexOf("project-39/") ?? -1,
      selectedRow,
      MouseButtons.LEFT,
    );
    expect(choose.targets.at(-1)).toEqual({
      kind: "addProjectRow",
      itemId: "/workspace/project-39",
    });
  });
});
