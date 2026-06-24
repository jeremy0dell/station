// Render layer: absolute-positioned sheet frame (sized by shared layout, no
// blank-background hack). Absorbs mouse input as the sheet backdrop
// ({ kind: "sheetBackdrop" }) so clicks don't fall through to the dashboard.
import { TextAttributes } from "@opentui/core";
import type { ReactNode } from "react";
import {
  bottomSheetContentWidth,
  bottomSheetFrameLayout,
} from "@station/dashboard-core";
import { STATION_COLORS } from "../theme.js";
import { useStationMouse, stationMouseProps } from "../stationMouseContext.js";

export type BottomSheetFrameViewProps = {
  columns: number;
  rows: number;
  title: string;
  contentRows: number;
  minHeight?: number;
  children: ReactNode;
};

export function BottomSheetFrameView({
  columns,
  rows,
  title,
  contentRows,
  minHeight = 7,
  children,
}: BottomSheetFrameViewProps) {
  const dispatch = useStationMouse();
  const layout = bottomSheetFrameLayout({ columns, rows, contentRows, minHeight });
  return (
    <box
      position="absolute"
      left={layout.left}
      top={layout.top}
      width={layout.width}
      height={layout.height}
      zIndex={10}
      border
      borderColor={STATION_COLORS.gray}
      backgroundColor={STATION_COLORS.background}
      flexDirection="column"
      {...stationMouseProps(dispatch, { kind: "sheetBackdrop" })}
    >
      <text fg={STATION_COLORS.foreground} attributes={TextAttributes.BOLD}>{` ${title}`}</text>
      <box
        flexDirection="column"
        width={bottomSheetContentWidth(columns)}
        height={Math.max(0, layout.height - 3)}
      >
        {children}
      </box>
    </box>
  );
}
