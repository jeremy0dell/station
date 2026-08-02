import { TextAttributes } from "@opentui/core";
import { useStore } from "zustand/react";
import type { StoreApi } from "zustand/vanilla";
import stringWidth from "string-width";
import {
  headerStrip,
  observerHeaderStatusForConnection,
  selectFleetSummary,
  tuiScreenBehavior,
  type TuiStore,
} from "@station/dashboard-core";
import { resolveTopRowWidgets } from "@station/dashboard-core/widgets/snapshotWidgets";
import type { TopRowWidgetView } from "@station/dashboard-core/widgets/types";
import { useDashboardSurfaces } from "./dashboardSurfaceContext.js";
import { STATION_COLORS } from "./theme.js";
import {
  stationMouseProps,
  useStationHoverState,
  useStationMouse,
} from "./stationMouseContext.js";

const PRODUCT_LABEL = "station";
const OVERVIEW_SUBTITLE = "· overview";
const WIDGET_SETTINGS_AFFORDANCE = "[+]";
// One corner + one border dash on each flank of an embedded run of text.
const EDGE = 2;

export type DashboardFrameTitleProps = {
  store: StoreApi<TuiStore>;
  /** The popup box the title row overlays; texts paint over its top border. */
  frame: { left: number; top: number; width: number };
  topRowWidgets?: readonly TopRowWidgetView[];
  zIndex: number;
};

/**
 * The frame's top border carries the identity and the widget strip, mock-style:
 * `╭─ station · overview ────── 5:07 PM · NYC · 18°⛅ [+] ─╮`. When sessions
 * need the user, the subtitle swaps to a red `! N need you` flag.
 */
export function DashboardFrameTitle({
  store,
  frame,
  topRowWidgets = [],
  zIndex,
}: DashboardFrameTitleProps) {
  const { surfaceBackground } = useDashboardSurfaces();
  const dispatch = useStationMouse();
  const [hovered, setHover] = useStationHoverState();
  const snapshot = useStore(store, (state) => state.snapshot);
  const observerConnectionStatus = useStore(store, (state) => state.observerConnectionStatus);
  const screen = useStore(store, (state) => state.screen);
  const behavior = tuiScreenBehavior(screen);
  const hover = hovered && behavior.clickAway === undefined;

  const needsYou = snapshot === undefined ? 0 : selectFleetSummary(snapshot).needsYou;
  const subtitle =
    needsYou > 0
      ? { text: `! ${needsYou} need you`, color: STATION_COLORS.red }
      : { text: OVERVIEW_SUBTITLE, color: STATION_COLORS.gray };
  const title = ` ${PRODUCT_LABEL} ${subtitle.text} `;

  const status = observerHeaderStatusForConnection(observerConnectionStatus, snapshot !== undefined);
  const affordance = ` ${WIDGET_SETTINGS_AFFORDANCE} `;
  const stripBudget =
    frame.width - 2 * EDGE - stringWidth(title) - stringWidth(affordance) - 2;
  const strip = headerStrip({
    widgets: resolveTopRowWidgets(topRowWidgets, snapshot),
    ...(status === undefined ? {} : { status }),
    maxWidth: Math.max(0, stripBudget),
  });
  const right = strip.length > 0 ? ` ${strip}${affordance}` : affordance;
  const rightLeft = frame.left + frame.width - EDGE - stringWidth(right);

  return (
    <>
      <text
        position="absolute"
        left={frame.left + EDGE}
        top={frame.top}
        zIndex={zIndex}
        bg={surfaceBackground}
      >
        <span fg={STATION_COLORS.foreground} attributes={TextAttributes.BOLD}>
          {` ${PRODUCT_LABEL} `}
        </span>
        <span fg={subtitle.color}>{`${subtitle.text} `}</span>
      </text>
      <box
        position="absolute"
        left={rightLeft}
        top={frame.top}
        zIndex={zIndex}
        flexDirection="row"
      >
        {strip.length > 0 ? (
          <text fg={STATION_COLORS.gray} bg={surfaceBackground}>{` ${strip}`}</text>
        ) : null}
        <text
          fg={hover ? STATION_COLORS.cyan : STATION_COLORS.gray}
          bg={surfaceBackground}
          {...stationMouseProps(dispatch, { kind: "widgetSettingsOpen" })}
          onMouseOver={() => setHover(true)}
          onMouseOut={() => setHover(false)}
        >
          {affordance}
        </text>
      </box>
      {behavior.clickAway !== undefined ? (
        <box
          position="absolute"
          left={frame.left}
          top={frame.top}
          width={frame.width}
          height={1}
          zIndex={zIndex + 1}
          {...stationMouseProps(dispatch, { kind: "screenBackdrop" })}
        />
      ) : null}
    </>
  );
}
