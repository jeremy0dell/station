// Render layer: a bottom-anchored notice that grows upward for actionable errors.
// Only the header dismiss control routes dismissal; body text stays selectable.
import { MouseButton, TextAttributes } from "@opentui/core";
import {
  toastBorderColor,
  toastCopyText,
  toastDetail,
  toastTitle,
 } from "@station/dashboard-core/selectors";
import type { TuiToastEntry } from "@station/dashboard-core/state";
import { useEffect, useState } from "react";
import {
  toastBorderThemeColor,
  toOpenTuiColor,
  toOpenTuiOpaqueColor,
  useStationTheme,
  type StationTheme,
} from "../../theme/index.js";
import { useStationHoverState, useStationMouse, stationMouseProps } from "./stationMouseContext.js";

export type ToastOverlayViewProps = {
  columns: number;
  toast: TuiToastEntry | undefined;
  hiddenByScreen: boolean;
  onCopyNotice: (text: string) => void;
};

export function ToastOverlayView({
  columns,
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
  // This is local breathing room inside the notice region; dashboard chrome is outside the parent.
  const visualBottomInset = 1;

  return (
    <box
      position="absolute"
      id="station-toast-surface"
      right={geometry.inset}
      bottom={visualBottomInset}
      width={geometry.width}
      maxHeight="100%"
      zIndex={20}
      border
      overflow="hidden"
      borderColor={toOpenTuiColor(toastBorderThemeColor(theme, toastBorderColor(toast)))}
      backgroundColor={surfaceBackground}
      flexDirection="column"
    >
      <box width="100%" flexDirection="column" paddingLeft={1} paddingRight={1}>
        <box width="100%" flexDirection="row">
          <text
            flexGrow={1}
            flexShrink={1}
            fg={toOpenTuiColor(theme.text.primary)}
            attributes={TextAttributes.BOLD}
            wrapMode="word"
            selectable
          >
            {toastTitle(toast)}
          </text>
          <ToastCopyControl key={toast.id} text={toastCopyText(toast)} onCopy={onCopyNotice} />
          <ToastDismissControl />
        </box>
        <text fg={toOpenTuiColor(theme.text.primary)} wrapMode="word" selectable>
          {toast.toast.message}
        </text>
        {detail === undefined ? null : (
          <text fg={toOpenTuiColor(theme.text.muted)} wrapMode="word" selectable>
            {detail}
          </text>
        )}
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

function ToastCopyControl({ text, onCopy }: { text: string; onCopy: (text: string) => void }) {
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
      {copied ? "[ copied ]" : "[ copy ]"}
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

function ToastDismissControl() {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  return (
    <text
      marginLeft={1}
      flexShrink={0}
      fg={toOpenTuiColor(hover ? theme.text.inverse : theme.text.muted)}
      {...(hover ? { bg: toOpenTuiColor(theme.status.danger) } : {})}
      selectable={false}
      {...stationMouseProps(dispatch, { kind: "toast" })}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      [ dismiss ]
    </text>
  );
}
