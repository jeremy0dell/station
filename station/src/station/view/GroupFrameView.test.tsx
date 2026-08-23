import { afterEach, describe, expect, it } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { nativeStationTheme, StationThemeProvider } from "../../theme/index.js";
import { act } from "react";
import { GroupFrameView } from "./GroupFrameView.js";

const teardowns: Array<() => void> = [];

afterEach(() => {
  for (const teardown of teardowns.splice(0)) teardown();
});

describe("GroupFrameView", () => {
  it("keeps a mixed-height semantic child inside one structural border", async () => {
    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <GroupFrameView
          renderableId="group-frame"
          focus={{ focusedHeader: false, containsFocusedRow: false }}
        >
          <box id="mixed-child" flexDirection="column">
            <text>first semantic cell</text>
            <text>second semantic cell</text>
          </box>
        </GroupFrameView>
      </StationThemeProvider>,
      { width: 24, height: 6 },
    );
    teardowns.push(() => setup.renderer.destroy());
    await setup.renderOnce();

    const frame = setup.captureCharFrame().split("\n");
    const child = setup.renderer.root.findDescendantById("mixed-child");
    const first = frame.findIndex((line) => line.includes("first semantic cell"));
    expect(child?.height).toBe(2);
    expect(frame[first]?.startsWith("│")).toBe(true);
    expect(frame[first]?.trimEnd().endsWith("│")).toBe(true);
    expect(frame[first + 1]?.startsWith("│")).toBe(true);
    expect(frame[first + 1]?.trimEnd().endsWith("│")).toBe(true);
    expect(frame[first - 1]?.trim()).toMatch(/^╭─+╮$/u);
    expect(frame[first + 2]?.trim()).toMatch(/^╰─+╯$/u);

    await act(async () => setup.renderer.resize(14, 6));
    await setup.renderOnce();
    const resized = setup.captureCharFrame().split("\n");
    const resizedFirst = resized.findIndex((line) => line.includes("first"));
    expect(child?.height).toBe(4);
    for (const line of resized.slice(resizedFirst, resizedFirst + 4)) {
      expect(line.startsWith("│")).toBe(true);
      expect(line.trimEnd().endsWith("│")).toBe(true);
    }
    expect(resized[resizedFirst - 1]?.trim()).toMatch(/^╭─+╮$/u);
    expect(resized[resizedFirst + 4]?.trim()).toMatch(/^╰─+╯$/u);
  });
});
