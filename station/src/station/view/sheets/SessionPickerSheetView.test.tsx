import { afterEach, describe, expect, it } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, createElement } from "react";
import { nativeStationTheme, StationThemeProvider } from "../../../theme/index.js";
import { SessionPickerSheetView } from "./SessionPickerSheetView.js";

const teardowns: Array<() => void> = [];

afterEach(async () => {
  await act(async () => {
    for (const teardown of teardowns.splice(0)) teardown();
  });
});

function DownstreamSheet() {
  return (
    <box id="session-picker-downstream">
      <text>Downstream sheet</text>
    </box>
  );
}

describe("SessionPickerSheetView", () => {
  it("renders the shared session chooser instructions", async () => {
    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <SessionPickerSheetView
          title="Select session to move to a Group"
          columns={80}
          rows={24}
        />
      </StationThemeProvider>,
      { width: 80, height: 24 },
    );
    teardowns.push(() => setup.renderer.destroy());
    await setup.renderOnce();

    const frame = setup.captureCharFrame();
    expect(frame).toContain("Select session to move to a Group");
    expect(frame).toContain("↑↓ move · ↵ choose · slot or click");
    expect(frame).toContain("Esc:cancel");
  });

  it("keeps the chooser inside a narrow terminal", async () => {
    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <SessionPickerSheetView
          title="Select session to move to a Group"
          columns={24}
          rows={8}
        />
      </StationThemeProvider>,
      { width: 24, height: 8 },
    );
    teardowns.push(() => setup.renderer.destroy());
    await setup.renderOnce();

    const sheet = setup.renderer.root.findDescendantById("station-bottom-sheet");
    expect(sheet).toMatchObject({ x: 0, y: 0, width: 24, height: 8 });
    expect(setup.captureCharFrame()).toContain("Select session to");
    expect(setup.captureCharFrame()).toContain("move to a Group");
    expect(setup.captureCharFrame()).toContain("↑↓ move");
    expect(setup.captureCharFrame()).toContain("Esc:cancel");
  });

  it("renders a downstream sheet exclusively when next is present", async () => {
    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <SessionPickerSheetView
          title="Chooser must be absent"
          columns={80}
          rows={24}
          next={createElement(DownstreamSheet)}
        />
      </StationThemeProvider>,
      { width: 80, height: 24 },
    );
    teardowns.push(() => setup.renderer.destroy());
    await setup.renderOnce();

    expect(setup.renderer.root.findDescendantById("session-picker-downstream")).toBeDefined();
    expect(setup.renderer.root.findDescendantById("station-bottom-sheet")).toBeUndefined();
    expect(setup.captureCharFrame()).toContain("Downstream sheet");
    expect(setup.captureCharFrame()).not.toContain("Chooser must be absent");
    expect(setup.captureCharFrame()).not.toContain("slot or click");
  });
});
