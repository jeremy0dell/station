import { describe, expect, it } from "bun:test";
import { settingsPanelFrame, widgetSettingsFrame } from "./settingsPanelFrame.js";

describe("settings panel render-boundary frame", () => {
  it("leaves block sizing to the parent flex surface", () => {
    expect(settingsPanelFrame(120)).toEqual({
      width: 88,
      innerWidth: 86,
      paneMode: "split",
      listWidth: 26,
      detailWidth: 59,
    });
    expect(widgetSettingsFrame(120)).toEqual({
      width: 48,
      innerWidth: 46,
    });
  });

  it("switches pane composition at the renderer breakpoint and remains width-bounded", () => {
    expect(settingsPanelFrame(61)).toMatchObject({
      width: 55,
      paneMode: "single",
    });
    expect(settingsPanelFrame(62).paneMode).toBe("split");
    expect(settingsPanelFrame(40)).toMatchObject({
      width: 40,
      paneMode: "single",
    });
    expect(settingsPanelFrame(10).width).toBe(10);
    expect(widgetSettingsFrame(10).width).toBe(10);
  });
});
