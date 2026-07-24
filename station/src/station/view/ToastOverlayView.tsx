// Render layer: a bottom-anchored notice that grows upward for actionable errors.
// Only the header dismiss control routes dismissal; body text stays selectable.
import { TextAttributes } from "@opentui/core";
import {
  toastBorderColor,
  toastDetail,
  toastOverlayLayout,
  toastTitle,
  type TuiToastEntry,
} from "@station/dashboard-core";
import { STATION_COLORS, toastBorderColorHex } from "./theme.js";
import {
  useStationHoverState,
  useStationMouse,
  stationMouseProps,
} from "./stationMouseContext.js";

export type ToastOverlayViewProps = {
  columns: number;
  rows: number;
  toast: TuiToastEntry | undefined;
  promptRows: number;
  hiddenByScreen: boolean;
};

export function ToastOverlayView({
  columns,
  rows,
  toast,
  promptRows,
  hiddenByScreen,
}: ToastOverlayViewProps) {
  if (hiddenByScreen || toast === undefined) {
    return null;
  }

  const detail = toastDetail(toast);
  const layout = toastOverlayLayout({
    columns,
    rows,
    promptRows,
  });
  if (layout === undefined) {
    return null;
  }

  return (
    <box
      position="absolute"
      left={layout.left}
      bottom={layout.bottom}
      width={layout.width}
      maxHeight={layout.maxHeight}
      zIndex={20}
      border
      overflow="hidden"
      borderColor={toastBorderColorHex(toastBorderColor(toast))}
      backgroundColor={STATION_COLORS.background}
      flexDirection="column"
    >
      <box width="100%" flexDirection="column" paddingLeft={1} paddingRight={1}>
        <box width="100%" flexDirection="row">
          <text
            flexGrow={1}
            flexShrink={1}
            fg={STATION_COLORS.foreground}
            attributes={TextAttributes.BOLD}
            wrapMode="word"
            selectable
          >
            {toastTitle(toast)}
          </text>
          <ToastDismissControl />
        </box>
        <text fg={STATION_COLORS.foreground} wrapMode="word" selectable>
          {toast.toast.message}
        </text>
        {detail === undefined ? null : (
          <text fg={STATION_COLORS.gray} wrapMode="word" selectable>
            {detail}
          </text>
        )}
      </box>
    </box>
  );
}

function ToastDismissControl() {
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  return (
    <text
      flexShrink={0}
      fg={hover ? STATION_COLORS.background : STATION_COLORS.gray}
      {...(hover ? { bg: STATION_COLORS.red } : {})}
      selectable={false}
      {...stationMouseProps(dispatch, { kind: "toast" })}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      [ dismiss ]
    </text>
  );
}
