import { TextAttributes, type ColorInput } from "@opentui/core";
import { cellWidth, clipCells } from "@station/dashboard-core/text";
import {
  toOpenTuiColor,
  useStationTheme,
  type StationTheme,
} from "../../../theme/index.js";
import { Throbber } from "../Throbber.js";
import { fit, SheetText, spaces } from "./sheetText.js";

export function SheetProgressFooter({ width, children }: { width: number; children: string }) {
  const theme = useStationTheme();
  const throbberWidth = 3;
  const labelText = clipCells(` ${children}`, Math.max(0, width - throbberWidth));
  const fillWidth = Math.max(0, width - cellWidth(labelText) - throbberWidth);
  return (
    <SheetText fg={toOpenTuiColor(theme.text.primary)}>
      <span attributes={TextAttributes.DIM}>{labelText}</span>
      <Throbber variant="dots" />
      {fillWidth > 0 ? <span attributes={TextAttributes.DIM}>{spaces(fillWidth)}</span> : null}
    </SheetText>
  );
}

export type SheetMessageTone = "normal" | "muted" | "accent" | "success" | "danger" | "warning";

function sheetMessageToneColor(
  theme: StationTheme,
  tone: SheetMessageTone,
): ColorInput | undefined {
  switch (tone) {
    case "normal":
    case "muted":
      return undefined;
    case "accent":
      return toOpenTuiColor(theme.action.primary);
    case "success":
      return toOpenTuiColor(theme.status.success);
    case "danger":
      return toOpenTuiColor(theme.status.danger);
    case "warning":
      return toOpenTuiColor(theme.status.warning);
  }
}

export function SheetMessageLine({
  width,
  tone = "normal",
  children,
}: {
  width: number;
  tone?: SheetMessageTone;
  children: string;
}) {
  const theme = useStationTheme();
  const text = fit(` ${children}`, width);
  const color = sheetMessageToneColor(theme, tone);
  return (
    <SheetText
      fg={color ?? toOpenTuiColor(theme.text.primary)}
      attributes={tone === "muted" ? TextAttributes.DIM : TextAttributes.NONE}
    >
      {text}
    </SheetText>
  );
}

export function SheetMetaLine({
  width,
  label,
  value,
}: {
  width: number;
  label: string;
  value: string;
}) {
  const theme = useStationTheme();
  const labelText = ` ${fit(label, 7)} `;
  return (
    <SheetText fg={toOpenTuiColor(theme.text.primary)}>
      <span attributes={TextAttributes.DIM}>{labelText}</span>
      {fit(value, Math.max(1, width - cellWidth(labelText)))}
    </SheetText>
  );
}

export function SheetSectionLine({ width, children }: { width: number; children: string }) {
  return (
    <box flexDirection="column" marginBottom={1}>
      <SheetMessageLine width={width} tone="accent">
        {children}
      </SheetMessageLine>
    </box>
  );
}
