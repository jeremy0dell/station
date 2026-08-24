import { TextAttributes, type ColorInput } from "@opentui/core";
import type {
  DashboardScreenView,
  DashboardStateView,
  WidgetSettingsFocus,
  WidgetSettingsItemId,
} from "@station/dashboard-core/state";
import { widgetSettingsPanelModel } from "@station/dashboard-core/selectors";
import type { WidgetSettingsItem } from "@station/dashboard-core/selectors";
import { SemanticScrollRegion } from "../layout/SemanticScrollViewport.js";
import { semanticItemRenderableId } from "../layout/scrollViewport.js";
import { widgetSettingsFrame } from "../layout/settingsPanelFrame.js";
import { fit } from "../sheets/parts.js";
import { toOpenTuiColor, toOpenTuiOpaqueColor, useStationTheme } from "../../../theme/index.js";
import {
  stationMouseProps,
  useStationHoverState,
  useStationMouse,
} from "../stationMouseContext.js";

const UNSELECTABLE_TEXT = { selectable: false } as const;

export type WidgetSettingsPanelViewProps = {
  screen: Extract<DashboardScreenView, { name: "widgetSettings" }>;
  widgets: DashboardStateView["widgets"];
  widgetsPersisted: boolean;
  columns: number;
  rows: number;
};

export function WidgetSettingsPanelView({
  screen,
  widgets,
  widgetsPersisted,
  columns,
  rows,
}: WidgetSettingsPanelViewProps) {
  const theme = useStationTheme();
  const surfaceBackground = toOpenTuiOpaqueColor(theme.surfaces.settings);
  const dispatch = useStationMouse();
  const model = widgetSettingsPanelModel(screen, widgets, widgetsPersisted);
  const frame = widgetSettingsFrame(columns, rows);
  const itemIds = model.items.map(widgetItemId);
  const followedItem = model.items.find(isActiveWidgetItem);
  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width={Math.max(1, columns)}
      height={Math.max(1, rows)}
      zIndex={10}
      alignItems="center"
      justifyContent="center"
      {...stationMouseProps(dispatch, { kind: "sheetBackdrop" })}
    >
      <box
        id="station-widget-settings-panel"
        width={frame.width}
        height={frame.height}
        border
        borderColor={toOpenTuiColor(theme.interaction.hairline)}
        backgroundColor={surfaceBackground}
        flexDirection="column"
      >
        <text
          flexShrink={0}
          fg={toOpenTuiColor(theme.text.primary)}
          bg={surfaceBackground}
          attributes={TextAttributes.BOLD}
          {...UNSELECTABLE_TEXT}
        >
          {fit(` ${model.title}`, frame.innerWidth)}
        </text>
        <text
          flexShrink={0}
          fg={toOpenTuiColor(theme.text.muted)}
          bg={surfaceBackground}
          {...UNSELECTABLE_TEXT}
        >
          {fit(` ${model.note}`, frame.innerWidth)}
        </text>
        <SemanticScrollRegion
          itemIds={itemIds}
          followedItemId={followedItem === undefined ? undefined : widgetItemId(followedItem)}
          fill
        >
          {model.items.map((item) => (
            <PanelItem
              key={itemKey(item)}
              item={item}
              width={frame.innerWidth}
              focus={model.focus}
              surfaceBackground={surfaceBackground}
            />
          ))}
        </SemanticScrollRegion>
        <text
          flexShrink={0}
          fg={toOpenTuiColor(theme.text.primary)}
          bg={surfaceBackground}
          attributes={TextAttributes.DIM}
          {...UNSELECTABLE_TEXT}
        >
          {fit(` ${model.footer}`, frame.innerWidth)}
        </text>
      </box>
    </box>
  );
}

function itemKey(item: WidgetSettingsItem): string {
  return item.itemId;
}

function widgetItemId(item: WidgetSettingsItem): string {
  return `widget-settings:${itemKey(item)}`;
}

function isActiveWidgetItem(item: WidgetSettingsItem): boolean {
  switch (item.kind) {
    case "widget":
    case "add":
    case "pickerChoice":
      return item.active;
    case "empty":
      return false;
  }
}

function PanelItem({
  item,
  width,
  focus,
  surfaceBackground,
}: {
  item: WidgetSettingsItem;
  width: number;
  focus: WidgetSettingsFocus;
  surfaceBackground: ColorInput;
}) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  if (item.kind === "empty") {
    return (
      <text
        id={semanticItemRenderableId(widgetItemId(item))}
        fg={toOpenTuiColor(theme.text.muted)}
        bg={surfaceBackground}
        {...UNSELECTABLE_TEXT}
      >
        {fit(`   ${item.label}`, width)}
      </text>
    );
  }
  if (item.kind === "add") {
    return (
      <text
        id={semanticItemRenderableId(widgetItemId(item))}
        fg={toOpenTuiColor(theme.action.primary)}
        bg={hover ? toOpenTuiColor(theme.interaction.hover) : surfaceBackground}
        {...UNSELECTABLE_TEXT}
        {...stationMouseProps(dispatch, { kind: "widgetSettingsAdd" })}
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
      >
        {fit(`   ${item.label}`, width)}
      </text>
    );
  }
  if (item.kind === "pickerChoice") {
    let background: ColorInput = surfaceBackground;
    if (item.active) {
      background = toOpenTuiColor(theme.interaction.keyboardFocus);
    }
    if (hover) {
      background = toOpenTuiColor(theme.interaction.hover);
    }
    return (
      <text
        id={semanticItemRenderableId(widgetItemId(item))}
        fg={toOpenTuiColor(item.active ? theme.action.primary : theme.text.primary)}
        bg={background}
        {...UNSELECTABLE_TEXT}
        {...stationMouseProps(dispatch, {
          kind: "widgetSettingsPickerChoice",
          widgetType: item.widgetType,
        })}
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
      >
        {fit(` ${item.active ? "▸" : " "} ${item.label}`, width)}
      </text>
    );
  }
  // The list dims behind the picker so the active surface is unambiguous.
  const dimmed = focus === "picker";
  const chip = item.enabled ? "[on ]" : "[off]";
  const marker = item.active && !dimmed ? "▸" : " ";
  let rowColor: ColorInput = toOpenTuiColor(theme.text.muted);
  if (!dimmed && item.active) {
    rowColor = toOpenTuiColor(theme.action.primary);
  } else if (!dimmed && item.enabled) {
    rowColor = toOpenTuiColor(theme.text.primary);
  }
  return (
    <box id={semanticItemRenderableId(widgetItemId(item))} flexDirection="row">
      <text
        fg={rowColor}
        bg={hover && !dimmed ? toOpenTuiColor(theme.interaction.hover) : surfaceBackground}
        {...UNSELECTABLE_TEXT}
        {...stationMouseProps(dispatch, { kind: "widgetSettingsRow", itemId: item.itemId })}
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
      >
        {fit(` ${marker} ${chip} ${item.label}`, width - 2)}
      </text>
      <RemoveMark
        itemId={item.itemId}
        rowHovered={hover && !dimmed}
        surfaceBackground={surfaceBackground}
      />
    </box>
  );
}

// Its own element so the click hits only the remove action, never row-toggle.
function RemoveMark({
  itemId,
  rowHovered,
  surfaceBackground,
}: {
  itemId: WidgetSettingsItemId;
  rowHovered: boolean;
  surfaceBackground: ColorInput;
}) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  const color = hover
    ? theme.status.danger
    : rowHovered
      ? theme.text.muted
      : theme.interaction.hairline;
  return (
    <text
      fg={toOpenTuiColor(color)}
      bg={surfaceBackground}
      {...UNSELECTABLE_TEXT}
      {...stationMouseProps(dispatch, { kind: "widgetSettingsRemove", itemId })}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      {"× "}
    </text>
  );
}
