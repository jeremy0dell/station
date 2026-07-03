import type { TuiWidgetConfig } from "@station/config";
import {
  ADDABLE_WIDGET_TYPES,
  widgetSettingsRowLabel,
} from "../../state/screens/widgetSettings.js";
import type { TuiState, WidgetSettingsFocus } from "../../state/types.js";

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
  screen: Extract<TuiState["screen"], { name: "widgetSettings" }>,
  widgets: readonly TuiWidgetConfig[],
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

export type WidgetSettingsPanelLayout = {
  top: number;
  left: number;
  width: number;
  height: number;
  innerWidth: number;
};

const PANEL_WIDTH = 48;
const MIN_PANEL_WIDTH = 28;
// Border pair + title + note + footer around the line list.
const CHROME_ROWS = 5;

export function widgetSettingsPanelLayout(
  columns: number,
  rows: number,
  lineCount: number,
): WidgetSettingsPanelLayout {
  const width = Math.min(PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, columns - 2));
  const height = Math.min(rows, CHROME_ROWS + Math.max(1, lineCount));
  return {
    left: Math.max(0, Math.floor((columns - width) / 2)),
    top: Math.max(0, Math.floor((rows - height) / 2)),
    width,
    height,
    innerWidth: width - 2,
  };
}
