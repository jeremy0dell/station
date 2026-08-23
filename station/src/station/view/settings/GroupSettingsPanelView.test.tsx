import { afterEach, describe, expect, it } from "bun:test";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import {
  createInitialTuiState,
  handleTuiKey,
  openGroupSettings,
} from "@station/dashboard-core/state";
import type {
  DashboardScreenView,
  DashboardSnapshotView,
} from "@station/dashboard-core/state";
import { groupedManyProjectsSnapshot } from "../../fixtures/scenarios.js";
import type { StationMouseTarget } from "../../input/stationMouse.js";
import { nativeStationTheme, StationThemeProvider } from "../../../theme/index.js";
import {
  StationHoverProvider,
  StationMouseProvider,
} from "../stationMouseContext.js";
import { semanticItemRenderableId } from "../layout/scrollViewport.js";
import { GroupSettingsPanelView } from "./GroupSettingsPanelView.js";

type GroupSettingsScreen = Extract<DashboardScreenView, { name: "groupSettings" }>;

const teardowns: Array<() => void> = [];
afterEach(() => {
  for (const teardown of teardowns.splice(0)) teardown();
});

function settingsState(section: "general" | "sessions" | "remove") {
  const snapshot = groupedManyProjectsSnapshot();
  let state = openGroupSettings(
    createInitialTuiState({ initialSnapshot: snapshot }),
    "group_design_refresh",
    section,
  );
  state = handleTuiKey(state, { input: "", rightArrow: true }).state;
  if (state.screen.name !== "groupSettings") throw new Error("expected Group Settings");
  return { snapshot, state, screen: state.screen };
}

async function render(
  snapshot: DashboardSnapshotView,
  screen: GroupSettingsScreen,
  size = { width: 80, height: 20 },
) {
  const targets: StationMouseTarget[] = [];
  const setup = await testRender(
    <StationThemeProvider theme={nativeStationTheme}>
      <StationHoverProvider value>
        <StationMouseProvider value={(target) => targets.push(target)}>
          <GroupSettingsPanelView
            snapshot={snapshot}
            screen={screen}
            columns={size.width}
            rows={size.height}
          />
        </StationMouseProvider>
      </StationHoverProvider>
    </StationThemeProvider>,
    size,
  );
  teardowns.push(() => setup.renderer.destroy());
  await setup.renderOnce();
  await setup.flush();
  await setup.renderOnce();
  return { setup, targets };
}

describe("GroupSettingsPanelView", () => {
  it("renders General identity, editable name, and explicit actions", async () => {
    const state = settingsState("general");
    const { setup } = await render(state.snapshot, state.screen);
    const frame = setup.captureCharFrame();

    expect(frame).toContain("Group settings · Design refresh");
    expect(frame).toContain("General");
    expect(frame).toContain("Name");
    expect(frame).toContain("Project station (read-only)");
    expect(frame).toContain("Save");
    expect(frame).toContain("Cancel");
  });

  it("renders non-color session cursor and checkbox markers with semantic targets", async () => {
    const state = settingsState("sessions");
    const { setup, targets } = await render(state.snapshot, state.screen);
    const lines = setup.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("group-contracts"));
    const column = lines[row]?.indexOf("group-contracts") ?? -1;

    expect(lines[row]).toContain("▸");
    expect(lines[row]).toContain("[✓]");
    expect(lines[row]).toContain("in this Group");
    await setup.mockMouse.click(column, row, MouseButtons.LEFT);
    expect(
      targets.some(
        (target) =>
          target.kind === "groupSettingsSession" &&
          target.sessionId === "ses_wt_group_contracts",
      ),
    ).toBe(true);
  });

  it("makes staged ungrouping explicit without changing the focus marker", async () => {
    const initial = settingsState("sessions");
    const staged = handleTuiKey(initial.state, { input: " " }).state;
    if (staged.screen.name !== "groupSettings") throw new Error("expected Group Settings");
    const { setup } = await render(initial.snapshot, staged.screen);
    const line = setup
      .captureCharFrame()
      .split("\n")
      .find((candidate) => candidate.includes("group-contracts"));

    expect(line).toContain("▸");
    expect(line).toContain("[ ]");
    expect(line).toContain("ungroup on Save");
  });

  it("renders every semantic session and follows a clipped cursor in a short panel", async () => {
    const state = settingsState("sessions");
    const projectSessions = state.snapshot.sessions.filter(
      (session) => session.projectId === state.screen.projectId,
    );
    const first = projectSessions[0];
    const last = projectSessions.at(-1);
    if (first === undefined || last === undefined) throw new Error("expected Project sessions");
    const screen: GroupSettingsScreen = {
      ...state.screen,
      detailFocus: "sessionList",
      sessionCursor: last.id,
    };
    const { setup } = await render(state.snapshot, screen, { width: 80, height: 8 });

    expect(setup.captureCharFrame()).toContain(last.title);
    expect(setup.captureCharFrame()).toContain("↑↓ focus");
    expect(
      setup.renderer.root.findDescendantById(semanticItemRenderableId(first.id)),
    ).toBeDefined();
    expect(
      setup.renderer.root.findDescendantById(semanticItemRenderableId(last.id)),
    ).toBeDefined();
  });

  it("keeps destructive copy and actions visible in a short minimum-width frame", async () => {
    const state = settingsState("remove");
    const { setup } = await render(state.snapshot, state.screen, { width: 40, height: 12 });
    const frame = setup.captureCharFrame();

    expect(frame).toContain("Remove Group");
    expect(frame).toContain("remain open");
    expect(frame).toContain("Remove");
    expect(frame).toContain("Back");
  });

  it("removes actionable pointer targets while pending", async () => {
    const state = settingsState("general");
    const screen: GroupSettingsScreen = { ...state.screen, pending: "rename" };
    const { setup, targets } = await render(state.snapshot, screen);
    const lines = setup.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("Saving…"));
    const column = lines[row]?.indexOf("Saving") ?? -1;

    await setup.mockMouse.click(column, row, MouseButtons.LEFT);
    expect(
      targets.some(
        (target) =>
          target.kind === "groupSettingsAction" && target.actionId === "save",
      ),
    ).toBe(false);
  });
});
