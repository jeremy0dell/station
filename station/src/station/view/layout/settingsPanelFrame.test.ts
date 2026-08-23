import { describe, expect, it } from "bun:test";
import { settingsPanelFrame, widgetSettingsFrame } from "./settingsPanelFrame.js";

describe("settings panel render-boundary frame", () => {
  it("caps renderer geometry while leaving content height out of the contract", () => {
    expect(settingsPanelFrame(120, 40)).toEqual({
      width: 88,
      innerWidth: 86,
      height: 20,
      paneMode: "split",
      listWidth: 26,
      detailWidth: 59,
    });
    expect(widgetSettingsFrame(120, 40)).toEqual({
      width: 48,
      innerWidth: 46,
      maxHeight: 20,
    });
  });

  it("switches pane composition at the renderer breakpoint and remains viewport-bounded", () => {
    expect(settingsPanelFrame(61, 10)).toMatchObject({
      width: 55,
      height: 10,
      paneMode: "single",
    });
    expect(settingsPanelFrame(62, 20).paneMode).toBe("split");
    expect(settingsPanelFrame(40, 8)).toMatchObject({
      width: 40,
      height: 8,
      paneMode: "single",
    });
    expect(settingsPanelFrame(10, 5).width).toBe(10);
    expect(widgetSettingsFrame(10, 5).width).toBe(10);
  });
});
