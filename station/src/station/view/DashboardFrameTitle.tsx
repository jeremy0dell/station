import { TextAttributes } from "@opentui/core";
import { useStore } from "zustand/react";
import type { DashboardStateSource } from "@station/dashboard-core/runtime";
import { headerStrip, observerHeaderStatusForConnection, selectFleetSummary } from "@station/dashboard-core/selectors";
import { tuiScreenBehavior } from "@station/dashboard-core/state";
import { cellWidth } from "@station/dashboard-core/text";
import { resolveTopRowWidgets } from "@station/dashboard-core/widgets";
import type { TopRowWidgetView } from "@station/dashboard-core/widgets";
import { toOpenTuiColor, toOpenTuiOpaqueColor, useStationTheme } from "../../theme/index.js";
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
  state: DashboardStateSource;
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
  state,
  frame,
  topRowWidgets = [],
  zIndex,
}: DashboardFrameTitleProps) {
  const theme = useStationTheme();
  const surfaceBackground = toOpenTuiOpaqueColor(theme.surfaces.panel);
  const dispatch = useStationMouse();
  const [hovered, setHover] = useStationHoverState();
  const snapshot = useStore(state, (current) => current.snapshot);
  const observerConnectionStatus = useStore(
    state,
    (current) => current.observerConnectionStatus,
  );
  const screen = useStore(state, (current) => current.screen);
  const behavior = tuiScreenBehavior(screen);
  const hover = hovered && behavior.dashboardHoverEnabled;

  const needsYou = snapshot === undefined ? 0 : selectFleetSummary(snapshot).needsYou;
  const subtitle =
    needsYou > 0
      ? { text: `! ${needsYou} need you`, color: toOpenTuiColor(theme.status.danger) }
      : { text: OVERVIEW_SUBTITLE, color: toOpenTuiColor(theme.text.muted) };
  const title = ` ${PRODUCT_LABEL} ${subtitle.text} `;

  const status = observerHeaderStatusForConnection(observerConnectionStatus, snapshot !== undefined);
  const affordance = ` ${WIDGET_SETTINGS_AFFORDANCE} `;
  const stripBudget =
    frame.width - 2 * EDGE - cellWidth(title) - cellWidth(affordance) - 2;
  const strip = headerStrip({
    widgets: resolveTopRowWidgets(topRowWidgets, snapshot),
    ...(status === undefined ? {} : { status }),
    maxWidth: Math.max(0, stripBudget),
  });
  const right = strip.length > 0 ? ` ${strip}${affordance}` : affordance;
  const rightLeft = frame.left + frame.width - EDGE - cellWidth(right);

  return (
    <>
      <text
        position="absolute"
        left={frame.left + EDGE}
        top={frame.top}
        zIndex={zIndex}
        bg={surfaceBackground}
      >
        <span fg={toOpenTuiColor(theme.text.primary)} attributes={TextAttributes.BOLD}>
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
          <text fg={toOpenTuiColor(theme.text.muted)} bg={surfaceBackground}>{` ${strip}`}</text>
        ) : null}
        <text
          fg={toOpenTuiColor(hover ? theme.action.primary : theme.text.muted)}
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
