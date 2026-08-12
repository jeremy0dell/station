import { afterEach, describe, expect, it } from "bun:test";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import type { DashboardScreenView } from "@station/dashboard-core/state";
import { act } from "react";
import { nativeStationTheme, StationThemeProvider } from "../../../theme/index.js";
import type { StationMouseTarget } from "../../input/stationMouse.js";
import { StationHoverProvider, StationMouseProvider } from "../stationMouseContext.js";
import { CreateGroupSheetView } from "./CreateGroupSheetView.js";

type CreateGroupScreen = Extract<DashboardScreenView, { name: "createGroup" }>;

const teardowns: Array<() => void> = [];
afterEach(async () => {
  await act(async () => {
    for (const teardown of teardowns.splice(0)) teardown();
  });
});

describe("CreateGroupSheetView", () => {
  it("renders the draft, toggle, and exact bounded actions", async () => {
    const targets: StationMouseTarget[] = [];
    const screen: CreateGroupScreen = {
      name: "createGroup",
      projectId: "station",
      draftName: { value: "Release work", cursor: 12 },
      quickSession: false,
      focus: "name",
      submitting: false,
      returnTo: "projectMenu",
    };
    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <StationHoverProvider value>
          <StationMouseProvider value={(target) => targets.push(target)}>
            <CreateGroupSheetView screen={screen} columns={80} rows={20} />
          </StationMouseProvider>
        </StationHoverProvider>
      </StationThemeProvider>,
      { width: 80, height: 20 },
    );
    teardowns.push(() => setup.renderer.destroy());
    await setup.renderOnce();

    const lines = setup.captureCharFrame().split("\n");
    const nameRow = lines.findIndex((line) => line.includes("Release work"));
    const quickRow = lines.findIndex((line) => line.includes("Quick session"));
    const actionRow = lines.findIndex((line) => line.includes("Cancel"));
    await act(async () => {
      await setup.mockMouse.click(lines[nameRow]?.indexOf("Name") ?? -1, nameRow, MouseButtons.LEFT);
      await setup.mockMouse.click(lines[quickRow]?.indexOf("Quick session") ?? -1, quickRow, MouseButtons.LEFT);
      await setup.mockMouse.click(lines[actionRow]?.indexOf("Create Group") ?? -1, actionRow, MouseButtons.LEFT);
      await setup.mockMouse.click(lines[actionRow]?.indexOf("Cancel") ?? -1, actionRow, MouseButtons.LEFT);
    });

    expect(targets).toEqual([
      { kind: "createGroupAction", actionId: "name" },
      { kind: "createGroupAction", actionId: "quickSession" },
      { kind: "createGroupAction", actionId: "create" },
      { kind: "createGroupAction", actionId: "cancel" },
    ]);
    expect(setup.captureCharFrame()).toContain("Quick session (Q) Off");
  });

  it("makes every control inert while submitting", async () => {
    const targets: StationMouseTarget[] = [];
    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <StationHoverProvider value>
          <StationMouseProvider value={(target) => targets.push(target)}>
            <CreateGroupSheetView
              screen={{
                name: "createGroup",
                projectId: "station",
                draftName: { value: "Release work", cursor: 12 },
                quickSession: true,
                focus: "create",
                submitting: true,
                returnTo: "projectMenu",
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

    await act(async () => {
      for (const row of [14, 15, 16]) {
        await setup.mockMouse.click(4, row, MouseButtons.LEFT);
      }
    });
    expect(targets.filter((target) => target.kind !== "sheetBackdrop")).toEqual([]);
    expect(setup.captureCharFrame()).toContain("Creating Group…");
  });
});
