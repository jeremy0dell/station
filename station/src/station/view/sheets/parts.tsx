// OpenTUI translation of apps/tui's bottom-sheet line primitives
// (AddProjectBottomSheet/parts.tsx + the per-sheet helpers): width-fitted
// single-line rows. Ink's dimColor becomes the DIM attribute; named colors
// come from the theme.
import { TextAttributes } from "@opentui/core";
import { isValidElement, type ReactNode } from "react";
import { Throbber } from "../Throbber.js";
import { STATION_COLORS } from "../theme.js";

export function fit(value: string, width: number): string {
  return value.padEnd(width).slice(0, width);
}

export function spaces(width: number): string {
  return " ".repeat(Math.max(0, width));
}

export function SheetLabelValue({
  width,
  label,
  labelWidth = 15,
  value,
  valueColor,
}: {
  width: number;
  label: string;
  labelWidth?: number;
  value: string | ReactNode;
  valueColor?: string;
}) {
  const labelText = ` ${label.padEnd(labelWidth)} `;
  if (isValidElement(value)) {
    return (
      <text fg={STATION_COLORS.foreground}>
        <span attributes={TextAttributes.DIM}>{labelText}</span>
        {value}
      </text>
    );
  }
  return (
    <text fg={STATION_COLORS.foreground}>
      <span attributes={TextAttributes.DIM}>{labelText}</span>
      <span {...(valueColor === undefined ? {} : { fg: valueColor })}>
        {fit(String(value), Math.max(1, width - labelText.length))}
      </span>
    </text>
  );
}

export function SheetLine({ width, children }: { width: number; children: string | ReactNode }) {
  if (isValidElement(children)) {
    return <text fg={STATION_COLORS.foreground}>{children}</text>;
  }
  return <text fg={STATION_COLORS.foreground}>{fit(String(children), width)}</text>;
}

export function SheetFill({ count, width }: { count: number; width: number }) {
  const lines: ReactNode[] = [];
  for (let line = 0; line < count; line += 1) {
    lines.push(
      <SheetLine key={`blank-line-${line}`} width={width}>
        {" "}
      </SheetLine>,
    );
  }
  return <>{lines}</>;
}

export function SheetFooter({ width, children }: { width: number; children: string }) {
  return (
    <text fg={STATION_COLORS.foreground} attributes={TextAttributes.DIM}>
      {fit(` ${children}`, width)}
    </text>
  );
}

export function SheetProgressFooter({ width, children }: { width: number; children: string }) {
  const throbberWidth = 3;
  const labelText = ` ${children}`.slice(0, Math.max(0, width - throbberWidth));
  const fillWidth = Math.max(0, width - labelText.length - throbberWidth);
  return (
    <text fg={STATION_COLORS.foreground}>
      <span attributes={TextAttributes.DIM}>{labelText}</span>
      <Throbber variant="dots" />
      {fillWidth > 0 ? <span attributes={TextAttributes.DIM}>{spaces(fillWidth)}</span> : null}
    </text>
  );
}

export type SheetMessageTone = "normal" | "muted" | "accent" | "success" | "danger" | "warning";

const TONE_COLORS: Record<SheetMessageTone, string | undefined> = {
  normal: undefined,
  muted: undefined, // rendered DIM instead
  accent: STATION_COLORS.cyan,
  success: STATION_COLORS.green,
  danger: STATION_COLORS.red,
  warning: STATION_COLORS.yellow,
};

export function SheetMessageLine({
  width,
  tone = "normal",
  children,
}: {
  width: number;
  tone?: SheetMessageTone;
  children: string;
}) {
  const text = fit(` ${children}`, width);
  const color = TONE_COLORS[tone];
  return (
    <text
      fg={color ?? STATION_COLORS.foreground}
      attributes={tone === "muted" ? TextAttributes.DIM : TextAttributes.NONE}
    >
      {text}
    </text>
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
  const labelText = ` ${label.padEnd(7)} `;
  return (
    <text fg={STATION_COLORS.foreground}>
      <span attributes={TextAttributes.DIM}>{labelText}</span>
      {fit(value, Math.max(1, width - labelText.length))}
    </text>
  );
}

export function SheetSectionLine({ width, children }: { width: number; children: string }) {
  return (
    <SheetMessageLine width={width} tone="accent">
      {children}
    </SheetMessageLine>
  );
}

/** Index-selected picker line (the add-project flow's cursor-driven lists). */
export function SheetPickerLine({
  width,
  selected,
  label,
  detail,
}: {
  width: number;
  selected: boolean;
  label: string;
  detail: string;
}) {
  const prefix = selected ? " > " : "   ";
  const detailText = detail.length === 0 ? "" : ` ${detail}`;
  const maxDetailWidth = Math.max(0, width - prefix.length - 10);
  const visibleDetail = fit(detailText, Math.min(detailText.length, maxDetailWidth));
  const labelWidth = Math.max(1, width - prefix.length - visibleDetail.length);
  const color = selected ? STATION_COLORS.cyan : STATION_COLORS.foreground;
  return (
    <text fg={STATION_COLORS.foreground}>
      <span fg={color}>{prefix}</span>
      <span fg={color}>{fit(label, labelWidth)}</span>
      {visibleDetail.length > 0 ? (
        <span attributes={TextAttributes.DIM}>{visibleDetail}</span>
      ) : null}
    </text>
  );
}
