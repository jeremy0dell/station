import { describe, expect, it } from "bun:test";
import { settingsPanelFrame, widgetSettingsFrame } from "./settingsPanelFrame.js";

describe("settings panel render-boundary frame", () => {
  it("uses a compact preferred block size without exceeding the terminal", () => {
    expect(settingsPanelFrame(120, 40)).toEqual({
      width: 88,
      height: 20,
      innerWidth: 86,
      paneMode: "split",
      listWidth: 26,
      detailWidth: 59,
    });
    expect(widgetSettingsFrame(120, 40)).toEqual({
      width: 48,
      height: 20,
      innerWidth: 46,
    });
    expect(settingsPanelFrame(80, 12).height).toBe(12);
    expect(widgetSettingsFrame(80, 8).height).toBe(8);
  });

  it("switches pane composition at the renderer breakpoint and remains width-bounded", () => {
    expect(settingsPanelFrame(61, 20)).toMatchObject({
      width: 55,
      paneMode: "single",
    });
    expect(settingsPanelFrame(62, 20).paneMode).toBe("split");
    expect(settingsPanelFrame(40, 20)).toMatchObject({
      width: 40,
      paneMode: "single",
    });
    expect(settingsPanelFrame(10, 20).width).toBe(10);
    expect(widgetSettingsFrame(10, 20).width).toBe(10);
  });
});
