// Crowded dashboard + Help: last-cell identity (homebake maps last track cell
// to maxOffset), one-row wheels with a stuck thumb, and Help click-away vs bar.
import { afterEach, describe, expect, it } from "bun:test";
import { rgbToHex, TextRenderable, type BaseRenderable } from "@opentui/core";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import {
  dashboardScrollGutterChrome,
  helpOverlayContent,
  helpPanelLayout,
  helpPanelModel,
  selectDashboardViewport,
  VERTICAL_SCROLLBAR_THUMB,
  VERTICAL_SCROLLBAR_TRACK,
} from "@station/dashboard-core/selectors";
import { act } from "react";
import {
  createCrowdedDashboardSnapshot,
  createCrowdedEmptyGroupsSnapshot,
} from "../../../../packages/dashboard-core/test/fixtures/snapshots.js";
import { normalizeStationMouseEvent } from "../../input/mouse.js";
import { stationKeymapHelp } from "../../input/keymap/stationBindings.js";
import { nativeStationTheme, stationColorSnapshotValue, StationThemeProvider } from "../../theme/index.js";
import { spanAtFrameCell } from "../../terminal/testing/frameProbe.js";
import { makeStationTestRuntime } from "../test/support/makeStationTestRuntime.js";
import { routeStationMouse } from "../input/stationMouse.js";
import { DashboardRoot } from "./DashboardRoot.js";
import { StationHoverProvider, StationMouseProvider } from "./stationMouseContext.js";

const SIZE = { width: 80, height: 24 };
const SESSION_COUNT = 300;
const MOUSE = { delayMs: 0 } as const;
const THUMB = VERTICAL_SCROLLBAR_THUMB;

type RenderedDashboard = Awaited<ReturnType<typeof testRender>> & {
  store: ReturnType<typeof makeStationTestRuntime>["runtime"];
};

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
    expect(gutterColumn(setup).slice(gutter.chromeTop, gutter.lastY + 1).join("")).toContain(THUMB);
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

  it("keeps fleet gutter cells blank and paints ▼ beside the below count", async () => {
    const setup = await renderCrowded();
    const gutter = gutterGeometry(setup);
    const column = gutterColumn(setup);
    const frame = setup.captureCharFrame();
    expect(column.slice(0, gutter.chromeTop).join("").trim()).toBe("");
    expect(column[gutter.chromeTop]).toBe(THUMB);
    expect(column[gutter.lastY + 1]).toBe("▼");
    const track = column.slice(gutter.chromeTop, gutter.lastY + 1);
    expect(track.some((cell) => cell === VERTICAL_SCROLLBAR_TRACK)).toBe(true);
    expect(track.every((cell) => cell === THUMB || cell === VERTICAL_SCROLLBAR_TRACK)).toBe(true);
    expect(frame).toContain("below · showing");
    expect(frame).not.toContain("sessions above");
  });

  it("paints ▲ beside the above count once sessions are hidden above", async () => {
    const setup = await renderCrowded();
    captureMaxWindow(setup);
    await setup.flush();
    const gutter = gutterGeometry(setup);
    const column = gutterColumn(setup);
    const frame = setup.captureCharFrame();
    expect(column[gutter.chromeTop - 1]).toBe("▲");
    expect(column[gutter.lastY + 1]?.trim() ?? "").toBe("");
    expect(frame).toContain("sessions above");
  });

  it("paints overflow arrows when the tree can scroll even if every session is on screen", async () => {
    const setup = await renderEmptyGroups();
    const gutter = gutterGeometry(setup);
    let column = gutterColumn(setup);
    let frame = setup.captureCharFrame();
    const atTop = selectDashboardViewport(
      setup.store.state.getState().snapshot,
      setup.store.state.getState(),
    );
    expect(atTop.hiddenBelow).toBeGreaterThan(0);
    expect(atTop.sessionOverflow.below).toBe(0);
    expect(column[gutter.lastY + 1]).toBe("▼");
    expect(frame).toContain("▼ more below");
    expect(frame).not.toContain("below · showing");
    expect(column.slice(0, gutter.chromeTop).join("").trim()).toBe("");

    await act(async () => {
      setup.store.actions.dispatch({ type: "dashboard.scrollTo", offset: 1 });
      await Promise.resolve();
    });
    await setup.flush();
    column = gutterColumn(setup);
    frame = setup.captureCharFrame();
    const scrolled = selectDashboardViewport(
      setup.store.state.getState().snapshot,
      setup.store.state.getState(),
    );
    expect(scrolled.hiddenAbove).toBe(1);
    expect(scrolled.sessionOverflow.above).toBe(0);
    expect(column[gutter.chromeTop - 1]).toBe("▲");
    expect(column[gutter.lastY + 1]).toBe("▼");
    expect(frame).toContain("▲ more above");
    expect(frame).toContain("▼ more below");
    expect(frame).not.toContain("sessions above");

    const offsetBeforePage = setup.store.state.getState().scrollOffset;
    await act(async () => {
      await setup.mockMouse.click(gutter.x, gutter.lastY + 1, MouseButtons.LEFT, MOUSE);
    });
    await setup.flush();
    expect(setup.store.state.getState().scrollOffset).toBeGreaterThan(offsetBeforePage);
  });

  it("pages from the gutter ▼ without starting a selection", async () => {
    const setup = await renderCrowded();
    const atTop = currentWindow(setup);
    const gutter = gutterGeometry(setup);
    await act(async () => {
      await setup.mockMouse.click(gutter.x, gutter.lastY + 1, MouseButtons.LEFT, MOUSE);
    });
    await setup.flush();
    expect(setup.renderer.hasSelection).toBe(false);
    expect(setup.store.state.getState().scrollOffset).toBeGreaterThan(atTop.offset);
  });

  it("pages from the gutter ▲ without starting a selection", async () => {
    const setup = await renderCrowded();
    captureMaxWindow(setup);
    await setup.flush();
    const atBottom = currentWindow(setup);
    const gutter = gutterGeometry(setup);
    await act(async () => {
      await setup.mockMouse.click(gutter.x, gutter.chromeTop - 1, MouseButtons.LEFT, MOUSE);
    });
    await setup.flush();
    expect(setup.renderer.hasSelection).toBe(false);
    expect(setup.store.state.getState().scrollOffset).toBeLessThan(atBottom.offset);
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

  it("keeps every gutter cell out of OpenTUI selection", async () => {
    const setup = await renderCrowded();
    const gutterTexts = collectTextRenderables(setup.renderer.root).filter(
      (text) => text.x === SIZE.width - 1,
    );
    expect(gutterTexts.length).toBeGreaterThan(0);
    expect(gutterTexts.every((text) => text.selectable === false)).toBe(true);
  });

  it("brightens the gutter on hover without changing glyphs", async () => {
    const setup = await renderCrowded();
    const gutter = gutterGeometry(setup);
    const idle = spanAtFrameCell(setup.captureSpans(), gutter.firstY, gutter.x);
    expect(spanHex(idle)).toBe(stationColorSnapshotValue(nativeStationTheme.text.muted));
    expect(spanBgHex(idle)).not.toBe(stationColorSnapshotValue(nativeStationTheme.interaction.hover));
    const idleGlyphs = gutterColumn(setup).slice(gutter.chromeTop, gutter.lastY + 1).join("");

    await setup.mockMouse.moveTo(gutter.x, gutter.firstY, MOUSE);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.flush();
    const hovered = spanAtFrameCell(setup.captureSpans(), gutter.firstY, gutter.x);
    expect(spanHex(hovered)).toBe(stationColorSnapshotValue(nativeStationTheme.text.primary));
    expect(spanBgHex(hovered)).not.toBe(stationColorSnapshotValue(nativeStationTheme.interaction.hover));
    expect(gutterColumn(setup).slice(gutter.chromeTop, gutter.lastY + 1).join("")).toBe(idleGlyphs);

    await setup.mockMouse.moveTo(0, 0, MOUSE);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.flush();
    expect(spanHex(spanAtFrameCell(setup.captureSpans(), gutter.firstY, gutter.x))).toBe(
      stationColorSnapshotValue(nativeStationTheme.text.muted),
    );
  });

  it("fills the gutter while the pointer is down on the track", async () => {
    const setup = await renderCrowded();
    const gutter = gutterGeometry(setup);
    await act(async () => {
      await setup.mockMouse.pressDown(gutter.x, gutter.firstY, MouseButtons.LEFT, MOUSE);
    });
    await setup.flush();
    const pressed = spanAtFrameCell(setup.captureSpans(), gutter.firstY, gutter.x);
    expect(spanHex(pressed)).toBe(stationColorSnapshotValue(nativeStationTheme.text.primary));
    expect(spanBgHex(pressed)).toBe(stationColorSnapshotValue(nativeStationTheme.interaction.hover));

    await act(async () => {
      await setup.mockMouse.release(gutter.x, gutter.firstY, MouseButtons.LEFT, MOUSE);
    });
    await setup.flush();
    await act(async () => {
      await setup.mockMouse.moveTo(0, 0, MOUSE);
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.flush();
    expect(spanBgHex(spanAtFrameCell(setup.captureSpans(), gutter.firstY, gutter.x))).not.toBe(
      stationColorSnapshotValue(nativeStationTheme.interaction.hover),
    );
    expect(spanHex(spanAtFrameCell(setup.captureSpans(), gutter.firstY, gutter.x))).toBe(
      stationColorSnapshotValue(nativeStationTheme.text.muted),
    );
  });

  it("brightens the Help bar on hover and fills it while dragging", async () => {
    const setup = await renderCrowded();
    await openHelp(setup);
    const bar = helpBarGeometry(SIZE.width, SIZE.height);
    const idle = spanAtFrameCell(setup.captureSpans(), bar.firstY, bar.x);
    expect(spanHex(idle)).toBe(stationColorSnapshotValue(nativeStationTheme.text.muted));

    await setup.mockMouse.moveTo(bar.x, bar.firstY, MOUSE);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.flush();
    expect(spanHex(spanAtFrameCell(setup.captureSpans(), bar.firstY, bar.x))).toBe(
      stationColorSnapshotValue(nativeStationTheme.text.primary),
    );

    await act(async () => {
      await setup.mockMouse.pressDown(bar.x, bar.firstY, MouseButtons.LEFT, MOUSE);
    });
    await setup.flush();
    expect(spanBgHex(spanAtFrameCell(setup.captureSpans(), bar.firstY, bar.x))).toBe(
      stationColorSnapshotValue(nativeStationTheme.interaction.hover),
    );
    expect(setup.store.state.getState().screen).toMatchObject({ name: "help" });

    await act(async () => {
      await setup.mockMouse.release(bar.x, bar.firstY, MouseButtons.LEFT, MOUSE);
    });
    await setup.flush();
  });

  it("keeps Help panel copy and the inset bar out of OpenTUI selection", async () => {
    const setup = await renderCrowded();
    await act(async () => {
      setup.store.actions.handleKey({ input: "H" });
      await Promise.resolve();
    });
    await setup.flush();
    const overlay = findRenderableByZIndex(setup.renderer.root, 10);
    expect(overlay).toBeDefined();
    const panelTexts = collectTextRenderables(overlay!);
    expect(panelTexts.length).toBeGreaterThan(0);
    expect(panelTexts.every((text) => text.selectable === false)).toBe(true);
  });

  it("dragging the gutter from first to last reaches max without a selection", async () => {
    const setup = await renderCrowded();
    const expected = captureMaxWindow(setup);
    await resetDashboard(setup);
    const gutter = gutterGeometry(setup);
    await drag(setup, gutter.x, gutter.firstY, gutter.x, gutter.lastY);
    expect(setup.renderer.hasSelection).toBe(false);
    expect(currentWindow(setup)).toEqual(expected);
  });

  it("dragging the gutter from last to first reaches the first window without a selection", async () => {
    const setup = await renderCrowded();
    const atTop = currentWindow(setup);
    captureMaxWindow(setup);
    await setup.flush();
    const gutter = gutterGeometry(setup);
    await drag(setup, gutter.x, gutter.lastY, gutter.x, gutter.firstY);
    expect(setup.renderer.hasSelection).toBe(false);
    expect(currentWindow(setup)).toEqual(atTop);
  });

  it("dragging past the last gutter cell still reaches max without a selection", async () => {
    const setup = await renderCrowded();
    const expected = captureMaxWindow(setup);
    await resetDashboard(setup);
    const gutter = gutterGeometry(setup);
    await drag(setup, gutter.x, gutter.firstY, gutter.x, SIZE.height + 8);
    expect(setup.renderer.hasSelection).toBe(false);
    expect(currentWindow(setup)).toEqual(expected);
  });

  it("dragging past the first gutter cell still reaches the first window without a selection", async () => {
    const setup = await renderCrowded();
    const atTop = currentWindow(setup);
    captureMaxWindow(setup);
    await setup.flush();
    const gutter = gutterGeometry(setup);
    await drag(setup, gutter.x, gutter.lastY, gutter.x, -4);
    expect(setup.renderer.hasSelection).toBe(false);
    expect(currentWindow(setup)).toEqual(atTop);
  });

  it("dragging onto session copy from the gutter never starts a selection", async () => {
    const setup = await renderCrowded();
    const gutter = gutterGeometry(setup);
    const midY = gutter.firstY + Math.floor((gutter.lastY - gutter.firstY) / 2);
    await drag(setup, gutter.x, midY, 8, midY);
    expect(setup.renderer.hasSelection).toBe(false);
    expect(setup.store.state.getState().scrollOffset).toBeGreaterThan(0);
  });

  it("dragging every gutter cell from the top is monotone and never selects", async () => {
    const setup = await renderCrowded();
    const expected = captureMaxWindow(setup);
    const gutter = gutterGeometry(setup);
    let previous = 0;
    for (let y = gutter.firstY; y <= gutter.lastY; y += 1) {
      await resetDashboard(setup);
      await drag(setup, gutter.x, gutter.firstY, gutter.x, y);
      expect(setup.renderer.hasSelection).toBe(false);
      const offset = setup.store.state.getState().scrollOffset;
      expect(offset).toBeGreaterThanOrEqual(previous);
      previous = offset;
    }
    expect(previous).toBe(expected.offset);
  }, 15_000);

  it("dragging every gutter cell from the bottom is monotone and never selects", async () => {
    const setup = await renderCrowded();
    const expected = captureMaxWindow(setup);
    await setup.flush();
    const gutter = gutterGeometry(setup);
    let previous = expected.offset;
    for (let y = gutter.lastY; y >= gutter.firstY; y -= 1) {
      captureMaxWindow(setup);
      await setup.flush();
      await drag(setup, gutter.x, gutter.lastY, gutter.x, y);
      expect(setup.renderer.hasSelection).toBe(false);
      const offset = setup.store.state.getState().scrollOffset;
      expect(offset).toBeLessThanOrEqual(previous);
      previous = offset;
    }
    expect(previous).toBe(0);
  }, 15_000);

  it("a one-cell gutter drag still moves the window without a selection", async () => {
    const setup = await renderCrowded();
    const gutter = gutterGeometry(setup);
    const start = currentWindow(setup);
    await drag(setup, gutter.x, gutter.firstY, gutter.x, gutter.firstY + 1);
    expect(setup.renderer.hasSelection).toBe(false);
    expect(setup.store.state.getState().scrollOffset).toBeGreaterThan(start.offset);
  });

  it("dragging the Help bar from first to last reaches max without selecting or closing", async () => {
    const setup = await renderCrowded();
    await openHelp(setup);
    const bar = helpBarGeometry(SIZE.width, SIZE.height);
    await drag(setup, bar.x, bar.firstY, bar.x, bar.lastY);
    expect(setup.renderer.hasSelection).toBe(false);
    expect(setup.store.state.getState().screen).toMatchObject({
      name: "help",
      scrollOffset: bar.maxOffset,
    });
  });

  it("dragging the Help bar from last to first reaches the first window without selecting", async () => {
    const setup = await renderCrowded();
    await openHelp(setup);
    const bar = helpBarGeometry(SIZE.width, SIZE.height);
    await act(async () => {
      setup.store.actions.dispatch({ type: "help.scrollTo", offset: bar.maxOffset });
      await Promise.resolve();
    });
    await setup.flush();
    await drag(setup, bar.x, bar.lastY, bar.x, bar.firstY);
    expect(setup.renderer.hasSelection).toBe(false);
    expect(setup.store.state.getState().screen).toMatchObject({ name: "help", scrollOffset: 0 });
  });

  it("dragging past the Help bar last cell still reaches max without selecting or closing", async () => {
    const setup = await renderCrowded();
    await openHelp(setup);
    const bar = helpBarGeometry(SIZE.width, SIZE.height);
    await drag(setup, bar.x, bar.firstY, bar.x, bar.lastY + 6);
    expect(setup.renderer.hasSelection).toBe(false);
    expect(setup.store.state.getState().screen).toMatchObject({
      name: "help",
      scrollOffset: bar.maxOffset,
    });
  });

  it("dragging off the Help bar onto overlay copy never starts a selection", async () => {
    const setup = await renderCrowded();
    await openHelp(setup);
    const bar = helpBarGeometry(SIZE.width, SIZE.height);
    await drag(setup, bar.x, bar.firstY + 2, bar.left + 4, bar.firstY + 2);
    expect(setup.renderer.hasSelection).toBe(false);
    expect(setup.store.state.getState().screen).toMatchObject({ name: "help" });
  });

  it("dragging every Help bar cell from the top is monotone and never selects", async () => {
    const setup = await renderCrowded();
    await openHelp(setup);
    const bar = helpBarGeometry(SIZE.width, SIZE.height);
    let previous = 0;
    for (let y = bar.firstY; y <= bar.lastY; y += 1) {
      await act(async () => {
        setup.store.actions.dispatch({ type: "help.scrollTo", offset: 0 });
        await Promise.resolve();
      });
      await setup.flush();
      await drag(setup, bar.x, bar.firstY, bar.x, y);
      expect(setup.renderer.hasSelection).toBe(false);
      const screen = setup.store.state.getState().screen;
      expect(screen).toMatchObject({ name: "help" });
      if (screen.name !== "help") {
        throw new Error("expected help");
      }
      expect(screen.scrollOffset).toBeGreaterThanOrEqual(previous);
      previous = screen.scrollOffset;
    }
    expect(previous).toBe(bar.maxOffset);
  }, 15_000);

  it("still allows drag selection on session copy away from the gutter", async () => {
    const setup = await renderCrowded();
    const label = "crowd-0000";
    const cell = cellFor(setup.captureCharFrame(), label);
    await drag(setup, cell.col, cell.row, cell.col + label.length - 1, cell.row);
    expect(setup.renderer.getSelection()?.getSelectedText()).toContain("crowd");
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

  async function renderEmptyGroups() {
    const snapshot = createCrowdedEmptyGroupsSnapshot(20);
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

async function drag(
  setup: RenderedDashboard,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): Promise<void> {
  await act(async () => {
    await setup.mockMouse.drag(startX, startY, endX, endY, MouseButtons.LEFT, MOUSE);
  });
  await setup.flush();
}

async function resetDashboard(setup: RenderedDashboard): Promise<void> {
  await act(async () => {
    setup.store.actions.dispatch({ type: "dashboard.scrollTo", offset: 0 });
    await Promise.resolve();
  });
  await setup.flush();
}

async function openHelp(setup: RenderedDashboard): Promise<void> {
  await act(async () => {
    setup.store.actions.handleKey({ input: "H" });
    await Promise.resolve();
  });
  await setup.flush();
}

function collectTextRenderables(renderable: BaseRenderable): TextRenderable[] {
  const collected = renderable instanceof TextRenderable ? [renderable] : [];
  for (const child of renderable.getChildren()) {
    collected.push(...collectTextRenderables(child));
  }
  return collected;
}

function findRenderableByZIndex(
  renderable: BaseRenderable,
  zIndex: number,
): BaseRenderable | undefined {
  if ("zIndex" in renderable && renderable.zIndex === zIndex) {
    return renderable;
  }
  for (const child of renderable.getChildren()) {
    const found = findRenderableByZIndex(child, zIndex);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function cellFor(frame: string, snippet: string): { col: number; row: number } {
  const lines = frame.split("\n");
  const row = lines.findIndex((line) => line.includes(snippet));
  const col = lines[row]?.indexOf(snippet) ?? -1;
  if (row < 0 || col < 0) {
    throw new Error(`expected frame to contain ${snippet}`);
  }
  return { col, row };
}

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

function spanHex(span: ReturnType<typeof spanAtFrameCell>): string | undefined {
  return span?.fg === undefined ? undefined : rgbToHex(span.fg);
}

function spanBgHex(span: ReturnType<typeof spanAtFrameCell>): string | undefined {
  return span?.bg === undefined ? undefined : rgbToHex(span.bg);
}

function helpBarGeometry(columns: number, rows: number) {
  const content = helpOverlayContent(stationKeymapHelp());
  const layout = helpPanelLayout(columns, rows, content);
  const model = helpPanelModel(layout.width, layout.height, content, 0);
  return {
    content,
    left: layout.left,
    top: layout.top,
    width: layout.width,
    height: layout.height,
    x: layout.left + layout.width - 2,
    firstY: layout.top + 1,
    lastY: layout.top + model.bodyRows,
    maxOffset: Math.max(0, content.length - model.bodyRows),
  };
}
