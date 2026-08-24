// OpenTUI boundary: the frame anchors and constrains intrinsic sheet sections,
// then absorbs backdrop clicks so they cannot fall through to the dashboard.
import { TextAttributes } from "@opentui/core";
import type { ReactNode } from "react";
import { toOpenTuiColor, toOpenTuiOpaqueColor, useStationTheme } from "../../../theme/index.js";
import { bottomSheetFrame } from "../layout/bottomSheetFrame.js";
import { useStationMouse, stationMouseProps } from "../stationMouseContext.js";
import { SemanticScrollRegion } from "../layout/SemanticScrollViewport.js";
import { SheetText } from "./parts.js";

export type BottomSheetFrameViewProps = {
  columns: number;
  rows: number;
  title: string;
  width?: number;
  bodyHeader?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  bodyItemIds?: readonly string[];
  followedBodyItemId?: string;
  bodyPaddingTop?: number;
  bodyPaddingBottom?: number;
};

export function BottomSheetFrameView({
  columns,
  rows,
  title,
  width,
  bodyHeader,
  children,
  actions,
  footer,
  bodyItemIds = [],
  followedBodyItemId,
  bodyPaddingTop = 0,
  bodyPaddingBottom = 0,
}: BottomSheetFrameViewProps) {
  const theme = useStationTheme();
  const surfaceBackground = toOpenTuiOpaqueColor(theme.surfaces.sheet);
  const dispatch = useStationMouse();
  const frame = bottomSheetFrame(columns, rows, width);
  return (
    <box
      id="station-bottom-sheet"
      position="absolute"
      left={0}
      bottom={0}
      width={frame.width}
      height={frame.height}
      zIndex={10}
      border
      borderColor={toOpenTuiColor(theme.interaction.hairline)}
      backgroundColor={surfaceBackground}
      flexDirection="column"
      {...stationMouseProps(dispatch, { kind: "sheetBackdrop" })}
    >
      <SheetText
        flexShrink={0}
        fg={toOpenTuiColor(theme.text.primary)}
        attributes={TextAttributes.BOLD}
      >{` ${title}`}</SheetText>
      {bodyHeader === undefined ? null : <box flexShrink={0}>{bodyHeader}</box>}
      <SemanticScrollRegion
        itemIds={bodyItemIds}
        followedItemId={followedBodyItemId}
        fill
      >
        <box
          width={frame.contentWidth}
          flexDirection="column"
          paddingTop={bodyPaddingTop}
          paddingBottom={bodyPaddingBottom}
        >
          {children}
        </box>
      </SemanticScrollRegion>
      {actions === undefined ? null : <box flexShrink={0}>{actions}</box>}
      {footer === undefined ? null : <box flexShrink={0}>{footer}</box>}
    </box>
  );
}
