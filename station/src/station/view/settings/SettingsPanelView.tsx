import { TextAttributes } from "@opentui/core";
import type { SettingsPanelFocus } from "@station/dashboard-core/state";
import type { ReactNode } from "react";
import { toOpenTuiColor, toOpenTuiOpaqueColor, useStationTheme } from "../../../theme/index.js";
import type { StationMouseTarget } from "../../input/stationMouse.js";
import { SemanticScrollRegion } from "../layout/SemanticScrollViewport.js";
import { semanticItemRenderableId } from "../layout/scrollViewport.js";
import { settingsPanelFrame } from "../layout/settingsPanelFrame.js";
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
  focused: boolean;
};

export type SettingsPanelViewProps = {
  columns: number;
  rows: number;
  focus: SettingsPanelFocus;
  title: string;
  compactDetailTitle: string;
  footer: string;
  listHeader: string;
  items: readonly SettingsPanelItemView[];
  renderDetail: (layout: SettingsPanelDetailLayout) => ReactNode;
};

export function SettingsPanelView({
  columns,
  rows,
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
  const frame = settingsPanelFrame(columns, rows);
  const singlePane = frame.paneMode === "single";
  const showList = !singlePane || focus === "list";
  const showDetail = !singlePane || focus === "detail";
  const listWidth = singlePane ? frame.innerWidth : frame.listWidth;
  const detailWidth = singlePane ? frame.innerWidth : frame.detailWidth;
  const visibleTitle = singlePane && showDetail ? compactDetailTitle : title;
  const listItemIds = items.map((item) => settingsListItemId(item.id));
  const activeListItem = items.find((item) => item.active);
  const followedListItemId =
    focus === "list" && activeListItem !== undefined
      ? settingsListItemId(activeListItem.id)
      : undefined;

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
        width={frame.width}
        height={frame.height}
        border
        borderColor={toOpenTuiColor(theme.interaction.hairline)}
        backgroundColor={toOpenTuiOpaqueColor(theme.surfaces.settings)}
        flexDirection="column"
      >
        <text
          flexShrink={0}
          fg={toOpenTuiColor(theme.text.primary)}
          attributes={TextAttributes.BOLD}
        >
          {fit(` ${visibleTitle}`, frame.innerWidth)}
        </text>
        <box
          flexDirection="row"
          width={frame.innerWidth}
          flexGrow={1}
          flexShrink={1}
          flexBasis={0}
          minHeight={0}
        >
          {showList ? (
            <box flexDirection="column" width={listWidth} flexShrink={1} minHeight={0}>
              <SemanticScrollRegion
                itemIds={listItemIds}
                followedItemId={followedListItemId}
                fill
              >
                <SettingsPanelList
                  header={listHeader}
                  focused={focus === "list"}
                  items={items}
                  width={listWidth}
                />
              </SemanticScrollRegion>
            </box>
          ) : null}
          {!singlePane ? <SettingsPanelDivider /> : null}
          {showDetail ? (
            <box flexDirection="column" width={detailWidth} flexShrink={1} minHeight={0}>
              {renderDetail({ width: detailWidth, focused: focus === "detail" })}
            </box>
          ) : null}
        </box>
        <text
          flexShrink={0}
          fg={toOpenTuiColor(theme.text.primary)}
          attributes={TextAttributes.DIM}
        >
          {fit(` ${footer}`, frame.innerWidth)}
        </text>
      </box>
    </box>
  );
}

export function SettingsPanelDetailView({
  width,
  title,
  focused,
  danger = false,
  bodyItemIds = [],
  followedBodyItemId,
  children,
  actions,
  footer,
}: {
  width: number;
  title: string;
  focused: boolean;
  danger?: boolean;
  bodyItemIds?: readonly string[];
  followedBodyItemId?: string;
  children: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <box width={width} height="100%" flexDirection="column" minHeight={0}>
      <box flexShrink={0}>
        <SettingsPaneHeader label={title} width={width} focused={focused} danger={danger} />
      </box>
      <SemanticScrollRegion
        itemIds={bodyItemIds}
        followedItemId={followedBodyItemId}
        viewportId={`station-settings-detail:${title}`}
        fill
      >
        {children}
      </SemanticScrollRegion>
      {actions === undefined ? null : <box flexShrink={0}>{actions}</box>}
      {footer === undefined ? null : <box flexShrink={0}>{footer}</box>}
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
      id={semanticItemRenderableId(settingsListItemId(item.id))}
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

function SettingsPanelDivider() {
  const theme = useStationTheme();
  return (
    <box
      width={1}
      alignSelf="stretch"
      border={["left"]}
      borderColor={toOpenTuiColor(theme.text.muted)}
    />
  );
}

function settingsListItemId(itemId: string): string {
  return `settings-list:${itemId}`;
}
