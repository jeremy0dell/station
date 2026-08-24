import { afterEach, describe, expect, it } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { TuiWidgetConfig } from "@station/contracts";
import { nativeStationTheme, StationThemeProvider } from "../../../theme/index.js";
import { semanticItemRenderableId } from "../layout/scrollViewport.js";
import { StationHoverProvider, StationMouseProvider } from "../stationMouseContext.js";
import { WidgetSettingsPanelView } from "./WidgetSettingsPanelView.js";

const teardowns: Array<() => void> = [];
afterEach(() => {
  for (const teardown of teardowns.splice(0)) teardown();
});

describe("WidgetSettingsPanelView", () => {
  it("keeps the full semantic list mounted while following focus in a short viewport", async () => {
    const widgets: TuiWidgetConfig[] = Array.from({ length: 15 }, (_, index) => ({
      type: index % 2 === 0 ? "time" : "moon",
    }));
    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <StationHoverProvider value>
          <StationMouseProvider value={() => {}}>
            <WidgetSettingsPanelView
              screen={{ name: "widgetSettings", focus: "list", cursor: 14, pickerCursor: 0 }}
              widgets={widgets}
              widgetsPersisted
              columns={48}
              rows={8}
            />
          </StationMouseProvider>
        </StationHoverProvider>
      </StationThemeProvider>,
      { width: 48, height: 8 },
    );
    teardowns.push(() => setup.renderer.destroy());
    await setup.renderOnce();
    await setup.flush();
    await setup.renderOnce();
    await setup.flush();

    expect(setup.captureCharFrame()).toContain("▸ [on ] time");
    expect(setup.captureCharFrame()).toContain("↵ toggle");
    expect(
      setup.renderer.root.findDescendantById(
        semanticItemRenderableId("widget-settings:widget:0"),
      ),
    ).toBeDefined();
    expect(
      setup.renderer.root.findDescendantById(
        semanticItemRenderableId("widget-settings:widget:14"),
      ),
    ).toBeDefined();
  });

  it("scrolls long content inside the same compact preferred-height panel", async () => {
    const widgets: TuiWidgetConfig[] = Array.from({ length: 28 }, (_, index) => ({
      type: index % 2 === 0 ? "time" : "moon",
    }));
    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <StationHoverProvider value>
          <StationMouseProvider value={() => {}}>
            <WidgetSettingsPanelView
              screen={{ name: "widgetSettings", focus: "list", cursor: 27, pickerCursor: 0 }}
              widgets={widgets}
              widgetsPersisted
              columns={80}
              rows={40}
            />
          </StationMouseProvider>
        </StationHoverProvider>
      </StationThemeProvider>,
      { width: 80, height: 40 },
    );
    teardowns.push(() => setup.renderer.destroy());
    await setup.renderOnce();
    await setup.flush();
    await setup.renderOnce();

    const panel = setup.renderer.root.findDescendantById("station-widget-settings-panel");
    expect(panel?.height).toBe(20);
    expect(panel?.y).toBe(10);
    expect(setup.captureCharFrame()).toContain("▸ [on ] moon");
    expect(
      setup.renderer.root.findDescendantById(
        semanticItemRenderableId("widget-settings:widget:0"),
      ),
    ).toBeDefined();
  });
});
