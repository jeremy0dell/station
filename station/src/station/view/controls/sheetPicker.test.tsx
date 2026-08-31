import { afterEach, describe, expect, it } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { nativeStationTheme, StationThemeProvider } from "../../../theme/index.js";
import { StationHoverProvider, StationMouseProvider } from "../stationMouseContext.js";
import { SheetChoiceLine } from "./sheetPicker.js";

const teardowns: Array<() => void> = [];
afterEach(() => {
  for (const teardown of teardowns.splice(0)) teardown();
});

describe("sheet terminal-cell fitting", () => {
  it("keeps a long wide-glyph choice inside one semantic box", async () => {
    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <StationHoverProvider value>
          <StationMouseProvider value={() => {}}>
            <SheetChoiceLine
              choiceKey="1"
              label="界界界界界界界界 project with a long name"
              detail="healthy"
              width={20}
              selected
              itemId="wide-choice"
            />
          </StationMouseProvider>
        </StationHoverProvider>
      </StationThemeProvider>,
      { width: 20, height: 2 },
    );
    teardowns.push(() => setup.renderer.destroy());
    await setup.renderOnce();

    expect(setup.captureCharFrame().split("\n")[1]?.trim()).toBe("");
    expect(
      setup.renderer.root.findDescendantById("station-semantic-item:wide-choice")?.height,
    ).toBe(1);
  });
});
