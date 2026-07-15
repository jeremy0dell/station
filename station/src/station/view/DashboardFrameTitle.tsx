import { TextAttributes } from "@opentui/core";
import { Fragment, useState } from "react";
import { useStore } from "zustand/react";
import type { StoreApi } from "zustand/vanilla";
import stringWidth from "string-width";
import {
  headerStripLayout,
  observerHeaderStatusForConnection,
  selectFleetSummary,
  type TuiStore,
} from "@station/dashboard-core";
import { resolveTopRowWidgets } from "@station/dashboard-core/widgets/snapshotWidgets";
import type { TopRowWidgetView } from "@station/dashboard-core/widgets/types";
import { STATION_COLORS } from "./theme.js";
import { stationMouseProps, useStationMouse } from "./stationMouseContext.js";

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
  const dispatch = useStationMouse();
  const [hover, setHover] = useState(false);
  const snapshot = useStore(store, (state) => state.snapshot);
  const observerConnectionStatus = useStore(store, (state) => state.observerConnectionStatus);

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
  const strip = headerStripLayout({
    widgets: resolveTopRowWidgets(topRowWidgets, snapshot),
    ...(status === undefined ? {} : { status }),
    maxWidth: Math.max(0, stripBudget),
  });
  const right = strip.text.length > 0 ? ` ${strip.text}${affordance}` : affordance;
  const rightLeft = frame.left + frame.width - EDGE - stringWidth(right);

  return (
    <>
      <text
        position="absolute"
        left={frame.left + EDGE}
        top={frame.top}
        zIndex={zIndex}
        bg={STATION_COLORS.background}
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
        {strip.text.length > 0 ? (
          <text fg={STATION_COLORS.gray} bg={STATION_COLORS.background}>
            {" "}
            {strip.statusText}
            {strip.statusText.length > 0 && strip.widgets.length > 0 ? " · " : null}
            {strip.widgets.map((widget, index) => (
              <Fragment key={`${index}:${widget.text}`}>
                {index > 0 ? " · " : null}
                {widget.text}
                {widget.attribution === undefined ? null : (
                  <>
                    {" "}
                    <a href={widget.attribution.url} attributes={TextAttributes.UNDERLINE}>
                      {widget.attribution.label}
                    </a>
                  </>
                )}
              </Fragment>
            ))}
          </text>
        ) : null}
        <text
          fg={hover ? STATION_COLORS.cyan : STATION_COLORS.gray}
          bg={STATION_COLORS.background}
          {...stationMouseProps(dispatch, { kind: "widgetSettingsOpen" })}
          onMouseOver={() => setHover(true)}
          onMouseOut={() => setHover(false)}
        >
          {affordance}
        </text>
      </box>
    </>
  );
}
