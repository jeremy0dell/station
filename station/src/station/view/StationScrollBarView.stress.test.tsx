// OpenTUI's last-cell math cannot reach maxOffset on a tall crowded track.
// These clicks/drags go through StationScrollBarView, which must snap ends.
import { afterEach, describe, expect, it } from "bun:test";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { StationMouseTarget } from "../input/stationMouse.js";
import { nativeStationTheme, toOpenTuiColor, toOpenTuiOpaqueColor } from "../../theme/index.js";
import { StationMouseProvider } from "./stationMouseContext.js";
import { StationScrollBarView } from "./StationScrollBarView.js";

const TRACK = 17;
const CONTENT = 300;
const VIEWPORT = 17;
const MAX_OFFSET = CONTENT - VIEWPORT;
const OPEN_TUI_LAST_CELL_LIE = Math.round(((TRACK - 1) / TRACK) * MAX_OFFSET);
const MOUSE = { delayMs: 0 } as const;
const THUMB = /[█▀▄]/;

describe("StationScrollBarView end snaps", () => {
  const teardowns: Array<() => void> = [];
  afterEach(() => {
    for (const teardown of teardowns.splice(0)) {
      teardown();
    }
  });

  it("clicking the last cell reports maxOffset, not OpenTUI's exclusive-end ratio", async () => {
    const hits = await renderBar(0);
    await act(async () => {
      await hits.setup.mockMouse.click(0, TRACK - 1, MouseButtons.LEFT, MOUSE);
    });
    const offsets = scrollbarOffsets(hits.targets);
    expect(offsets.at(-1)).toBe(MAX_OFFSET);
    expect(offsets).not.toContain(OPEN_TUI_LAST_CELL_LIE);
  });

  it("clicking the last cell while already at max does not jump back up the track", async () => {
    const hits = await renderBar(MAX_OFFSET);
    await act(async () => {
      await hits.setup.mockMouse.click(0, TRACK - 1, MouseButtons.LEFT, MOUSE);
    });
    for (const offset of scrollbarOffsets(hits.targets)) {
      expect(offset).toBe(MAX_OFFSET);
    }
  });

  it("dragging from the first cell to the last cell reports maxOffset", async () => {
    const hits = await renderBar(0);
    await act(async () => {
      await hits.setup.mockMouse.drag(0, 0, 0, TRACK - 1, MouseButtons.LEFT, MOUSE);
    });
    expect(lastScrollbarOffset(hits.targets)).toBe(MAX_OFFSET);
  });

  it("dragging past the last cell still reports maxOffset", async () => {
    const hits = await renderBar(0);
    await act(async () => {
      await hits.setup.mockMouse.drag(0, 8, 0, TRACK + 4, MouseButtons.LEFT, MOUSE);
    });
    expect(lastScrollbarOffset(hits.targets)).toBe(MAX_OFFSET);
  });

  it("clicking the first cell from the bottom reports 0", async () => {
    const hits = await renderBar(MAX_OFFSET);
    await act(async () => {
      await hits.setup.mockMouse.click(0, 0, MouseButtons.LEFT, MOUSE);
    });
    expect(lastScrollbarOffset(hits.targets)).toBe(0);
  });

  it("clicking a middle cell does not snap to either end", async () => {
    const hits = await renderBar(0);
    await act(async () => {
      await hits.setup.mockMouse.click(0, 8, MouseButtons.LEFT, MOUSE);
    });
    const offset = lastScrollbarOffset(hits.targets);
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThan(MAX_OFFSET);
  });

  it("clicking the second-to-last cell does not snap to maxOffset", async () => {
    const hits = await renderBar(0);
    await act(async () => {
      await hits.setup.mockMouse.click(0, TRACK - 2, MouseButtons.LEFT, MOUSE);
    });
    const offset = lastScrollbarOffset(hits.targets);
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThan(MAX_OFFSET);
  });

  it("clicking the painted thumb without moving keeps that thumb cell", async () => {
    const hits = await renderBar(100);
    const startThumb = hits.setup.captureCharFrame();
    const thumbY = startThumb.split("\n").findIndex((line) => THUMB.test(line));
    expect(thumbY).toBeGreaterThanOrEqual(0);
    await act(async () => {
      await hits.setup.mockMouse.click(0, thumbY, MouseButtons.LEFT, MOUSE);
    });
    await hits.setup.flush();
    expect(hits.setup.captureCharFrame()).toBe(startThumb);
  });

  it("dragging from the last cell back to the first reports 0", async () => {
    const hits = await renderBar(MAX_OFFSET);
    await act(async () => {
      await hits.setup.mockMouse.drag(0, TRACK - 1, 0, 0, MouseButtons.LEFT, MOUSE);
    });
    expect(lastScrollbarOffset(hits.targets)).toBe(0);
  });

  async function renderBar(offset: number) {
    const targets: StationMouseTarget[] = [];
    const setup = await testRender(
      <StationMouseProvider value={(target) => targets.push(target)}>
        <box width={1} height={TRACK}>
          <StationScrollBarView
            surface="dashboard"
            contentLength={CONTENT}
            viewportLength={VIEWPORT}
            offset={offset}
            trackBackground={toOpenTuiOpaqueColor(nativeStationTheme.surfaces.canvas)}
            thumbColor={toOpenTuiColor(nativeStationTheme.text.muted)}
            height={TRACK}
          />
        </box>
      </StationMouseProvider>,
      { width: 1, height: TRACK },
    );
    teardowns.push(() => {
      setup.renderer.destroy();
    });
    await setup.renderOnce();
    return { setup, targets };
  }
});

function scrollbarOffsets(targets: readonly StationMouseTarget[]): number[] {
  return targets.flatMap((hit) => (hit.kind === "scrollbar" ? [hit.offset] : []));
}

function lastScrollbarOffset(targets: readonly StationMouseTarget[]): number {
  const offset = scrollbarOffsets(targets).at(-1);
  if (offset === undefined) {
    throw new Error(`expected a scrollbar hit, got ${JSON.stringify(targets)}`);
  }
  return offset;
}
