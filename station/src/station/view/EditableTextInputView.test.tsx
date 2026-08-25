import { afterEach, describe, expect, it } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { nativeStationTheme, StationThemeProvider } from "../../theme/index.js";
import { EditableTextInputView } from "./EditableTextInputView.js";

const teardowns: Array<() => void> = [];

afterEach(() => {
  for (const teardown of teardowns.splice(0)) teardown();
});

describe("EditableTextInputView", () => {
  it("renders the cursor outside a combining grapheme", async () => {
    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <text>
          <EditableTextInputView value={"界e\u0301🙂"} cursor={2} />
        </text>
      </StationThemeProvider>,
      { width: 12, height: 1 },
    );
    teardowns.push(() => setup.renderer.destroy());
    await setup.renderOnce();

    expect(setup.captureCharFrame()).toContain("界|e\u0301🙂");
    expect(setup.captureCharFrame()).not.toContain("界e|\u0301🙂");
  });
});
