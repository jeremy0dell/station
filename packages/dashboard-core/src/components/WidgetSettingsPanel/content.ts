import {
  ADDABLE_WIDGET_TYPES,
  widgetSettingsRowLabel,
} from "../../state/screens/widgetSettings.js";
import type {
  DashboardScreenView,
  DashboardStateView,
  WidgetSettingsFocus,
} from "../../state/types.js";

export type WidgetSettingsLine =
  | { kind: "widget"; index: number; label: string; enabled: boolean; active: boolean }
  | { kind: "empty"; label: string }
  | { kind: "add"; label: string; active: boolean }
  | { kind: "pickerChoice"; index: number; label: string; active: boolean };

export type WidgetSettingsPanelModel = {
  title: string;
  /** Config-scope reminder under the title. */
  note: string;
  lines: readonly WidgetSettingsLine[];
  footer: string;
  focus: WidgetSettingsFocus;
};

export function widgetSettingsPanelModel(
  screen: Extract<DashboardScreenView, { name: "widgetSettings" }>,
  widgets: DashboardStateView["widgets"],
  widgetsPersisted = true,
): WidgetSettingsPanelModel {
  if (screen.focus === "picker") {
    return {
      title: "add widget",
      note: "weather and tz require config.toml",
      lines: ADDABLE_WIDGET_TYPES.map((type, index) => ({
        kind: "pickerChoice",
        index,
        label: widgetSettingsRowLabel({ type }),
        active: index === screen.pickerCursor,
      })),
      footer: "↵ add   esc back",
      focus: "picker",
    };
  }
  const lines: WidgetSettingsLine[] =
    widgets.length === 0
      ? [{ kind: "empty", label: "no widgets yet" }]
      : widgets.map((widget, index) => ({
          kind: "widget",
          index,
          label: widgetSettingsRowLabel(widget),
          enabled: widget.enabled !== false,
          active: index === screen.cursor,
        }));
  lines.push({ kind: "add", label: "[ + add widget ]", active: false });
  return {
    title: "widgets",
    note: widgetsPersisted
      ? "saved to config.toml"
      : "session only · create config.toml to persist",
    lines,
    footer: "↵ toggle   [ ] reorder   x remove   a add   esc close",
    focus: "list",
  };
}
