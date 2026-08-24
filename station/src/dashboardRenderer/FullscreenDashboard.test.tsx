import { afterEach, describe, expect, it } from "bun:test";
import { Renderable, rgbToHex } from "@opentui/core";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { dashboardRowIds } from "@station/dashboard-core/selectors";
import type { TuiWidgetConfig } from "@station/dashboard-core/widgets";
import { act } from "react";
import { groupedManyProjectsSnapshot } from "../station/fixtures/scenarios.js";
import { groupActionRenderableId } from "../station/view/GroupHeaderView.js";
import { makeStationTestRuntime } from "../station/test/support/makeStationTestRuntime.js";
import {
  stationColorSnapshotValue,
  type StationColor,
  type StationTheme,
  type StationThemeSource,
} from "../theme/index.js";
import { STATION_TEXT_CONTRAST_RATIO } from "../theme/terminalPalette/contrast.js";
import { parseStationTerminalPaletteObservation } from "../theme/terminalPalette/observation.js";
import { createTerminalPaletteTheme } from "../theme/terminalPalette/theme.js";
import {
  darkTerminalColors,
  lightTerminalColors,
} from "../theme/terminalPalette/test/fixtures.js";
import { frameChar, spanAtFrameCell } from "../terminal/testing/frameProbe.js";
import { StandaloneDashboardApp } from "./StandaloneDashboardApp.js";

const SURFACE = { width: 80, height: 24 };
const WIDGET_SURFACE = { width: 99, height: 25 };
const NO_OP_OPEN_URL = (): void => {};

function fixtureTheme(value: unknown): StationTheme {
  const observation = parseStationTerminalPaletteObservation(value);
  if (observation === null) {
    throw new Error("Expected complete terminal palette fixture.");
  }
  return createTerminalPaletteTheme(observation);
}

const DARK_THEME = fixtureTheme(darkTerminalColors);
const LIGHT_THEME = fixtureTheme(lightTerminalColors);
const DARK_THEME_SOURCE: StationThemeSource = {
  getSnapshot: () => DARK_THEME,
  subscribe: () => () => {},
};

class MutableThemeSource implements StationThemeSource {
  private snapshot: StationTheme;
  private readonly listeners = new Set<() => void>();

  constructor(snapshot: StationTheme) {
    this.snapshot = snapshot;
  }

  readonly getSnapshot = (): StationTheme => this.snapshot;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setSnapshot(snapshot: StationTheme): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

const teardowns: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const teardown of teardowns.splice(0)) {
    await teardown();
  }
});

describe("FullscreenDashboard surface ownership", () => {
  it("uses terminal-default background intent for its canvas and frame title", async () => {
    const fixture = makeStationTestRuntime();
    const setup = await render(fixture.runtime);

    expectTerminalDefaultBackground(setup, "station · overview");
    const bottomRight = spanAtFrameCell(
      setup.captureSpans(),
      SURFACE.height - 1,
      SURFACE.width - 1,
    );
    expect(bottomRight?.bg.intent).toBe("default");
  });

  it("renders a coherent light terminal canvas", async () => {
    const fixture = makeStationTestRuntime();
    const lightSource: StationThemeSource = {
      getSnapshot: () => LIGHT_THEME,
      subscribe: () => () => {},
    };
    const setup = await render(fixture.runtime, SURFACE, NO_OP_OPEN_URL, lightSource);

    expectTerminalDefaultBackground(setup, "station · overview", LIGHT_THEME);
    expect(
      themeContrast(LIGHT_THEME.text.primary, LIGHT_THEME.surfaces.canvas),
    ).toBeGreaterThanOrEqual(STATION_TEXT_CONTRAST_RATIO);
    expect(
      themeContrast(LIGHT_THEME.text.muted, LIGHT_THEME.surfaces.canvas),
    ).toBeGreaterThanOrEqual(STATION_TEXT_CONTRAST_RATIO);
    expect(
      themeContrast(LIGHT_THEME.status.danger, LIGHT_THEME.surfaces.canvas),
    ).toBeGreaterThanOrEqual(STATION_TEXT_CONTRAST_RATIO);

    await actOn(async () => {
      fixture.runtime.actions.handleKey({ input: "H" });
      await setup.flush();
    });
    const help = cellFor(setup.captureCharFrame(), "station help");
    const helpSpan = spanAtFrameCell(setup.captureSpans(), help.row, help.col);
    expect(helpSpan?.bg.intent).toBe("default");
    expect(helpSpan?.bg.toInts()[3]).toBe(255);
  });

  it("keeps the focused light Add Session control readable", async () => {
    const size = { width: 120, height: 40 };
    const fixture = makeStationTestRuntime({
      initialState: {
        dashboardFocus: { rowId: dashboardRowIds.empty("empty-project"), cellId: "addSession" },
      },
    });
    const lightSource: StationThemeSource = {
      getSnapshot: () => LIGHT_THEME,
      subscribe: () => () => {},
    };
    const setup = await render(fixture.runtime, size, NO_OP_OPEN_URL, lightSource);
    const addSession = cellFor(setup.captureCharFrame(), "[ + add session ]");
    const span = spanAtFrameCell(setup.captureSpans(), addSession.row, addSession.col);

    expect(spanHex(span)).toBe(stationColorSnapshotValue(LIGHT_THEME.action.primary));
    expect(spanBgHex(span)).toBe(
      stationColorSnapshotValue(LIGHT_THEME.interaction.compactFocus),
    );
    expect(
      themeContrast(LIGHT_THEME.action.primary, LIGHT_THEME.interaction.compactFocus),
    ).toBeGreaterThanOrEqual(STATION_TEXT_CONTRAST_RATIO);
  });

  it("keeps focused light controls visually distinct from the canvas", async () => {
    const size = { width: 120, height: 40 };
    const fixture = makeStationTestRuntime({
      initialState: {
        dashboardFocus: { rowId: dashboardRowIds.empty("empty-project"), cellId: "addSession" },
      },
    });
    const lightSource: StationThemeSource = {
      getSnapshot: () => LIGHT_THEME,
      subscribe: () => () => {},
    };
    const setup = await render(fixture.runtime, size, NO_OP_OPEN_URL, lightSource);
    const frame = setup.captureCharFrame();
    const addSession = cellFor(frame, "[ + add session ]");
    const title = cellFor(frame, "station · overview");
    const controlSpan = spanAtFrameCell(setup.captureSpans(), addSession.row, addSession.col);
    const canvasSpan = spanAtFrameCell(setup.captureSpans(), title.row, title.col);

    expect(spanBgHex(controlSpan)).toBe(
      stationColorSnapshotValue(LIGHT_THEME.interaction.compactFocus),
    );
    expect(spanBgHex(canvasSpan)).toBe(stationColorSnapshotValue(LIGHT_THEME.surfaces.canvas));
    expect(
      themeContrast(LIGHT_THEME.interaction.compactFocus, LIGHT_THEME.surfaces.canvas),
    ).toBeGreaterThan(1.1);
  });

  it("keeps focused light sheet-button roles readable", async () => {
    const fixture = makeStationTestRuntime();
    const lightSource: StationThemeSource = {
      getSnapshot: () => LIGHT_THEME,
      subscribe: () => () => {},
    };
    const setup = await render(fixture.runtime, SURFACE, NO_OP_OPEN_URL, lightSource);
    const row = cellFor(setup.captureCharFrame(), "docs-cleanup");

    await actOn(async () => {
      fixture.runtime.actions.handleKey({ input: "X" });
      await setup.flush();
      await setup.mockMouse.click(row.col, row.row, MouseButtons.LEFT);
      fixture.runtime.actions.handleKey({ input: "", leftArrow: true });
      await setup.flush();
    });

    const frame = setup.captureCharFrame();
    const deleteButton = cellFor(frame, "Delete (Y)");
    const shortcut = cellFor(frame, "(Y)");
    const deleteSpan = spanAtFrameCell(
      setup.captureSpans(),
      deleteButton.row,
      deleteButton.col,
    );
    const shortcutSpan = spanAtFrameCell(setup.captureSpans(), shortcut.row, shortcut.col);

    expect(spanHex(deleteSpan)).toBe(stationColorSnapshotValue(LIGHT_THEME.action.danger));
    expect(spanHex(shortcutSpan)).toBe(
      stationColorSnapshotValue(LIGHT_THEME.action.warning),
    );
    expect(spanBgHex(deleteSpan)).toBe(
      stationColorSnapshotValue(LIGHT_THEME.interaction.keyboardFocus),
    );
    expect(
      themeContrast(LIGHT_THEME.action.danger, LIGHT_THEME.interaction.keyboardFocus),
    ).toBeGreaterThanOrEqual(STATION_TEXT_CONTRAST_RATIO);
    expect(
      themeContrast(LIGHT_THEME.action.warning, LIGHT_THEME.interaction.keyboardFocus),
    ).toBeGreaterThanOrEqual(STATION_TEXT_CONTRAST_RATIO);
  });

  it("repaints in place when the external theme source changes", async () => {
    const fixture = makeStationTestRuntime();
    const source = new MutableThemeSource(DARK_THEME);
    const setup = await render(fixture.runtime, SURFACE, NO_OP_OPEN_URL, source);
    const title = cellFor(setup.captureCharFrame(), "station · overview");
    const darkBackground = spanBgHex(
      spanAtFrameCell(setup.captureSpans(), title.row, title.col),
    );

    await actOn(async () => {
      source.setSnapshot(LIGHT_THEME);
      await Promise.resolve();
    });
    await setup.flush();

    const lightBackground = spanBgHex(
      spanAtFrameCell(setup.captureSpans(), title.row, title.col),
    );
    expect(darkBackground).toBe(darkTerminalColors.defaultBackground);
    expect(lightBackground).toBe(lightTerminalColors.defaultBackground);
    expect(setup.captureCharFrame()).toContain("station · overview");
  });

  for (const testCase of [
    { name: "prompt", keys: ["R"], needle: "Rename:" },
    { name: "bottom sheet", keys: ["C"], needle: "Collapse Project" },
    { name: "Help overlay", keys: ["H"], needle: "station help" },
    { name: "widget settings", keys: ["W"], needle: "saved to config.toml" },
    { name: "project settings", keys: ["P", "1"], needle: "Project settings" },
  ] as const) {
    it(`uses terminal-default background intent for the ${testCase.name}`, async () => {
      const fixture = makeStationTestRuntime();
      const setup = await render(fixture.runtime);

      await actOn(async () => {
        for (const input of testCase.keys) {
          fixture.runtime.actions.handleKey({ input });
        }
        await setup.flush();
      });

      expectTerminalDefaultBackground(setup, testCase.needle);
    });
  }

  it("uses terminal-default background intent for dashboard toasts", async () => {
    const fixture = makeStationTestRuntime();
    const setup = await render(fixture.runtime);

    await actOn(async () => {
      fixture.runtime.actions.pushToast({
        kind: "error",
        message: "Surface ownership notice",
      });
      await setup.flush();
    });

    expectTerminalDefaultBackground(setup, "Surface ownership notice");
  });

  it("obscures dashboard cells with an opaque default background and restores them", async () => {
    const fixture = makeStationTestRuntime();
    const setup = await render(fixture.runtime);
    const before = setup.captureCharFrame();

    await actOn(async () => {
      fixture.runtime.actions.handleKey({ input: "H" });
      await setup.flush();
    });

    const after = setup.captureCharFrame();
    const obscured = findObscuredHelpCell(before, after);
    const span = spanAtFrameCell(setup.captureSpans(), obscured.row, obscured.col);
    expect(frameChar(after, obscured.row, obscured.col)).toBe(" ");
    expect(span?.bg.intent).toBe("default");

    await actOn(async () => {
      fixture.runtime.actions.handleKey({ input: "Q" });
      await setup.flush();
    });

    expect(frameChar(setup.captureCharFrame(), obscured.row, obscured.col)).toBe(obscured.original);
  });
});

describe("FullscreenDashboard mouse composition", () => {
  it("routes a row click into the observer-backed dashboard command flow", async () => {
    const fixture = makeStationTestRuntime();
    const setup = await render(fixture.runtime);
    const row = cellFor(setup.captureCharFrame(), "docs-cleanup");

    await actOn(async () => {
      await setup.mockMouse.click(row.col, row.row, MouseButtons.LEFT);
      await setup.flush();
    });
    const startFresh = cellFor(setup.captureCharFrame(), "Start fresh (Y)");
    await actOn(async () => {
      await setup.mockMouse.click(startFresh.col, startFresh.row, MouseButtons.LEFT);
      await waitFor(() =>
        fixture.service.dispatched.some(
          (command) =>
            command.type === "session.startAgent" &&
            command.payload.worktreeId === "wt_station_none",
        ),
      );
    });

    expect(fixture.service.waitedForCommandIds).toEqual(["cmd_tui_1"]);
  });

  it("collapses a project once for a complete primary down/up click", async () => {
    const fixture = makeStationTestRuntime();
    const setup = await render(fixture.runtime);
    const header = cellFor(setup.captureCharFrame(), "▼ station");

    await actOn(() => setup.mockMouse.click(header.col, header.row, MouseButtons.LEFT));

    expect([...fixture.runtime.state.getState().collapsedProjectIds]).toEqual(["station"]);
  });

  it("renders and routes exact Group targets without standalone behavior drift", async () => {
    const size = { width: 120, height: 40 };
    const fixture = makeStationTestRuntime({
      snapshot: groupedManyProjectsSnapshot(),
    });
    const setup = await render(fixture.runtime, size);
    const groupId = dashboardRowIds.group("group_design_refresh");
    const groupLine = (): { row: number; line: string } => {
      const lines = setup.captureCharFrame().split("\n");
      const row = lines.findIndex((line) => line.includes("Design refresh"));
      return { row, line: lines[row] ?? "" };
    };

    expect(setup.captureCharFrame()).toContain("│ ▼ Design refresh 2 sessions");
    expect(setup.captureCharFrame()).toContain("│ [1]");
    const member = cellFor(setup.captureCharFrame(), "group-contracts");
    await actOn(async () => {
      await setup.mockMouse.click(member.col, member.row, MouseButtons.LEFT);
      await waitFor(() =>
        fixture.service.dispatched.some(
          (command) =>
            command.type === "terminal.focus" &&
            command.payload.sessionId === "ses_wt_group_contracts",
        ),
      );
    });
    expect(
      fixture.service.dispatched.filter(
        (command) =>
          command.type === "terminal.focus" &&
          command.payload.sessionId === "ses_wt_group_contracts",
      ),
    ).toHaveLength(1);
    let group = groupLine();
    await actOn(async () => {
      await setup.mockMouse.click(
        group.line.indexOf("[quick session]"),
        group.row,
        MouseButtons.LEFT,
      );
      await setup.flush();
    });
    expect(fixture.runtime.state.getState().dashboardFocus).toEqual({
      rowId: groupId,
      cellId: "quickSession",
    });
    expect(groupLine().line).toContain("▸[quick session]");
    expect([...fixture.runtime.state.getState().collapsedGroupIds]).toEqual([]);

    group = groupLine();
    const menuTarget = setup.renderer.root.findDescendantById(
      groupActionRenderableId(groupId, "menu"),
    );
    expect(menuTarget).toBeDefined();
    expect(group.line.indexOf("[▾]")).toBe(menuTarget?.screenX);
    const hit = Renderable.renderablesByNumber.get(
      setup.renderer.hitTest(group.line.indexOf("[▾]"), group.row),
    );
    expect(hit?.num).toBe(menuTarget?.num);
    await actOn(async () => {
      await setup.mockMouse.click(group.line.indexOf("[▾]"), group.row, MouseButtons.LEFT);
      await setup.flush();
    });
    expect(fixture.runtime.state.getState().dashboardFocus).toEqual({
      rowId: groupId,
      cellId: "menu",
    });
    expect([...fixture.runtime.state.getState().collapsedGroupIds]).toEqual([]);
    expect(fixture.runtime.state.getState().screen).toEqual({
      name: "groupMenu",
      projectId: "station",
      groupId: "group_design_refresh",
      focus: "quickSession",
    });
    expect(setup.captureCharFrame()).toContain("Group settings…");
    const settings = cellFor(setup.captureCharFrame(), "Group settings…");
    await actOn(async () => {
      await setup.mockMouse.click(settings.col, settings.row, MouseButtons.LEFT);
      await setup.flush();
    });
    expect(fixture.runtime.state.getState().screen).toMatchObject({
      name: "groupSettings",
      groupId: "group_design_refresh",
      section: "general",
    });
    await actOn(async () => {
      fixture.runtime.actions.dispatch({ type: "groupSettings.back" });
      await setup.flush();
    });

    group = groupLine();
    await actOn(async () => {
      await setup.mockMouse.click(
        group.line.indexOf("Design refresh"),
        group.row,
        MouseButtons.LEFT,
      );
      await setup.flush();
    });
    expect([...fixture.runtime.state.getState().collapsedGroupIds]).toEqual([
      "group_design_refresh",
    ]);
    expect(fixture.runtime.state.getState().dashboardFocus).toEqual({
      rowId: groupId,
      cellId: "identity",
    });
    expect(setup.captureCharFrame()).toContain("▶ Design refresh 2 sessions");
    expect(setup.captureCharFrame()).not.toContain("group-contracts");
  });

  it("does not activate a dashboard row when the same click dismisses a bounded screen", async () => {
    const fixture = makeStationTestRuntime();
    const setup = await render(fixture.runtime);
    const frame = setup.captureCharFrame();
    const row = cellFor(frame, "docs-cleanup");
    const titleAction = cellFor(frame, "[+]");
    await actOn(async () => {
      fixture.runtime.actions.handleKey({ input: "H" });
      await setup.flush();
    });
    await actOn(async () => {
      await setup.mockMouse.moveTo(row.col, row.row);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await setup.flush();

    expect(spanBgHex(spanAtFrameCell(setup.captureSpans(), row.row, SURFACE.width - 2))).not.toBe(
      stationColorSnapshotValue(DARK_THEME.interaction.hover),
    );

    await actOn(async () => {
      await setup.mockMouse.moveTo(titleAction.col, titleAction.row);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await setup.flush();

    expect(spanHex(spanAtFrameCell(setup.captureSpans(), titleAction.row, titleAction.col))).toBe(
      stationColorSnapshotValue(DARK_THEME.text.muted),
    );

    await actOn(async () => {
      await setup.mockMouse.click(row.col, row.row, MouseButtons.LEFT);
    });

    expect(fixture.runtime.state.getState().screen).toEqual({ name: "dashboard" });
    expect(fixture.runtime.state.getState().localRows.pendingStart).toEqual([]);
  });

  it("dismisses a bounded screen from the obscured title row", async () => {
    const fixture = makeStationTestRuntime();
    const setup = await render(fixture.runtime);
    const titleAction = cellFor(setup.captureCharFrame(), "[+]");
    await actOn(async () => {
      fixture.runtime.actions.handleKey({ input: "H" });
      await setup.flush();
    });

    await actOn(() => setup.mockMouse.click(titleAction.col, titleAction.row, MouseButtons.LEFT));

    expect(fixture.runtime.state.getState().screen).toEqual({ name: "dashboard" });
    expect(fixture.runtime.state.getState().localRows.pendingStart).toEqual([]);
  });

  it("dismisses outside a bounded screen while its inner surface still consumes clicks", async () => {
    const fixture = makeStationTestRuntime();
    const setup = await render(fixture.runtime);
    await actOn(async () => {
      fixture.runtime.actions.handleKey({ input: "H" });
      await setup.flush();
    });
    const help = cellFor(setup.captureCharFrame(), "station help");

    await actOn(() => setup.mockMouse.click(help.col, help.row, MouseButtons.LEFT));
    expect(fixture.runtime.state.getState().screen).toEqual({ name: "help" });

    await actOn(() => setup.mockMouse.click(0, 0, MouseButtons.LEFT));
    expect(fixture.runtime.state.getState().screen).toEqual({ name: "dashboard" });
  });

  it("keeps controls inside a bounded screen interactive", async () => {
    const fixture = makeStationTestRuntime();
    const setup = await render(fixture.runtime);
    await actOn(async () => {
      fixture.runtime.actions.handleKey({ input: "W" });
      await setup.flush();
    });
    const addWidget = cellFor(setup.captureCharFrame(), "[ + add widget ]");

    await actOn(async () => {
      await setup.mockMouse.moveTo(addWidget.col, addWidget.row);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await setup.flush();

    expect(spanBgHex(spanAtFrameCell(setup.captureSpans(), addWidget.row, addWidget.col))).toBe(
      stationColorSnapshotValue(DARK_THEME.interaction.hover),
    );

    await actOn(() => setup.mockMouse.click(addWidget.col, addWidget.row, MouseButtons.LEFT));

    expect(fixture.runtime.state.getState().screen).toMatchObject({
      name: "widgetSettings",
      focus: "picker",
    });
  });

  it("omits click-away interception while choose-row screens select dashboard rows", async () => {
    const fixture = makeStationTestRuntime();
    const setup = await render(fixture.runtime);
    await actOn(async () => {
      fixture.runtime.actions.handleKey({ input: "X" });
      await setup.flush();
    });
    const row = cellFor(setup.captureCharFrame(), "docs-cleanup");

    await actOn(async () => {
      await setup.mockMouse.moveTo(row.col, row.row);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await setup.flush();

    expect(spanBgHex(spanAtFrameCell(setup.captureSpans(), row.row, SURFACE.width - 2))).toBe(
      stationColorSnapshotValue(DARK_THEME.interaction.hover),
    );

    await actOn(() => setup.mockMouse.click(row.col, row.row, MouseButtons.LEFT));

    expect(fixture.runtime.state.getState().screen).toMatchObject({
      name: "removeWorktree",
      step: "confirm",
      rowId: "ses_wt_station_none",
    });
  });

  it("routes rendered Remove actions without leaking to the dashboard", async () => {
    const fixture = makeStationTestRuntime();
    const setup = await render(fixture.runtime);
    const row = cellFor(setup.captureCharFrame(), "docs-cleanup");
    await actOn(async () => {
      fixture.runtime.actions.handleKey({ input: "X" });
      await setup.flush();
      await setup.mockMouse.click(row.col, row.row, MouseButtons.LEFT);
      await setup.flush();
    });
    const keep = cellFor(setup.captureCharFrame(), "Keep session");

    await actOn(() => setup.mockMouse.click(keep.col, keep.row, MouseButtons.LEFT));

    expect(fixture.runtime.state.getState().screen).toEqual({ name: "dashboard" });
    expect(fixture.runtime.state.getState().localRows.pendingRemove).toEqual([]);
  });

  it("routes rendered Fork field clicks without submitting", async () => {
    const fixture = makeStationTestRuntime();
    const setup = await render(fixture.runtime);
    const row = cellFor(setup.captureCharFrame(), "docs-cleanup");
    await actOn(async () => {
      fixture.runtime.actions.handleKey({ input: "F" });
      await setup.flush();
      await setup.mockMouse.click(row.col, row.row, MouseButtons.LEFT);
      await setup.flush();
    });
    const copy = cellFor(setup.captureCharFrame(), "Copy");

    await actOn(() => setup.mockMouse.click(copy.col, copy.row, MouseButtons.LEFT));
    expect(fixture.runtime.state.getState().screen).toMatchObject({
      name: "fork",
      step: "details",
      focus: "copyDirty",
      copyDirty: false,
    });
    const name = cellFor(setup.captureCharFrame(), "Name");

    await actOn(() => setup.mockMouse.click(name.col, name.row, MouseButtons.LEFT));
    expect(fixture.runtime.state.getState().screen).toMatchObject({
      name: "fork",
      step: "details",
      focus: "name",
      copyDirty: false,
    });
  });

  it("routes the grouped Fork placement row through standalone pointer input", async () => {
    const fixture = makeStationTestRuntime({
      snapshot: groupedManyProjectsSnapshot(),
    });
    const setup = await render(fixture.runtime);
    await actOn(async () => {
      fixture.runtime.actions.dispatch({
        type: "forkSession.openDetails",
        rowId: "ses_wt_group_contracts",
        returnTo: "dashboard",
      });
      await setup.flush();
    });
    const group = cellFor(setup.captureCharFrame(), "[x] create in");

    await actOn(() => setup.mockMouse.click(group.col, group.row, MouseButtons.LEFT));
    expect(fixture.runtime.state.getState().screen).toMatchObject({
      name: "fork",
      step: "details",
      focus: "group",
      sourceGroup: { id: "group_design_refresh", name: "Design refresh" },
      inheritSourceGroup: false,
    });
  });

  it("scrolls when the wheel is used over a child row", async () => {
    const fixture = makeStationTestRuntime();
    const setup = await render(fixture.runtime, { width: 80, height: 12 });
    const row = cellFor(setup.captureCharFrame(), "docs-cleanup");
    const before = fixture.runtime.layout.snapshot();

    await actOn(() => setup.mockMouse.scroll(row.col, row.row, "down"));

    expect(fixture.runtime.layout.snapshot()).not.toEqual(before);
  });

  it("renders and routes the same project actions as native Station", async () => {
    const size = { width: 120, height: 40 };
    const fixture = makeStationTestRuntime();
    const setup = await render(fixture.runtime, size);
    const frame = setup.captureCharFrame();

    expect(frame).toContain("▼ station");
    expect(frame).toContain("no sessions yet");
    expect(frame).toContain("[shell]");
    expect(frame).toContain("[quick session]");
    expect(frame).toContain("[▾]");
    expect(frame).toContain("[ + add session ]");

    const shell = cellFor(frame, "[shell]");
    const quickSession = cellFor(frame, "[quick session]");
    const agentPicker = cellFor(frame, "[▾]");
    await actOn(async () => {
      await setup.mockMouse.click(shell.col, shell.row, MouseButtons.LEFT);
      await setup.mockMouse.click(quickSession.col, quickSession.row, MouseButtons.LEFT);
      await waitFor(() =>
        fixture.service.dispatched.some((command) => command.type === "session.create"),
      );
      await setup.mockMouse.click(agentPicker.col, agentPicker.row, MouseButtons.LEFT);
    });

    expect(fixture.runtime.state.getState().screen).toMatchObject({
      name: "projectMenu",
      projectId: "station",
      focus: "quickGroup",
    });
  });

  it("routes the empty-project add-session button and pull-request links", async () => {
    const size = { width: 120, height: 40 };
    const fixture = makeStationTestRuntime();
    const openedUrls: string[] = [];
    const setup = await render(fixture.runtime, size, (url: string) => openedUrls.push(url));
    const frame = setup.captureCharFrame();
    const addSession = cellFor(frame, "[ + add session ]");
    const pullRequest = cellFor(frame, "#73");

    await actOn(async () => {
      await setup.mockMouse.click(addSession.col, addSession.row, MouseButtons.LEFT);
      await waitFor(() =>
        fixture.service.dispatched.some((command) => command.type === "session.create"),
      );
      await setup.mockMouse.click(pullRequest.col, pullRequest.row, MouseButtons.LEFT);
    });

    expect(openedUrls).toEqual(["https://github.com/example/station/pull/73"]);
  });

  it("keeps the dashboard open with its existing toast when a clicked command is rejected", async () => {
    const fixture = makeStationTestRuntime();
    fixture.service.nextReceipt = {
      commandId: "cmd_tui_rejected",
      accepted: false,
      status: "rejected",
      error: {
        tag: "CommandDispatchError",
        code: "TEST_REJECTED",
        message: "The test observer rejected this command.",
      },
    };
    const setup = await render(fixture.runtime);
    const row = cellFor(setup.captureCharFrame(), "docs-cleanup");

    await actOn(async () => {
      await setup.mockMouse.click(row.col, row.row, MouseButtons.LEFT);
      await setup.flush();
    });
    const startFresh = cellFor(setup.captureCharFrame(), "Start fresh (Y)");
    await actOn(async () => {
      await setup.mockMouse.click(startFresh.col, startFresh.row, MouseButtons.LEFT);
      await waitFor(() =>
        fixture.runtime.state
          .getState()
          .toasts.some(
            (entry) => entry.toast.message === "The test observer rejected this command.",
          ),
      );
    });
    await setup.flush();

    expect(fixture.runtime.state.getState().screen).toEqual({ name: "dashboard" });
    expect(setup.captureCharFrame()).toContain("The test observer rejected this command.");
  });
});

describe("FullscreenDashboard configured widgets", () => {
  async function renderWidgets(widgets: readonly TuiWidgetConfig[]) {
    const fixture = makeStationTestRuntime({
      initialState: { widgets },
    });
    const setup = await render(fixture.runtime, WIDGET_SURFACE);
    return { setup, store: fixture.runtime };
  }

  it("renders resolved configured widgets in the standalone title row at 99x25", async () => {
    const { setup } = await renderWidgets([{ type: "fleet" }, { type: "prs" }]);

    const titleRow = setup.captureCharFrame().split("\n")[0] ?? "";
    expect(titleRow).toContain("station · overview");
    expect(titleRow).toContain("7 agents · 7 open PRs");
    expect(titleRow).toContain("[+]");
  });

  it("shows the configured definitions in widget settings", async () => {
    const { setup, store } = await renderWidgets([{ type: "fleet" }, { type: "prs" }]);

    await actOn(async () => {
      store.actions.handleKey({ input: "W" });
      await setup.flush();
    });

    const frame = setup.captureCharFrame();
    expect(frame).toContain("[on ] fleet");
    expect(frame).toContain("[on ] open PRs");
    expect(frame).not.toContain("no widgets yet");
  });

  it("keeps the default title stable without fabricating widget values", async () => {
    const { setup, store } = await renderWidgets([]);

    const titleRow = setup.captureCharFrame().split("\n")[0] ?? "";
    expect(titleRow).toContain("station · overview");
    expect(titleRow).toContain("[+]");
    expect(titleRow).not.toContain("agents");
    expect(titleRow).not.toContain("open PR");

    await actOn(async () => {
      store.actions.handleKey({ input: "W" });
      await setup.flush();
    });
    expect(setup.captureCharFrame()).toContain("no widgets yet");
  });
});

async function render(
  store: ReturnType<typeof makeStationTestRuntime>["runtime"],
  size: { width: number; height: number } = SURFACE,
  openUrl: (url: string) => void = NO_OP_OPEN_URL,
  themeSource: StationThemeSource = DARK_THEME_SOURCE,
) {
  const setup = await testRender(
    <StandaloneDashboardApp
      runtime={store}
      openUrl={openUrl}
      onCopyNotice={() => {}}
      themeSource={themeSource}
    />,
    size,
  );
  await setup.flush();
  teardowns.push(() =>
    actOn(async () => {
      setup.renderer.destroy();
      await Promise.resolve();
    }),
  );
  return setup;
}

async function actOn(action: () => void | Promise<void>): Promise<void> {
  await act(async () => {
    await action();
  });
}

function cellFor(frame: string, needle: string): { col: number; row: number } {
  const lines = frame.split("\n");
  const row = lines.findIndex((line) => line.includes(needle));
  const col = row < 0 ? -1 : (lines[row]?.indexOf(needle) ?? -1);
  if (row < 0 || col < 0) {
    throw new Error(`Could not find ${JSON.stringify(needle)} in frame:\n${frame}`);
  }
  return { col, row };
}

function findObscuredHelpCell(
  before: string,
  after: string,
): { row: number; col: number; original: string } {
  const lines = after.split("\n");
  const top = lines.findIndex((line) => line.includes("╭") && line.includes("╮"));
  const topCells = [...(lines[top] ?? "")];
  const left = topCells.indexOf("╭");
  const right = topCells.lastIndexOf("╮");
  const bottom = lines.findIndex((line, row) => row > top && frameChar(line, 0, left) === "╰");
  if (top < 0 || left < 0 || right <= left || bottom <= top) {
    throw new Error(`Could not locate Help bounds in frame:\n${after}`);
  }

  for (let row = top + 1; row < bottom; row += 1) {
    for (let col = left + 1; col < right; col += 1) {
      const original = frameChar(before, row, col);
      if (/^[A-Za-z0-9]$/u.test(original) && frameChar(after, row, col) === " ") {
        return { row, col, original };
      }
    }
  }
  throw new Error(`Help did not obscure a stable dashboard character:\n${after}`);
}

function spanHex(span: ReturnType<typeof spanAtFrameCell>): string | undefined {
  return span?.fg === undefined ? undefined : rgbToHex(span.fg);
}

function themeContrast(first: StationColor, second: StationColor): number {
  const luminance = (color: StationColor): number => {
    const value = stationColorSnapshotValue(color);
    const channels = [value.slice(1, 3), value.slice(3, 5), value.slice(5, 7)].map((part) => {
      const channel = Number.parseInt(part, 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
  };
  const firstLuminance = luminance(first);
  const secondLuminance = luminance(second);
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

function spanBgHex(span: ReturnType<typeof spanAtFrameCell>): string | undefined {
  return span?.bg === undefined ? undefined : rgbToHex(span.bg);
}

function expectTerminalDefaultBackground(
  setup: Awaited<ReturnType<typeof testRender>>,
  needle: string,
  theme: StationTheme = DARK_THEME,
): void {
  const cell = cellFor(setup.captureCharFrame(), needle);
  const span = spanAtFrameCell(setup.captureSpans(), cell.row, cell.col);
  expect(span?.bg.intent).toBe("default");
  expect(spanBgHex(span)).toBe(stationColorSnapshotValue(theme.text.inverse));
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 750;
  for (;;) {
    if (assertion()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for assertion");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
