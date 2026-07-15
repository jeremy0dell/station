import { describe, expect, it } from "vitest";
import { widgetSettingsPanelModel } from "../../../../src/components/WidgetSettingsPanel/content.js";
import { createInitialTuiState } from "../../../../src/state/screen.js";
import { openWidgetSettings } from "../../../../src/state/screens/widgetSettings.js";

function widgetSettingsScreen() {
  const state = openWidgetSettings(createInitialTuiState({ widgets: [{ type: "time" }] }));
  if (state.screen.name !== "widgetSettings") {
    throw new Error("expected the widgetSettings screen");
  }
  return state.screen;
}

describe("widgetSettingsPanelModel note", () => {
  it("claims config persistence only when a config path exists", () => {
    const screen = widgetSettingsScreen();
    expect(widgetSettingsPanelModel(screen, [{ type: "time" }]).note).toBe("saved to config.toml");
    expect(widgetSettingsPanelModel(screen, [{ type: "time" }], false).note).toBe(
      "session only · create config.toml to persist",
    );
  });
});
