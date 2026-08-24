import {
  ADDABLE_WIDGET_TYPES,
  widgetSettingsRowLabel,
} from "../../state/screens/widgetSettings.js";
import type {
  AddableWidgetType,
  DashboardScreenView,
  DashboardStateView,
  WidgetSettingsFocus,
  WidgetSettingsItemId,
} from "../../state/types.js";

export type WidgetSettingsItem =
  | {
      kind: "widget";
      itemId: WidgetSettingsItemId;
      label: string;
      enabled: boolean;
      active: boolean;
    }
  | { kind: "empty"; itemId: "empty"; label: string }
  | { kind: "add"; itemId: "add"; label: string; active: boolean }
  | {
      kind: "pickerChoice";
      itemId: `picker:${AddableWidgetType}`;
      widgetType: AddableWidgetType;
      label: string;
      active: boolean;
    };

export type WidgetSettingsPanelModel = {
  title: string;
  /** Config-scope reminder under the title. */
  note: string;
  items: readonly WidgetSettingsItem[];
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
      items: ADDABLE_WIDGET_TYPES.map((type) => ({
        kind: "pickerChoice",
        itemId: `picker:${type}`,
        widgetType: type,
        label: widgetSettingsRowLabel({ type }),
        active: type === screen.activePickerType,
      })),
      footer: "↵ add   esc back",
      focus: "picker",
    };
  }
  const items: WidgetSettingsItem[] =
    widgets.length === 0
      ? [{ kind: "empty", itemId: "empty", label: "no widgets yet" }]
      : widgets.flatMap((widget, index) => {
          const itemId = screen.widgetItemIds[index];
          return itemId === undefined
            ? []
            : [
                {
                  kind: "widget" as const,
                  itemId,
                  label: widgetSettingsRowLabel(widget),
                  enabled: widget.enabled !== false,
                  active: itemId === screen.activeWidgetItemId,
                },
              ];
        });
  items.push({ kind: "add", itemId: "add", label: "[ + add widget ]", active: false });
  return {
    title: "widgets",
    note: widgetsPersisted
      ? "saved to config.toml"
      : "session only · create config.toml to persist",
    items,
    footer: "↵ toggle   [ ] reorder   x remove   a add   esc close",
    focus: "list",
  };
}
