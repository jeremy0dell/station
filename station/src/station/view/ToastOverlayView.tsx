// Render layer: absolute-positioned toast box (bottom-right, sized by shared
// layout). Toast copy and color come from the shared content module. Click
// dismisses (routes { kind: "toast" } through the station mouse context).
import { TextAttributes } from "@opentui/core";
import {
  toastBorderColor,
  type ToastBorderColorName,
  toastDetail,
  toastOverlayLayout,
  toastTextWidth,
  toastTitle,
  truncateCells,
  type TuiToastEntry,
} from "@station/dashboard-core";
import { STATION_COLORS } from "./theme.js";
import { useStationMouse, stationMouseProps } from "./stationMouseContext.js";

export type ToastOverlayViewProps = {
  columns: number;
  rows: number;
  toast: TuiToastEntry | undefined;
  promptRows: number;
  hiddenByModal: boolean;
};

export function ToastOverlayView({
  columns,
  rows,
  toast,
  promptRows,
  hiddenByModal,
}: ToastOverlayViewProps) {
  const dispatch = useStationMouse();
  if (hiddenByModal || toast === undefined) {
    return null;
  }

  const detail = toastDetail(toast);
  const layout = toastOverlayLayout({
    columns,
    rows,
    promptRows,
    contentRows: detail === undefined ? 2 : 3,
  });
  if (layout === undefined) {
    return null;
  }
  const textWidth = toastTextWidth(layout.contentWidth);

  return (
    <box
      position="absolute"
      left={layout.left}
      top={layout.top}
      width={layout.width}
      height={layout.height}
      zIndex={20}
      border
      borderColor={borderColorHex(toastBorderColor(toast))}
      backgroundColor={STATION_COLORS.background}
      flexDirection="column"
      {...stationMouseProps(dispatch, { kind: "toast" })}
    >
      <box flexDirection="column" paddingLeft={1} paddingRight={1}>
        <text fg={STATION_COLORS.foreground} attributes={TextAttributes.BOLD}>
          {truncateCells(toastTitle(toast), textWidth)}
        </text>
        <text fg={STATION_COLORS.foreground}>{truncateCells(toast.toast.message, textWidth)}</text>
        {detail === undefined ? null : (
          <text fg={STATION_COLORS.gray}>{truncateCells(detail, textWidth)}</text>
        )}
      </box>
    </box>
  );
}

function borderColorHex(name: ToastBorderColorName): string {
  if (name === "red") {
    return STATION_COLORS.red;
  }
  if (name === "gray") {
    return STATION_COLORS.gray;
  }
  return STATION_COLORS.green;
}
