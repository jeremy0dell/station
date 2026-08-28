// Temporary visual proof for the native scrollbar adapter. Delete before merge.
import { afterEach, describe, expect, it } from "bun:test";
import { rgbToHex } from "@opentui/core";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import {
  nativeStationTheme,
  StationThemeProvider,
} from "../../theme/index.js";
import { spanAtFrameCell } from "../../terminal/testing/frameProbe.js";
import { StationScrollbar } from "./StationScrollbar.js";
import { StationHoverProvider, StationMouseProvider } from "./stationMouseContext.js";

const SIZE = { width: 1, height: 9 };
const teardowns: Array<() => void> = [];

describe("StationScrollbar isolated golden frames", () => {
  afterEach(() => {
    for (const teardown of teardowns.splice(0)) teardown();
  });

  for (const state of [
    { name: "fits", contentLength: 9, viewportLength: 9, offset: 0 },
    { name: "one-extra", contentLength: 10, viewportLength: 9, offset: 0 },
    { name: "top", contentLength: 27, viewportLength: 9, offset: 0 },
    { name: "middle", contentLength: 27, viewportLength: 9, offset: 9 },
    { name: "bottom", contentLength: 27, viewportLength: 9, offset: 18 },
    { name: "many", contentLength: 90, viewportLength: 9, offset: 45 },
  ]) {
    it(`renders ${state.name}`, async () => {
      const setup = await renderScrollbar(state);
      expect(snapshotFrame(setup)).toMatchSnapshot();
    });
  }

  it("changes only color while hovered and fills the track while dragging", async () => {
    const setup = await renderScrollbar({ contentLength: 27, viewportLength: 9, offset: 9 });
    const idle = snapshotFrame(setup);

    await act(async () => {
      await setup.mockMouse.moveTo(0, 4);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await setup.flush();
    const hovered = snapshotFrame(setup);
    expect(stripColors(hovered)).toBe(stripColors(idle));
    expect(hovered).toMatchSnapshot();

    await act(async () => {
      await setup.mockMouse.pressDown(0, 4, MouseButtons.LEFT);
    });
    await setup.flush();
    expect(snapshotFrame(setup)).toMatchSnapshot();

    await act(async () => {
      await setup.mockMouse.moveTo(0, SIZE.height - 1);
    });
    await setup.flush();
    expect(snapshotFrame(setup)).toMatchSnapshot();

    await act(async () => {
      await setup.mockMouse.release(0, SIZE.height - 1, MouseButtons.LEFT);
      await setup.mockMouse.moveTo(0, 0);
    });
    await setup.flush();
  });
});

async function renderScrollbar(input: {
  contentLength: number;
  viewportLength: number;
  offset: number;
}) {
  const setup = await testRender(
    <StationThemeProvider theme={nativeStationTheme}>
      <StationHoverProvider value>
        <StationMouseProvider value={() => {}}>
          <StationScrollbar
            surface="dashboard"
            contentLength={input.contentLength}
            viewportLength={input.viewportLength}
            trackHeight={SIZE.height}
            offset={input.offset}
          />
        </StationMouseProvider>
      </StationHoverProvider>
    </StationThemeProvider>,
    SIZE,
  );
  teardowns.push(() => setup.renderer.destroy());
  await act(async () => {
    await setup.renderOnce();
  });
  return setup;
}

function snapshotFrame(setup: Awaited<ReturnType<typeof testRender>>): string {
  const chars = setup.captureCharFrame().split("\n").slice(0, SIZE.height);
  const spans = setup.captureSpans();
  return chars
    .map((glyph, row) => {
      const span = spanAtFrameCell(spans, row, 0);
      return `${glyph}|fg=${span?.fg === undefined ? "none" : rgbToHex(span.fg)}|bg=${span?.bg === undefined ? "none" : rgbToHex(span.bg)}`;
    })
    .join("\n");
}

function stripColors(frame: string): string {
  return frame.replace(/\|fg=[^|]+\|bg=[^|]+/g, "");
}
