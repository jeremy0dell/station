import { afterEach, describe, expect, it } from "bun:test";
import { rgbToHex, ScrollBoxRenderable } from "@opentui/core";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import {
  nativeStationTheme,
  stationColorSnapshotValue,
  StationThemeProvider,
} from "../../../../theme/index.js";
import { spanAtFrameCell } from "../../../../terminal/testing/frameProbe.js";
import { StationHoverProvider } from "../../stationMouseContext.js";
import { SemanticScrollViewport } from "./SemanticScrollViewport.js";
import {
  createScrollViewportController,
  semanticItemRenderableId,
} from "./scrollViewport.js";

const teardowns: Array<() => void> = [];

afterEach(() => {
  for (const teardown of teardowns.splice(0)) teardown();
});

describe("SemanticScrollViewport", () => {
  it("uses its renderer index for steady-state scroll and rebuilt semantic nodes", async () => {
    const itemIds = Array.from({ length: 512 }, (_, index) => `item-${index}`);
    const controller = createScrollViewportController<string>();
    let remountItems: (() => void) | undefined;

    function IndexedViewport() {
      const [generation, setGeneration] = useState(0);
      remountItems = () => setGeneration((current) => current + 1);
      return (
        <box width={24} height={6} flexDirection="column">
          <SemanticScrollViewport
            controller={controller}
            itemIds={itemIds}
            viewportId="indexed-semantic-viewport"
          >
            {itemIds.map((itemId, index) => (
              <box
                key={`${generation}:${itemId}`}
                id={semanticItemRenderableId(itemId)}
                height={index % 2 === 0 ? 1 : 2}
                flexShrink={0}
              />
            ))}
          </SemanticScrollViewport>
        </box>
      );
    }

    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <IndexedViewport />
      </StationThemeProvider>,
      { width: 24, height: 6 },
    );
    teardowns.push(() => setup.renderer.destroy());
    await setup.flush();
    const viewport = setup.renderer.root.findDescendantById("indexed-semantic-viewport");
    if (!(viewport instanceof ScrollBoxRenderable)) {
      throw new Error("semantic viewport did not render");
    }

    let recursiveLookups = 0;
    const findDescendantById = viewport.content.findDescendantById.bind(viewport.content);
    viewport.content.findDescendantById = (id) => {
      recursiveLookups += 1;
      return findDescendantById(id);
    };

    controller.scrollBy(400);
    controller.follow("item-400");
    expect(controller.snapshot()).toContain("item-400");
    expect(recursiveLookups).toBe(0);

    const remount = remountItems;
    if (remount === undefined) throw new Error("semantic item remount control was not installed");
    await act(async () => remount());
    await setup.flush();
    controller.follow("item-400");

    expect(controller.snapshot()).toContain("item-400");
    expect(recursiveLookups).toBe(0);
  });

  it("publishes an empty measured window at initial and resized zero height", async () => {
    const itemIds = ["one", "two", "three"] as const;
    const controller = createScrollViewportController<string>();
    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <box width={20} height={3} flexDirection="column">
          <SemanticScrollViewport
            controller={controller}
            itemIds={itemIds}
            viewportId="zero-height-semantic-viewport"
          >
            {itemIds.map((itemId) => (
              <box
                key={itemId}
                id={semanticItemRenderableId(itemId)}
                height={1}
                flexShrink={0}
              />
            ))}
          </SemanticScrollViewport>
        </box>
      </StationThemeProvider>,
      { width: 20, height: 5 },
    );
    teardowns.push(() => setup.renderer.destroy());
    await setup.flush();
    const viewport = setup.renderer.root.findDescendantById("zero-height-semantic-viewport");
    if (!(viewport instanceof ScrollBoxRenderable)) {
      throw new Error("zero-height semantic viewport did not render");
    }
    let measuredHeight = 0;
    Object.defineProperty(viewport.viewport, "height", {
      configurable: true,
      get: () => measuredHeight,
    });
    controller.detach(viewport);
    controller.attach(viewport, itemIds);
    expect(controller.snapshot()).toEqual([]);

    measuredHeight = 3;
    controller.synchronize();
    expect(controller.snapshot()).toEqual(itemIds);

    measuredHeight = 0;
    controller.synchronize();
    expect(controller.snapshot()).toEqual([]);
  });

  it("uses native scrollbar mechanics with stable Station chrome", async () => {
    const itemIds = Array.from({ length: 20 }, (_, index) => `item-${index}`);
    const controller = createScrollViewportController<string>();
    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <StationHoverProvider value>
          <box width={10} height={5} flexDirection="column" paddingRight={1}>
            <SemanticScrollViewport
              controller={controller}
              itemIds={itemIds}
              viewportId="scrollbar-semantic-viewport"
              scrollbar="gutter"
            >
              {itemIds.map((itemId) => (
                <box
                  key={itemId}
                  id={semanticItemRenderableId(itemId)}
                  height={1}
                  flexShrink={0}
                />
              ))}
            </SemanticScrollViewport>
          </box>
        </StationHoverProvider>
      </StationThemeProvider>,
      { width: 10, height: 5 },
    );
    teardowns.push(() => setup.renderer.destroy());
    await setup.flush();

    const viewport = setup.renderer.root.findDescendantById("scrollbar-semantic-viewport");
    if (!(viewport instanceof ScrollBoxRenderable)) {
      throw new Error("scrollbar semantic viewport did not render");
    }
    const slider = viewport.verticalScrollBar.slider;
    const startArrow = viewport.verticalScrollBar.startArrow;
    const endArrow = viewport.verticalScrollBar.endArrow;
    expect(viewport.viewport.width).toBe(9);
    expect(slider.x).toBe(9);
    expect(startArrow.y).toBeLessThan(slider.y);
    expect(endArrow.y).toBeGreaterThan(slider.y);
    expect(setup.captureCharFrame()).toContain("▲");
    expect(setup.captureCharFrame()).toContain("▼");
    expect(setup.captureCharFrame()).toContain("▐");
    expect(setup.captureCharFrame()).toContain("▕");
    const topThumbHeight = setup.captureCharFrame().match(/▐/gu)?.length ?? 0;
    controller.scrollBy(7);
    await setup.flush();
    expect(setup.captureCharFrame().match(/▐/gu)?.length).toBe(topThumbHeight);
    controller.scrollBy(-100);
    await setup.flush();
    const ordinary = spanAtFrameCell(setup.captureSpans(), slider.y, slider.x)?.fg;
    expect(ordinary === undefined ? undefined : rgbToHex(ordinary)).toBe(
      stationColorSnapshotValue(nativeStationTheme.text.muted),
    );

    await act(async () => setup.mockMouse.moveTo(startArrow.x, startArrow.y));
    await setup.flush();
    const hoveredArrow = spanAtFrameCell(
      setup.captureSpans(),
      startArrow.y,
      startArrow.x,
    )?.fg;
    expect(hoveredArrow === undefined ? undefined : rgbToHex(hoveredArrow)).toBe(
      stationColorSnapshotValue(nativeStationTheme.text.primary),
    );

    await act(async () =>
      setup.mockMouse.click(endArrow.x, endArrow.y, MouseButtons.LEFT),
    );
    await setup.flush();
    const afterDownArrow = viewport.scrollTop;
    expect(afterDownArrow).toBeGreaterThan(0);
    expect(controller.snapshot()).not.toContain("item-0");
    await act(async () =>
      setup.mockMouse.click(startArrow.x, startArrow.y, MouseButtons.LEFT),
    );
    await setup.flush();
    expect(viewport.scrollTop).toBeLessThan(afterDownArrow);

    controller.follow("item-19");
    await setup.flush();
    expect(viewport.scrollTop).toBeGreaterThan(0);
    await act(async () => {
      for (let index = 0; index < 20; index += 1) {
        await setup.mockMouse.click(startArrow.x, startArrow.y, MouseButtons.LEFT);
      }
    });
    await setup.flush();
    expect(viewport.scrollTop).toBe(0);
    controller.reflow();
    expect(viewport.scrollTop).toBe(0);

    controller.follow("item-19");
    await setup.flush();
    await act(async () => {
      await setup.mockMouse.click(startArrow.x, startArrow.y, MouseButtons.LEFT);
      for (let index = 0; index < 20; index += 1) {
        await setup.mockMouse.scroll(2, 2, "up");
      }
    });
    await setup.flush();
    expect(viewport.scrollTop).toBe(0);
    controller.reflow();
    expect(viewport.scrollTop).toBe(0);

    controller.scrollBy(-100);

    await act(async () => setup.mockMouse.moveTo(slider.x, slider.y));
    await setup.flush();
    const hovered = spanAtFrameCell(setup.captureSpans(), slider.y, slider.x)?.fg;
    expect(hovered === undefined ? undefined : rgbToHex(hovered)).toBe(
      stationColorSnapshotValue(nativeStationTheme.text.primary),
    );

    await act(async () =>
      setup.mockMouse.pressDown(
        slider.x,
        slider.y + slider.height - 1,
        MouseButtons.LEFT,
      ),
    );
    await setup.flush();
    expect(viewport.scrollTop).toBe(
      viewport.scrollHeight - viewport.viewport.height,
    );
    const pressed = spanAtFrameCell(
      setup.captureSpans(),
      slider.y + slider.height - 1,
      slider.x,
    )?.bg;
    expect(pressed === undefined ? undefined : rgbToHex(pressed)).toBe(
      stationColorSnapshotValue(nativeStationTheme.interaction.hover),
    );
    await act(async () =>
      setup.mockMouse.release(slider.x, slider.y + slider.height - 1, MouseButtons.LEFT),
    );
    expect(viewport.scrollTop).toBe(
      viewport.scrollHeight - viewport.viewport.height,
    );
  });
});
