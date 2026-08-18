import { TextAttributes } from "@opentui/core";
import type { SettingsPanelLayout } from "@station/dashboard-core/selectors";
import type { SettingsPanelFocus } from "@station/dashboard-core/state";
import type { ReactNode } from "react";
import { toOpenTuiColor, toOpenTuiOpaqueColor, useStationTheme } from "../../../theme/index.js";
import type { StationMouseTarget } from "../../input/stationMouse.js";
import { fit } from "../sheets/parts.js";
import {
  stationMouseProps,
  useStationHoverState,
  useStationMouse,
} from "../stationMouseContext.js";

export type SettingsPanelItemView = {
  id: string;
  label: string;
  active: boolean;
  danger?: boolean;
  disabled?: boolean;
  mouseTarget: StationMouseTarget;
};

export type SettingsPanelDetailLayout = {
  width: number;
  height: number;
  focused: boolean;
};

export type SettingsPanelViewProps = {
  layout: SettingsPanelLayout;
  focus: SettingsPanelFocus;
  title: string;
  compactDetailTitle: string;
  footer: string;
  listHeader: string;
  items: readonly SettingsPanelItemView[];
  renderDetail: (layout: SettingsPanelDetailLayout) => ReactNode;
};

export function SettingsPanelView({
  layout,
  focus,
  title,
  compactDetailTitle,
  footer,
  listHeader,
  items,
  renderDetail,
}: SettingsPanelViewProps) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const singlePane = layout.paneMode === "single";
  const showList = !singlePane || focus === "list";
  const showDetail = !singlePane || focus === "detail";
  const listWidth = singlePane ? layout.innerWidth : layout.leftWidth;
  const detailWidth = singlePane ? layout.innerWidth : layout.rightWidth;
  const visibleTitle = singlePane && showDetail ? compactDetailTitle : title;

  return (
    <box
      position="absolute"
      top={layout.top}
      left={layout.left}
      width={layout.width}
      height={layout.height}
      zIndex={10}
      border
      borderColor={toOpenTuiColor(theme.interaction.hairline)}
      backgroundColor={toOpenTuiOpaqueColor(theme.surfaces.settings)}
      flexDirection="column"
      {...stationMouseProps(dispatch, { kind: "sheetBackdrop" })}
    >
      <text fg={toOpenTuiColor(theme.text.primary)} attributes={TextAttributes.BOLD}>
        {fit(` ${visibleTitle}`, layout.innerWidth)}
      </text>
      <box flexDirection="row" width={layout.innerWidth} height={layout.contentHeight}>
        {showList ? (
          <box flexDirection="column" width={listWidth}>
            <SettingsPanelList
              header={listHeader}
              focused={focus === "list"}
              items={items}
              width={listWidth}
            />
          </box>
        ) : null}
        {!singlePane ? <SettingsPanelDivider height={layout.contentHeight} /> : null}
        {showDetail ? (
          <box flexDirection="column" width={detailWidth}>
            {renderDetail({
              width: detailWidth,
              height: layout.contentHeight,
              focused: focus === "detail",
            })}
          </box>
        ) : null}
      </box>
      <text fg={toOpenTuiColor(theme.text.primary)} attributes={TextAttributes.DIM}>
        {fit(` ${footer}`, layout.innerWidth)}
      </text>
    </box>
  );
}

function SettingsPanelList({
  header,
  focused,
  items,
  width,
}: {
  header: string;
  focused: boolean;
  items: readonly SettingsPanelItemView[];
  width: number;
}) {
  return (
    <>
      <SettingsPaneHeader label={header} width={width} focused={focused} />
      {items.map((item) => (
        <SettingsPanelItemRow key={item.id} item={item} width={width} />
      ))}
    </>
  );
}

function SettingsPanelItemRow({ item, width }: { item: SettingsPanelItemView; width: number }) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  return (
    <text
      fg={toOpenTuiColor(
        item.danger
          ? theme.status.danger
          : item.active
            ? theme.action.primary
            : theme.text.primary,
      )}
      {...(hover && item.disabled !== true
        ? { bg: toOpenTuiColor(theme.interaction.hover) }
        : {})}
      {...(item.disabled === true ? {} : stationMouseProps(dispatch, item.mouseTarget))}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      {fit(`${item.active ? "▸ " : "  "}${item.label}`, width)}
    </text>
  );
}

export function SettingsPaneHeader({
  label,
  width,
  focused,
  danger = false,
}: {
  label: string;
  width: number;
  focused: boolean;
  danger?: boolean;
}) {
  const theme = useStationTheme();
  const accent = danger ? theme.status.danger : theme.action.primary;
  return focused ? (
    <text
      fg={toOpenTuiColor(theme.text.inverse)}
      bg={toOpenTuiColor(accent)}
      attributes={TextAttributes.BOLD}
    >
      {fit(` ${label}`, width)}
    </text>
  ) : (
    <text
      fg={toOpenTuiColor(danger ? theme.status.danger : theme.text.primary)}
      attributes={TextAttributes.BOLD}
    >
      {fit(` ${label}`, width)}
    </text>
  );
}

function SettingsPanelDivider({ height }: { height: number }) {
  const theme = useStationTheme();
  return (
    <box flexDirection="column" width={1}>
      {Array.from({ length: height }, (_, row) => (
        <text key={row} fg={toOpenTuiColor(theme.text.muted)}>
          │
        </text>
      ))}
    </box>
  );
}
