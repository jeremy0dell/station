import { useTerminalDimensions } from "@opentui/react";
import { useSyncExternalStore } from "react";
import type { StoreApi } from "zustand/vanilla";
import type { TuiStore } from "@station/dashboard-core";
import { buildContextMenuItems } from "./items.js";
import { measureContextMenu, placeContextMenu } from "./placement.js";
import { ContextMenuLayer } from "./ContextMenuLayer.js";
import type { StationMouseEvent } from "../input/mouse.js";
import type { MouseTargetRef } from "../input/router.js";
import type { StationStore } from "../state/store.js";
import type { StationState } from "../state/types.js";
import type { Automation } from "../config/stationConfig.js";

export type ContextMenuRootProps = {
  store: StationStore;
  stationViewStore: StoreApi<TuiStore>;
  dispatchMouse: (target: MouseTargetRef, event: StationMouseEvent) => boolean;
  automations: readonly Automation[];
};

export function ContextMenuRoot({
  store,
  stationViewStore,
  dispatchMouse,
  automations,
}: ContextMenuRootProps) {
  void stationViewStore;
  const state = useSyncExternalStore<StationState>(
    store.subscribe,
    store.getState,
    store.getState,
  );
  const stationState = useSyncExternalStore<TuiStore>(
    stationViewStore.subscribe,
    stationViewStore.getState,
    stationViewStore.getState,
  );
  const menu = state.input.contextMenu;
  const { width, height } = useTerminalDimensions();

  if (menu === null) {
    return null;
  }

  const items = buildContextMenuItems(menu.target, state, stationState, automations);
  const placement = placeContextMenu(menu.anchor, measureContextMenu(items), { width, height });

  return (
    <ContextMenuLayer
      terminalWidth={width}
      terminalHeight={height}
      placement={placement}
      items={items}
      activeIndex={menu.activeIndex}
      dispatchMouse={dispatchMouse}
    />
  );
}
