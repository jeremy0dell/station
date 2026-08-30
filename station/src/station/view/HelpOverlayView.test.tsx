import { afterEach, describe, expect, it } from "bun:test";
import type { ScrollBoxRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act, type Dispatch, type SetStateAction, useState } from "react";
import { nativeStationTheme, StationThemeProvider } from "../../theme/index.js";
import { HelpOverlayView } from "./HelpOverlayView.js";
import { semanticItemRenderableId } from "./layout/scrollViewport.js";
import { StationMouseProvider } from "./stationMouseContext.js";

const teardowns: Array<() => void> = [];

afterEach(() => {
  for (const teardown of teardowns.splice(0)) teardown();
});

describe("HelpOverlayView", () => {
  it("mounts the complete semantic help list and scrolls wrapped entries by laid-out geometry", async () => {
    let setSize: Dispatch<SetStateAction<{ columns: number; rows: number }>> | undefined;

    function ResponsiveHelp() {
      const [size, updateSize] = useState({ columns: 30, rows: 8 });
      setSize = updateSize;
      return <HelpOverlayView {...size} focusedEntryId="help:dashboard:help-refresh" />;
    }

    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <StationMouseProvider value={() => {}}>
          <ResponsiveHelp />
        </StationMouseProvider>
      </StationThemeProvider>,
      { width: 30, height: 8 },
    );
    teardowns.push(() => setup.renderer.destroy());
    await setup.renderOnce();
    await setup.flush();

    const surface = setup.renderer.root.findDescendantById("station-help-surface");
    const viewport = setup.renderer.root.findDescendantById(
      "station-help-content",
    ) as ScrollBoxRenderable | undefined;
    const wrapped = setup.renderer.root.findDescendantById(
      semanticItemRenderableId("help:dashboard:filter"),
    );
    const finalEntry = setup.renderer.root.findDescendantById(
      semanticItemRenderableId("help:dashboard:help-refresh"),
    );

    expect(surface?.height).toBeLessThanOrEqual(8);
    expect(viewport).toBeDefined();
    expect(wrapped?.height).toBeGreaterThan(1);
    expect(finalEntry).toBeDefined();
    const initialFrame = setup.captureCharFrame();
    expect(initialFrame).toContain("refresh");
    expect(initialFrame).toMatch(/↑\d+/);
    expect(initialFrame).toContain("▲");
    expect(initialFrame).toContain("▼");
    expect(initialFrame).toContain("▐");
    expect(initialFrame).toContain("▕");

    await act(async () => {
      for (let index = 0; index < 60; index += 1) {
        await setup.mockMouse.scroll(15, 4, "down");
      }
    });
    await setup.flush();

    expect(viewport?.scrollTop).toBeGreaterThan(0);
    expect(setup.captureCharFrame()).toContain("refresh");

    await act(async () => {
      setup.renderer.resize(22, 6);
      setSize?.({ columns: 22, rows: 6 });
    });
    await setup.renderOnce();
    await setup.flush();

    expect(surface?.height).toBeLessThanOrEqual(6);
    expect(wrapped?.height).toBeGreaterThan(2);
    expect(finalEntry).toBeDefined();
    expect(setup.captureCharFrame()).toContain("▸");

    const scrollStepsToTop = Math.ceil(viewport?.scrollTop ?? 0) + 1;
    await act(async () => {
      for (let index = 0; index < scrollStepsToTop; index += 1) {
        await setup.mockMouse.scroll(
          viewport?.x ?? 0,
          (viewport?.y ?? 0) + 1,
          "up",
        );
      }
    });
    await setup.flush();

    expect(viewport?.scrollTop).toBe(0);
    expect(setup.captureCharFrame()).toMatch(/↓\d+/);
  });
});
