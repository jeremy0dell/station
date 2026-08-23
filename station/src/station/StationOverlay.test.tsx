import { afterEach, describe, expect, it } from "bun:test";
import { rgbToHex } from "@opentui/core";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import type { StationTestDashboardRuntime } from "./test/support/makeStationTestRuntime.js";
import { dashboardRowIds } from "@station/dashboard-core/selectors";
import { act } from "react";
import type { StationMouseEvent } from "../input/mouse.js";
import type { MouseTargetRef } from "../input/router.js";
import { spanAtFrameCell } from "../terminal/testing/frameProbe.js";
import { routeStationMouse } from "./input/stationMouse.js";
import { groupedManyProjectsSnapshot } from "./fixtures/scenarios.js";
import { makeStationTestRuntime } from "./test/support/makeStationTestRuntime.js";
import { StationOverlay, stationPopupLayout } from "./StationOverlay.js";
import {
  nativeStationTheme,
  stationColorSnapshotValue,
  StationThemeProvider,
} from "../theme/index.js";

const SURFACE = { width: 100, height: 28 };
const teardowns: Array<() => void> = [];

describe("StationOverlay", () => {
  afterEach(() => {
    for (const teardown of teardowns.splice(0)) {
      teardown();
    }
  });

  it("keeps native dashboard surfaces on the current Station RGB colors", async () => {
    const { runtime: store } = makeStationTestRuntime();
    const setup = await renderOverlay(() => true, store);
    const title = cellFor(setup.captureCharFrame(), "station · overview");
    let span = spanAtFrameCell(setup.captureSpans(), title.row, title.col);
    expect(span?.bg.intent).toBe("rgb");
    expect(spanBgHex(span)).toBe(stationColorSnapshotValue(nativeStationTheme.surfaces.panel));

    await act(async () => {
      store.actions.handleKey({ input: "H" });
      await setup.flush();
    });
    const help = cellFor(setup.captureCharFrame(), "station help");
    span = spanAtFrameCell(setup.captureSpans(), help.row, help.col);
    expect(span?.bg.intent).toBe("rgb");
    expect(spanBgHex(span)).toBe(stationColorSnapshotValue(nativeStationTheme.surfaces.help));
  });

  it("routes primary clicks outside the popup through the STATION backdrop target", async () => {
    const calls: Array<{ target: MouseTargetRef; event: StationMouseEvent }> = [];
    const setup = await renderOverlay((target, event) => {
      calls.push({ target, event });
      return true;
    });
    const layout = stationPopupLayout(SURFACE.width, SURFACE.height);

    await setup.mockMouse.click(layout.left - 1, layout.top - 1, MouseButtons.LEFT);

    expect(calls).toEqual([
      {
        target: { kind: "stationBackdrop" },
        event: {
          type: "down",
          button: "left",
          rawButton: 0,
          x: layout.left - 1,
          y: layout.top - 1,
          modifiers: { shift: false, alt: false, ctrl: false },
        },
      },
    ]);
  });

  it("routes right-clicks outside the popup through the STATION backdrop target", async () => {
    const calls: Array<{ target: MouseTargetRef; event: StationMouseEvent }> = [];
    const setup = await renderOverlay((target, event) => {
      calls.push({ target, event });
      return true;
    });
    const layout = stationPopupLayout(SURFACE.width, SURFACE.height);

    await setup.mockMouse.click(layout.left - 1, layout.top - 1, MouseButtons.RIGHT);

    expect(calls[0]).toMatchObject({
      target: { kind: "stationBackdrop" },
      event: { type: "down", button: "right", rawButton: 2 },
    });
  });

  it("routes wheel outside the popup through the STATION backdrop target", async () => {
    const calls: Array<{ target: MouseTargetRef; event: StationMouseEvent }> = [];
    const setup = await renderOverlay((target, event) => {
      calls.push({ target, event });
      return true;
    });
    const layout = stationPopupLayout(SURFACE.width, SURFACE.height);

    await setup.mockMouse.scroll(layout.left - 1, layout.top - 1, "down");

    expect(calls[0]).toMatchObject({
      target: { kind: "stationBackdrop" },
      event: { type: "scroll", button: "wheel-down", scrollDirection: "down" },
    });
  });

  it("does not route popup border clicks as backdrop clicks", async () => {
    const calls: Array<{ target: MouseTargetRef; event: StationMouseEvent }> = [];
    const setup = await renderOverlay((target, event) => {
      calls.push({ target, event });
      return true;
    });
    const layout = stationPopupLayout(SURFACE.width, SURFACE.height);

    await setup.mockMouse.click(layout.left, layout.top, MouseButtons.LEFT);

    expect(calls).toEqual([]);
  });

  it("keeps existing STATION child mouse targets inside the popup", async () => {
    const calls: Array<{ target: MouseTargetRef; event: StationMouseEvent }> = [];
    const setup = await renderOverlay((target, event) => {
      calls.push({ target, event });
      return true;
    });
    const frame = setup.captureCharFrame();
    const lines = frame.split("\n");
    // Exclude the pinned FLEET bar (which also contains "working") so we target
    // an actual working session row.
    const row = lines.findIndex((line) => line.includes("working") && !line.includes("FLEET"));
    const col = lines[row]?.indexOf("working") ?? -1;
    expect(row).toBeGreaterThan(0);
    expect(col).toBeGreaterThan(0);

    await setup.mockMouse.click(col, row, MouseButtons.LEFT);

    expect(calls.at(-1)?.target).toEqual({
      kind: "station",
      target: { kind: "dashboardCell", rowId: dashboardRowIds.session("ses_wt_station_working"), cellId: "identity" },
    });
  });

  it("renders the same Group row and cell identities in native Station", async () => {
    const { runtime: store } = makeStationTestRuntime({
      snapshot: groupedManyProjectsSnapshot(),
    });
    const calls: MouseTargetRef[] = [];
    const setup = await renderOverlay((target, event) => {
      calls.push(target);
      if (target.kind === "station") routeStationMouse(target.target, event, store);
      return true;
    }, store);
    const groupId = dashboardRowIds.group("group_design_refresh");
    const header = cellFor(setup.captureCharFrame(), "Design refresh");

    expect(setup.captureCharFrame()).toContain("╭ ▼ Design refresh 2 sessions");
    await setup.mockMouse.click(header.col, header.row, MouseButtons.LEFT);

    expect(calls.at(-1)).toEqual({
      kind: "station",
      target: { kind: "dashboardCell", rowId: groupId, cellId: "identity" },
    });
    expect([...store.state.getState().collapsedGroupIds]).toEqual(["group_design_refresh"]);
    expect(setup.captureCharFrame()).toContain("▸▶ Design refresh 2 sessions");
  });

  it("lets an inner screen consume popup click-away before the outer overlay", async () => {
    const { runtime: store } = makeStationTestRuntime();
    const calls: MouseTargetRef[] = [];
    const setup = await renderOverlay((target, event) => {
      calls.push(target);
      if (target.kind === "station") {
        routeStationMouse(target.target, event, store);
      }
      return true;
    }, store);
    const layout = stationPopupLayout(SURFACE.width, SURFACE.height);
    const row = cellFor(setup.captureCharFrame(), "docs-cleanup");

    await act(async () => {
      store.actions.handleKey({ input: "H" });
      await setup.flush();
    });
    await act(async () => {
      await setup.mockMouse.moveTo(row.col, row.row);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await setup.flush();

    expect(spanBgHex(spanAtFrameCell(setup.captureSpans(), row.row, row.col))).not.toBe(
      stationColorSnapshotValue(nativeStationTheme.interaction.hover),
    );

    await setup.mockMouse.click(layout.left + 1, layout.top + 1, MouseButtons.LEFT);

    expect(store.state.getState().screen).toEqual({ name: "dashboard" });
    expect(calls).toEqual([{ kind: "station", target: { kind: "screenBackdrop" } }]);
  });

  it("routes obscured title-row clicks through the inner screen backdrop", async () => {
    const { runtime: store } = makeStationTestRuntime();
    const calls: Array<{ target: MouseTargetRef; event: StationMouseEvent }> = [];
    const setup = await renderOverlay((target, event) => {
      calls.push({ target, event });
      if (target.kind === "station") {
        routeStationMouse(target.target, event, store);
      }
      return true;
    }, store);
    const titleAction = cellFor(setup.captureCharFrame(), "[+]");
    await act(async () => {
      store.actions.handleKey({ input: "H" });
      await setup.flush();
    });

    await setup.mockMouse.click(titleAction.col, titleAction.row, MouseButtons.RIGHT);

    expect(store.state.getState().screen).toEqual({ name: "help" });
    expect(calls.at(-1)).toMatchObject({
      target: { kind: "station", target: { kind: "screenBackdrop" } },
      event: { type: "down", button: "right", rawButton: 2 },
    });

    await setup.mockMouse.click(titleAction.col, titleAction.row, MouseButtons.LEFT);

    expect(store.state.getState().screen).toEqual({ name: "dashboard" });
    expect(calls.at(-1)).toMatchObject({
      target: { kind: "station", target: { kind: "screenBackdrop" } },
      event: { type: "down", button: "left", rawButton: 0 },
    });
  });
});

async function renderOverlay(
  dispatchMouse: (target: MouseTargetRef, event: StationMouseEvent) => boolean = () => true,
  store: StationTestDashboardRuntime = makeStationTestRuntime().runtime,
) {
  const setup = await testRender(
    <StationThemeProvider theme={nativeStationTheme}>
      <StationOverlay state={store.state} actions={store.actions} layout={store.layout} dispatchMouse={dispatchMouse} onCopyNotice={() => {}} />
    </StationThemeProvider>,
    SURFACE,
  );
  await setup.flush();
  teardowns.push(() => setup.renderer.destroy());
  return setup;
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

function spanBgHex(span: ReturnType<typeof spanAtFrameCell>): string | undefined {
  if (span?.bg === undefined) {
    return undefined;
  }
  return rgbToHex(span.bg);
}
