// Render layer: a bottom-anchored notice that grows upward for actionable errors.
// Only the header dismiss control routes dismissal; body text stays selectable.
import { MouseButton, TextAttributes, type BorderSides } from "@opentui/core";
import {
  toastBorderColor,
  toastCopyText,
  toastDetail,
  toastTitle,
 } from "@station/dashboard-core/selectors";
import type { TuiToastEntry } from "@station/dashboard-core/state";
import { cellWidth, truncateCells } from "@station/dashboard-core/text";
import { useEffect, useState } from "react";
import {
  toastBorderThemeColor,
  toOpenTuiColor,
  toOpenTuiOpaqueColor,
  useStationTheme,
  type StationTheme,
} from "../../theme/index.js";
import { SemanticScrollRegion } from "./layout/SemanticScrollViewport.js";
import { semanticItemRenderableId } from "./layout/scrollViewport.js";
import { useStationHoverState, useStationMouse, stationMouseProps } from "./stationMouseContext.js";

export type ToastOverlayViewProps = {
  columns: number;
  rows: number;
  toast: TuiToastEntry | undefined;
  hiddenByScreen: boolean;
  onCopyNotice: (text: string) => void;
};

export function ToastOverlayView({
  columns,
  rows,
  toast,
  hiddenByScreen,
  onCopyNotice,
}: ToastOverlayViewProps) {
  const theme = useStationTheme();
  const surfaceBackground = toOpenTuiOpaqueColor(theme.surfaces.toast);
  if (hiddenByScreen || toast === undefined) {
    return null;
  }

  const detail = toastDetail(toast);
  const geometry = toastSurfaceGeometry(columns);
  const header = toastHeaderModel(geometry.width, toastTitle(toast));
  const bodyIds = detail === undefined ? ["toast:message"] : ["toast:message", "toast:detail"];
  // Below eight terminal rows, dashboard controls can leave too little room for two horizontal edges.
  const border: true | BorderSides[] =
    Math.max(1, Math.floor(rows)) >= 8 ? true : ["left", "right"];

  // OpenTUI adds every box to its hit grid, so the flex anchor itself must have no pointer area.
  return (
    <box
      position="absolute"
      id="station-toast-anchor"
      top={0}
      right={geometry.inset}
      bottom={0}
      width={0}
      maxHeight="100%"
      flexDirection="column"
      alignItems="flex-end"
      justifyContent="flex-end"
      overflow="visible"
      zIndex={20}
    >
      {/* Keep the bordered surface unclipped so OpenTUI does not drop its final content hit row. */}
      <box
        id="station-toast-surface"
        width={geometry.width}
        maxHeight="100%"
        flexShrink={1}
        border={border}
        overflow="visible"
        borderColor={toOpenTuiColor(toastBorderThemeColor(theme, toastBorderColor(toast)))}
        backgroundColor={surfaceBackground}
        flexDirection="column"
      >
        <box
          width="100%"
          flexDirection="row"
          paddingLeft={1}
          paddingRight={1}
          flexShrink={0}
        >
          <text
            width={header.titleWidth}
            flexShrink={0}
            fg={toOpenTuiColor(theme.text.primary)}
            attributes={TextAttributes.BOLD}
            wrapMode="none"
            selectable
          >
            {header.title}
          </text>
          <ToastCopyControl
            key={toast.id}
            label={header.copyLabel}
            copiedLabel={header.copiedLabel}
            text={toastCopyText(toast)}
            onCopy={onCopyNotice}
          />
          <ToastDismissControl label={header.dismissLabel} />
        </box>
        <box
          id="station-toast-body-clip"
          width="100%"
          minHeight={0}
          flexShrink={1}
          flexDirection="column"
          overflow="hidden"
        >
          <SemanticScrollRegion itemIds={bodyIds} fill={false} viewportId="station-toast-body">
            <box
              id={semanticItemRenderableId("toast:message")}
              width="100%"
              flexDirection="column"
              paddingLeft={1}
              paddingRight={1}
            >
              <text fg={toOpenTuiColor(theme.text.primary)} wrapMode="word" selectable>
                {toast.toast.message}
              </text>
            </box>
            {detail === undefined ? null : (
              <box
                id={semanticItemRenderableId("toast:detail")}
                width="100%"
                flexDirection="column"
                paddingLeft={1}
                paddingRight={1}
              >
                <text fg={toOpenTuiColor(theme.text.muted)} wrapMode="word" selectable>
                  {detail}
                </text>
              </box>
            )}
          </SemanticScrollRegion>
        </box>
      </box>
    </box>
  );
}

function toastSurfaceGeometry(columns: number): { width: number; inset: number } {
  const available = Math.max(1, Math.floor(columns));
  const inset = available >= 5 ? 2 : 0;
  return {
    width: Math.max(1, Math.min(72, available - inset * 2)),
    inset,
  };
}

type ToastHeaderModel = {
  title: string;
  titleWidth: number;
  copyLabel: string;
  copiedLabel: string;
  dismissLabel: string;
};

function toastHeaderModel(width: number, title: string): ToastHeaderModel {
  const innerWidth = Math.max(1, width - 4);
  const full = { copyLabel: "[ copy ]", copiedLabel: "[ copied ]", dismissLabel: "[ dismiss ]" };
  const compact = { copyLabel: "[copy]", copiedLabel: "[ok]", dismissLabel: "[x]" };
  const controls =
    cellWidth(title) + cellWidth(full.copiedLabel) + cellWidth(full.dismissLabel) <= innerWidth
      ? full
      : compact;
  const copyControlWidth = Math.max(
    cellWidth(controls.copyLabel),
    cellWidth(controls.copiedLabel),
  );
  const titleWidth = Math.max(
    1,
    innerWidth - copyControlWidth - cellWidth(controls.dismissLabel),
  );
  return {
    title: truncateCells(title, titleWidth),
    titleWidth,
    ...controls,
  };
}

function ToastCopyControl({
  label,
  copiedLabel,
  text,
  onCopy,
}: {
  label: string;
  copiedLabel: string;
  text: string;
  onCopy: (text: string) => void;
}) {
  const theme = useStationTheme();
  const [hover, setHover] = useStationHoverState();
  const [copyFeedbackToken, setCopyFeedbackToken] = useState(0);
  const copied = copyFeedbackToken > 0;
  const style = toastCopyControlStyle(theme, copied, hover);
  useEffect(() => {
    if (copyFeedbackToken === 0) {
      return;
    }
    const timer = setTimeout(() => setCopyFeedbackToken(0), 1_500);
    return () => clearTimeout(timer);
  }, [copyFeedbackToken]);

  return (
    <text
      id="station-toast-copy"
      flexShrink={0}
      {...style}
      selectable={false}
      onMouseDown={(event) => {
        event.stopPropagation();
        if (event.button !== MouseButton.LEFT) {
          return;
        }
        onCopy(text);
        setCopyFeedbackToken((token) => token + 1);
      }}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      {copied ? copiedLabel : label}
    </text>
  );
}

function toastCopyControlStyle(theme: StationTheme, copied: boolean, hover: boolean) {
  if (copied) {
    return { fg: toOpenTuiColor(theme.status.success) };
  }
  if (hover) {
    return {
      fg: toOpenTuiColor(theme.text.inverse),
      bg: toOpenTuiColor(theme.action.primary),
    };
  }
  return { fg: toOpenTuiColor(theme.action.primary) };
}

function ToastDismissControl({ label }: { label: string }) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  return (
    <text
      id="station-toast-dismiss"
      flexShrink={0}
      fg={toOpenTuiColor(hover ? theme.text.inverse : theme.text.muted)}
      {...(hover ? { bg: toOpenTuiColor(theme.status.danger) } : {})}
      selectable={false}
      {...stationMouseProps(dispatch, { kind: "toast" })}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      {label}
    </text>
  );
}
