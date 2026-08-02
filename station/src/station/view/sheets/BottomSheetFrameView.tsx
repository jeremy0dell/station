// Render layer: absolute-positioned sheet frame (sized by shared layout, no
// blank-background hack). Absorbs mouse input as the sheet backdrop
// ({ kind: "sheetBackdrop" }) so clicks don't fall through to the dashboard.
import { TextAttributes } from "@opentui/core";
import type { ReactNode } from "react";
import {
  bottomSheetContentWidth,
  bottomSheetFrameLayout,
} from "@station/dashboard-core";
import {
  stationRgbValue,
  toOpenTuiOpaqueColor,
  useStationTheme,
} from "../../../theme/index.js";
import { useStationMouse, stationMouseProps } from "../stationMouseContext.js";
import { SheetText } from "./parts.js";

export type BottomSheetFrameViewProps = {
  columns: number;
  rows: number;
  title: string;
  contentRows: number;
  minHeight?: number;
  width?: number;
  children: ReactNode;
};

export function BottomSheetFrameView({
  columns,
  rows,
  title,
  contentRows,
  minHeight = 7,
  width,
  children,
}: BottomSheetFrameViewProps) {
  const theme = useStationTheme();
  const surfaceBackground = toOpenTuiOpaqueColor(theme.surfaces.sheet);
  const dispatch = useStationMouse();
  const layout = bottomSheetFrameLayout({
    columns,
    rows,
    contentRows,
    minHeight,
    ...(width === undefined ? {} : { width }),
  });
  return (
    <box
      position="absolute"
      left={layout.left}
      top={layout.top}
      width={layout.width}
      height={layout.height}
      zIndex={10}
      border
      borderColor={stationRgbValue(theme.interaction.hairline)}
      backgroundColor={surfaceBackground}
      flexDirection="column"
      {...stationMouseProps(dispatch, { kind: "sheetBackdrop" })}
    >
      <SheetText fg={stationRgbValue(theme.text.primary)} attributes={TextAttributes.BOLD}>{` ${title}`}</SheetText>
      <box
        flexDirection="column"
        width={bottomSheetContentWidth(layout.width)}
        height={Math.max(0, layout.height - 3)}
      >
        {children}
      </box>
    </box>
  );
}
