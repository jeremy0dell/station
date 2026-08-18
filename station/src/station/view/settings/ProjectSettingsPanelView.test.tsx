import { afterEach, describe, expect, it } from "bun:test";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import {
  createInitialTuiState,
  handleTuiKey,
  openProjectSettings,
} from "@station/dashboard-core/state";
import { nativeStationTheme, StationThemeProvider } from "../../../theme/index.js";
import type { StationMouseTarget } from "../../input/stationMouse.js";
import { manyProjectsSnapshot } from "../../fixtures/scenarios.js";
import {
  StationHoverProvider,
  StationMouseProvider,
} from "../stationMouseContext.js";
import { ProjectSettingsPanelView } from "./ProjectSettingsPanelView.js";

const teardowns: Array<() => void> = [];
afterEach(() => {
  for (const teardown of teardowns.splice(0)) teardown();
});

function settingsState(detail = false) {
  const snapshot = manyProjectsSnapshot();
  let state = openProjectSettings(
    createInitialTuiState({ initialSnapshot: snapshot }),
    "station",
  );
  if (detail) state = handleTuiKey(state, { input: "", rightArrow: true }).state;
  if (state.screen.name !== "projectSettings") throw new Error("expected Project Settings");
  return { snapshot, state, screen: state.screen };
}

async function render(detail: boolean, size = { width: 80, height: 20 }) {
  const current = settingsState(detail);
  const targets: StationMouseTarget[] = [];
  const setup = await testRender(
    <StationThemeProvider theme={nativeStationTheme}>
      <StationHoverProvider value>
        <StationMouseProvider value={(target) => targets.push(target)}>
          <ProjectSettingsPanelView
            snapshot={current.snapshot}
            screen={current.screen}
            selection={current.state.selection}
            columns={size.width}
            rows={size.height}
            localRows={current.state.localRows}
          />
        </StationMouseProvider>
      </StationHoverProvider>
    </StationThemeProvider>,
    size,
  );
  teardowns.push(() => setup.renderer.destroy());
  await setup.renderOnce();
  return { setup, targets };
}

describe("ProjectSettingsPanelView", () => {
  it("renders Project-owned settings details inside the shared split shell", async () => {
    const { setup } = await render(true);
    const frame = setup.captureCharFrame();

    expect(frame).toContain("Project settings");
    expect(frame).toContain("Default agent");
    expect(frame).toContain("Remove project");
    expect(frame).toContain("✓ current");
  });

  it("uses list then detail drill-in at compact width", async () => {
    const list = await render(false, { width: 40, height: 12 });
    expect(list.setup.captureCharFrame()).toContain("Project settings");
    expect(list.setup.captureCharFrame()).toContain("Remove project");
    expect(list.setup.captureCharFrame()).not.toContain("✓ current");

    const detail = await render(true, { width: 40, height: 12 });
    expect(detail.setup.captureCharFrame()).toContain("Default agent · station");
    expect(detail.setup.captureCharFrame()).toContain("✓ current");
    expect(detail.setup.captureCharFrame()).not.toContain("Remove project");
  });

  it("retains Project Settings semantic item targets through the shared list", async () => {
    const { setup, targets } = await render(false);
    const lines = setup.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("Remove project"));
    const column = lines[row]?.indexOf("Remove project") ?? -1;

    await setup.mockMouse.click(column, row, MouseButtons.LEFT);

    expect(
      targets.some(
        (target) => target.kind === "projectSettingsItem" && target.itemId === "remove",
      ),
    ).toBe(true);
  });
});
