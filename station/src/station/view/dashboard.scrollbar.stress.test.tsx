// Crowded dashboard + Help: last-cell/drag identity, one-row wheels with a
// stuck thumb, and Help click-away vs the inset bar.
import { afterEach, describe, expect, it } from "bun:test";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import {
  dashboardScrollGutterChrome,
  helpOverlayContent,
  helpPanelLayout,
  helpPanelModel,
  selectDashboardViewport,
} from "@station/dashboard-core/selectors";
import { act } from "react";
import { createCrowdedDashboardSnapshot } from "../../../../packages/dashboard-core/test/fixtures/snapshots.js";
import { normalizeStationMouseEvent } from "../../input/mouse.js";
import { stationKeymapHelp } from "../../input/keymap/stationBindings.js";
import { nativeStationTheme, StationThemeProvider } from "../../theme/index.js";
import { makeStationTestRuntime } from "../test/support/makeStationTestRuntime.js";
import { routeStationMouse } from "../input/stationMouse.js";
import { DashboardRoot } from "./DashboardRoot.js";
import { StationHoverProvider, StationMouseProvider } from "./stationMouseContext.js";

const SIZE = { width: 80, height: 24 };
const SESSION_COUNT = 300;
const MOUSE = { delayMs: 0 } as const;
const THUMB = /[█▀▄]/;

describe("dashboard and help scrollbar stress", () => {
  const teardowns: Array<() => void> = [];
  afterEach(() => {
    for (const teardown of teardowns.splice(0)) {
      teardown();
    }
  });

  it("clicking the last gutter cell shows the same last window as scrollTo(max)", async () => {
    const setup = await renderCrowded();
    const expected = captureMaxWindow(setup);
    await act(async () => {
      setup.store.actions.dispatch({ type: "dashboard.scrollTo", offset: 0 });
      await Promise.resolve();
    });
    await setup.flush();
    const gutter = gutterGeometry(setup);
    await act(async () => {
      await setup.mockMouse.click(gutter.x, gutter.lastY, MouseButtons.LEFT, MOUSE);
    });
    await setup.flush();
    expect(setup.store.state.getState().scrollOffset).toBe(expected.offset);
    expect(currentWindow(setup)).toEqual(expected);
    expect(gutterColumn(setup).slice(gutter.chromeTop, gutter.lastY + 1).join("")).toMatch(THUMB);
  });

  it("clicking the last gutter cell while already at max does not leave the last window", async () => {
    const setup = await renderCrowded();
    const expected = captureMaxWindow(setup);
    await setup.flush();
    const gutter = gutterGeometry(setup);
    await act(async () => {
      await setup.mockMouse.click(gutter.x, gutter.lastY, MouseButtons.LEFT, MOUSE);
    });
    await setup.flush();
    expect(currentWindow(setup)).toEqual(expected);
  });

  it("clicking the first gutter cell from the bottom shows the first window", async () => {
    const setup = await renderCrowded();
    const atTop = currentWindow(setup);
    expect(atTop.offset).toBe(0);
    captureMaxWindow(setup);
    await setup.flush();
    expect(currentWindow(setup).offset).toBeGreaterThan(0);
    const gutter = gutterGeometry(setup);
    await act(async () => {
      await setup.mockMouse.click(gutter.x, gutter.firstY, MouseButtons.LEFT, MOUSE);
    });
    await setup.flush();
    expect(currentWindow(setup)).toEqual(atTop);
  });

  it("dragging the gutter from top to bottom reaches the last window", async () => {
    const setup = await renderCrowded();
    const expected = captureMaxWindow(setup);
    await act(async () => {
      setup.store.actions.dispatch({ type: "dashboard.scrollTo", offset: 0 });
      await Promise.resolve();
    });
    await setup.flush();
    const gutter = gutterGeometry(setup);
    await act(async () => {
      await setup.mockMouse.drag(gutter.x, gutter.firstY, gutter.x, gutter.lastY, MouseButtons.LEFT, MOUSE);
    });
    await setup.flush();
    expect(currentWindow(setup)).toEqual(expected);
  });

  it("a one-row wheel still moves content when the gutter thumb glyph does not", async () => {
    const setup = await renderCrowded();
    const gutter = gutterGeometry(setup);
    const startThumb = gutterColumn(setup).slice(gutter.chromeTop, gutter.lastY + 1).join("");
    const startWindow = currentWindow(setup);
    await act(async () => {
      await setup.mockMouse.scroll(1, gutter.firstY, "down", MOUSE);
    });
    await setup.flush();
    expect(setup.store.state.getState().scrollOffset).toBe(1);
    expect(currentWindow(setup).firstId).not.toBe(startWindow.firstId);
    expect(gutterColumn(setup).slice(gutter.chromeTop, gutter.lastY + 1).join("")).toBe(startThumb);
  });

  it("keeps fleet and header gutter cells blank while the thumb stays in the body", async () => {
    const setup = await renderCrowded();
    const gutter = gutterGeometry(setup);
    const column = gutterColumn(setup);
    expect(column.slice(0, gutter.chromeTop).join("").trim()).toBe("");
    expect(column.slice(gutter.lastY + 1).join("").trim()).toBe("");
    expect(column[gutter.chromeTop]).toMatch(THUMB);
  });

  it("clicking a fleet or header gutter cell does not move the dashboard window", async () => {
    const setup = await renderCrowded();
    const atTop = currentWindow(setup);
    const gutter = gutterGeometry(setup);
    expect(gutter.chromeTop).toBeGreaterThan(0);
    await act(async () => {
      await setup.mockMouse.click(gutter.x, 0, MouseButtons.LEFT, MOUSE);
    });
    await setup.flush();
    expect(currentWindow(setup)).toEqual(atTop);
  });

  it("clicking the Help bar last cell reaches the last window and does not close Help", async () => {
    const setup = await renderCrowded();
    await act(async () => {
      setup.store.actions.handleKey({ input: "H" });
      await Promise.resolve();
    });
    await setup.flush();
    const bar = helpBarGeometry(SIZE.width, SIZE.height);
    await act(async () => {
      await setup.mockMouse.click(bar.x, bar.lastY, MouseButtons.LEFT, MOUSE);
    });
    await setup.flush();
    const screen = setup.store.state.getState().screen;
    expect(screen).toMatchObject({ name: "help" });
    if (screen.name !== "help") {
      throw new Error("expected help");
    }
    expect(screen.scrollOffset).toBe(bar.maxOffset);
    const lastContent = bar.content.at(-1);
    if (lastContent === undefined) {
      throw new Error("expected help copy");
    }
    expect(setup.captureCharFrame()).toContain(
      "description" in lastContent ? lastContent.description : lastContent.text,
    );
    await act(async () => {
      await setup.mockMouse.click(0, 0, MouseButtons.LEFT, MOUSE);
    });
    await setup.flush();
    expect(setup.store.state.getState().screen).toEqual({ name: "dashboard" });
  });

  it("dragging the Help bar to the last cell reaches the last window and does not close Help", async () => {
    const setup = await renderCrowded();
    await act(async () => {
      setup.store.actions.handleKey({ input: "H" });
      await Promise.resolve();
    });
    await setup.flush();
    const bar = helpBarGeometry(SIZE.width, SIZE.height);
    await act(async () => {
      await setup.mockMouse.drag(bar.x, bar.firstY, bar.x, bar.lastY, MouseButtons.LEFT, MOUSE);
    });
    await setup.flush();
    expect(setup.store.state.getState().screen).toMatchObject({
      name: "help",
      scrollOffset: bar.maxOffset,
    });
  });

  it("a one-line Help wheel still moves copy and does not close Help", async () => {
    const setup = await renderCrowded();
    await act(async () => {
      setup.store.actions.handleKey({ input: "H" });
      await Promise.resolve();
    });
    await setup.flush();
    const bar = helpBarGeometry(SIZE.width, SIZE.height);
    const startFrame = setup.captureCharFrame();
    await act(async () => {
      await setup.mockMouse.scroll(bar.x, bar.lastY, "down", MOUSE);
    });
    await setup.flush();
    expect(setup.store.state.getState().screen).toMatchObject({ name: "help", scrollOffset: 1 });
    expect(setup.captureCharFrame()).not.toBe(startFrame);
  });

  async function renderCrowded() {
    const snapshot = createCrowdedDashboardSnapshot(SESSION_COUNT);
    const { runtime: store } = makeStationTestRuntime({
      snapshot,
      terminalRows: SIZE.height,
    });
    store.start();
    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <StationHoverProvider value={true}>
          <StationMouseProvider
            value={(target, event) => {
              routeStationMouse(target, normalizeStationMouseEvent(event), store);
            }}
          >
            <DashboardRoot
              state={store.state}
              actions={store.actions}
              columns={SIZE.width}
              rows={SIZE.height}
              onCopyNotice={() => {}}
            />
          </StationMouseProvider>
        </StationHoverProvider>
      </StationThemeProvider>,
      SIZE,
    );
    teardowns.push(() => {
      setup.renderer.destroy();
    });
    await setup.renderOnce();
    return Object.assign(setup, { store });
  }
});

function currentWindow(setup: { store: ReturnType<typeof makeStationTestRuntime>["runtime"] }) {
  const state = setup.store.state.getState();
  if (state.snapshot === undefined) {
    throw new Error("expected snapshot");
  }
  const viewport = selectDashboardViewport(state.snapshot, state);
  return {
    offset: state.scrollOffset,
    firstId: viewport.rows[0]?.id,
    lastId: viewport.rows.at(-1)?.id,
    hiddenBelow: viewport.hiddenBelow,
  };
}

function captureMaxWindow(setup: { store: ReturnType<typeof makeStationTestRuntime>["runtime"] }) {
  setup.store.actions.dispatch({ type: "dashboard.scrollTo", offset: Number.MAX_SAFE_INTEGER });
  return currentWindow(setup);
}

function gutterGeometry(setup: {
  store: ReturnType<typeof makeStationTestRuntime>["runtime"];
  captureCharFrame: () => string;
}) {
  const state = setup.store.state.getState();
  if (state.snapshot === undefined) {
    throw new Error("expected snapshot");
  }
  const viewport = selectDashboardViewport(state.snapshot, state);
  const chrome = dashboardScrollGutterChrome({ hasFleetBar: true });
  return {
    x: SIZE.width - 1,
    chromeTop: chrome.top,
    firstY: chrome.top,
    lastY: chrome.top + viewport.bodyRows - 1,
  };
}

function gutterColumn(setup: { captureCharFrame: () => string }): string[] {
  return setup.captureCharFrame().split("\n").map((line) => line.at(-1) ?? "");
}

function helpBarGeometry(columns: number, rows: number) {
  const content = helpOverlayContent(stationKeymapHelp());
  const layout = helpPanelLayout(columns, rows, content);
  const model = helpPanelModel(layout.width, layout.height, content, 0);
  return {
    content,
    x: layout.left + layout.width - 2,
    firstY: layout.top + 1,
    lastY: layout.top + model.bodyRows,
    maxOffset: Math.max(0, content.length - model.bodyRows),
  };
}
