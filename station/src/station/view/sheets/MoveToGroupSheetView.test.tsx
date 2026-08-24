import { afterEach, describe, expect, it } from "bun:test";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import type { DashboardScreenView } from "@station/dashboard-core/state";
import { MOVE_TO_GROUP_CREATE_CHOICE_ID } from "@station/dashboard-core/state";
import { act } from "react";
import { nativeStationTheme, StationThemeProvider } from "../../../theme/index.js";
import { groupedManyProjectsSnapshot } from "../../fixtures/scenarios.js";
import type { StationMouseTarget } from "../../input/stationMouse.js";
import { StationHoverProvider, StationMouseProvider } from "../stationMouseContext.js";
import { semanticItemRenderableId } from "../layout/scrollViewport.js";
import { MoveToGroupSheetView } from "./MoveToGroupSheetView.js";

type MoveScreen = Exclude<
  Extract<DashboardScreenView, { name: "moveToGroup" }>,
  { step: "chooseSlot" }
>;

const teardowns: Array<() => void> = [];
afterEach(async () => {
  await act(async () => {
    for (const teardown of teardowns.splice(0)) teardown();
  });
});

async function render(
  screen: MoveScreen,
  selection = new Map<string, string>(),
  rows = 24,
) {
  const targets: StationMouseTarget[] = [];
  const snapshot = groupedManyProjectsSnapshot();
  const setup = await testRender(
    <StationThemeProvider theme={nativeStationTheme}>
      <StationHoverProvider value>
        <StationMouseProvider value={(target) => targets.push(target)}>
          <MoveToGroupSheetView
            snapshot={snapshot}
            screen={screen}
            selection={selection}
            columns={80}
            rows={rows}
          />
        </StationMouseProvider>
      </StationHoverProvider>
    </StationThemeProvider>,
    { width: 80, height: rows },
  );
  teardowns.push(() => setup.renderer.destroy());
  await setup.renderOnce();
  await setup.flush();
  return { setup, targets };
}

describe("MoveToGroupSheetView", () => {
  it("separates current membership from cursor focus and exposes every destination row", async () => {
    const { setup, targets } = await render(
      {
        name: "moveToGroup",
        step: "chooseDestination",
        sessionId: "ses_wt_group_contracts",
        sessionTitle: "group-contracts",
        submitting: false,
      },
      new Map([["moveToGroupDestination", "moveToGroup:existing:group_observer_hardening"]]),
    );
    const frame = setup.captureCharFrame();
    const lines = frame.split("\n");
    const currentLine = lines.find((line) => line.includes("1 Design refresh"));
    const focusedLine = lines.find((line) => line.includes("2 Observer hardening"));
    expect(frame).toContain("Current    Design refresh");
    expect(frame).toContain("✓1 Design refresh");
    expect(currentLine).not.toContain("▸");
    expect(focusedLine).toContain("▸ 2 Observer hardening");
    expect(focusedLine).not.toContain("✓");
    expect(
      setup.renderer.root.findDescendantById(
        semanticItemRenderableId(MOVE_TO_GROUP_CREATE_CHOICE_ID),
      ),
    ).toBeDefined();

    for (const label of ["U Ungrouped", "2 Observer hardening"]) {
      const row = lines.findIndex((line) => line.includes(label));
      await setup.mockMouse.click(lines[row]?.indexOf(label) ?? -1, row, MouseButtons.LEFT);
    }
    expect(targets.filter((target) => target.kind === "sheetChoice")).toEqual([
      { kind: "sheetChoice", choiceKey: "U" },
      { kind: "sheetChoice", choiceKey: "2" },
    ]);

    const { setup: createSetup, targets: createTargets } = await render(
      {
        name: "moveToGroup",
        step: "chooseDestination",
        sessionId: "ses_wt_group_contracts",
        sessionTitle: "group-contracts",
        submitting: false,
      },
      new Map([["moveToGroupDestination", MOVE_TO_GROUP_CREATE_CHOICE_ID]]),
    );
    const createLines = createSetup.captureCharFrame().split("\n");
    const createRow = createLines.findIndex((line) => line.includes("N Create new Group…"));
    expect(createRow).toBeGreaterThanOrEqual(0);
    await createSetup.mockMouse.click(
      createLines[createRow]?.indexOf("N Create new Group…") ?? -1,
      createRow,
      MouseButtons.LEFT,
    );
    expect(createTargets.filter((target) => target.kind === "sheetChoice")).toEqual([
      { kind: "sheetChoice", choiceKey: "N" },
    ]);

    const { setup: currentSetup } = await render(
      {
        name: "moveToGroup",
        step: "chooseDestination",
        sessionId: "ses_wt_group_contracts",
        sessionTitle: "group-contracts",
        submitting: false,
      },
      new Map([["moveToGroupDestination", "moveToGroup:existing:group_design_refresh"]]),
    );
    expect(currentSetup.captureCharFrame()).toContain("▸✓1 Design refresh");
  });

  it("renders create-and-move progress without a duplicate submit target", async () => {
    const screen: MoveScreen = {
      name: "moveToGroup",
      step: "createGroup",
      sessionId: "ses_wt_group_contracts",
      sessionTitle: "group-contracts",
      draftName: { value: "Release", cursor: 7 },
      submitting: true,
    };
    const { setup, targets } = await render(screen);
    expect(setup.captureCharFrame()).toContain("Creating Group…");
    expect(setup.captureCharFrame()).toContain("Create and Move");
    const lines = setup.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("Create and Move"));
    await setup.mockMouse.click(lines[row]?.indexOf("Create and Move") ?? -1, row, MouseButtons.LEFT);
    expect(targets.some((target) => target.kind === "moveToGroupCreateSubmit")).toBe(false);
  });

  it("follows semantic focus through clipping and resize without slicing choices", async () => {
    const { setup } = await render(
      {
        name: "moveToGroup",
        step: "chooseDestination",
        sessionId: "ses_wt_group_contracts",
        sessionTitle: "group-contracts",
        submitting: false,
      },
      new Map([["moveToGroupDestination", "moveToGroup:existing:group_release_train"]]),
      11,
    );
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Release train");
    expect(frame).toContain("↑↓ move   ↵ select");
    expect(frame).not.toContain("of 6");
    expect(
      setup.renderer.root.findDescendantById(
        semanticItemRenderableId("moveToGroup:existing:group_input_parity"),
      ),
    ).toBeDefined();
    expect(
      setup.renderer.root.findDescendantById(
        semanticItemRenderableId("moveToGroup:create"),
      ),
    ).toBeDefined();

    await act(async () => setup.renderer.resize(80, 8));
    await setup.renderOnce();
    await setup.flush();
    const resized = setup.captureCharFrame();
    expect(resized).toContain("▸ 5 Release train");
    expect(resized).toContain("↑↓ move   ↵ select");
  });
});
