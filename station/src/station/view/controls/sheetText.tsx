// Compact controls intentionally remain terminal-cell leaf layouts. Their parent
// sheet boxes own intrinsic height, scrolling, clipping, padding, and framing.
import { TextAttributes } from "@opentui/core";
import type { TextProps } from "@opentui/react";
import { cellWidth, clipCells } from "@station/dashboard-core/text";
import { isValidElement, type ReactNode } from "react";
import {
  toOpenTuiColor,
  useStationTheme,
  type StationColor,
} from "../../../theme/index.js";

export function fit(value: string, width: number): string {
  const visible = clipCells(value, width);
  return `${visible}${spaces(width - cellWidth(visible))}`;
}

export function spaces(width: number): string {
  return " ".repeat(Math.max(0, width));
}

export type ResponsiveSheetText = Readonly<{
  expanded: string;
  compact: string;
}>;

const SHEET_FOOTER_PREFIX = " ";

/** Selects the expanded copy only when every cell fits the available width. */
export function responsiveSheetText(width: number, variants: ResponsiveSheetText): string {
  return cellWidth(variants.expanded) <= width ? variants.expanded : variants.compact;
}

/** Accounts for the footer's leading inset when selecting responsive copy. */
export function responsiveSheetFooterText(width: number, variants: ResponsiveSheetText): string {
  const textWidth = Math.max(0, width - cellWidth(SHEET_FOOTER_PREFIX));
  return responsiveSheetText(textWidth, variants);
}

/** Text inside a sheet is never eligible for terminal drag selection. */
export function SheetText({ children, ...props }: Omit<TextProps, "selectable">) {
  return (
    <text {...props} selectable={false}>
      {children}
    </text>
  );
}

export function SheetLabelValue({
  width,
  label,
  labelWidth = 15,
  value,
  valueColor,
  focused = false,
}: {
  width: number;
  label: string;
  labelWidth?: number;
  value: string | ReactNode;
  valueColor?: StationColor;
  /** Marks the row under a focus ring — a ▸ marker + cyan label instead of dim. */
  focused?: boolean;
}) {
  const theme = useStationTheme();
  const labelText = `${focused ? "▸" : " "}${fit(label, labelWidth)} `;
  const labelSpan = focused ? (
    <span fg={toOpenTuiColor(theme.action.primary)}>{labelText}</span>
  ) : (
    <span attributes={TextAttributes.DIM}>{labelText}</span>
  );
  if (isValidElement(value)) {
    return (
      <SheetText fg={toOpenTuiColor(theme.text.primary)}>
        {labelSpan}
        {value}
      </SheetText>
    );
  }
  return (
    <SheetText fg={toOpenTuiColor(theme.text.primary)}>
      {labelSpan}
      <span {...(valueColor === undefined ? {} : { fg: toOpenTuiColor(valueColor) })}>
        {fit(String(value), Math.max(1, width - cellWidth(labelText)))}
      </span>
    </SheetText>
  );
}

export function SheetLine({ width, children }: { width: number; children: string | ReactNode }) {
  const theme = useStationTheme();
  if (isValidElement(children)) {
    return <SheetText fg={toOpenTuiColor(theme.text.primary)}>{children}</SheetText>;
  }
  return (
    <SheetText fg={toOpenTuiColor(theme.text.primary)}>{fit(String(children), width)}</SheetText>
  );
}

export function SheetFooter({ width, children }: { width: number; children: string }) {
  const theme = useStationTheme();
  return (
    <SheetText fg={toOpenTuiColor(theme.text.primary)} attributes={TextAttributes.DIM}>
      {fit(`${SHEET_FOOTER_PREFIX}${children}`, width)}
    </SheetText>
  );
}
