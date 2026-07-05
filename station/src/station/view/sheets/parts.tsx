// OpenTUI translation of apps/tui's bottom-sheet line primitives
// (AddProjectBottomSheet/parts.tsx + the per-sheet helpers): width-fitted
// single-line rows. Ink's dimColor becomes the DIM attribute; named colors
// come from the theme.
import { TextAttributes } from "@opentui/core";
import { isValidElement, type ReactNode, useState } from "react";
import type { StationMouseTarget } from "../../input/stationMouse.js";
import { useStationMouse, stationMouseProps } from "../stationMouseContext.js";
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
  focused = false,
}: {
  width: number;
  label: string;
  labelWidth?: number;
  value: string | ReactNode;
  valueColor?: string;
  /** Marks the row under a focus ring — a ▸ marker + cyan label instead of dim. */
  focused?: boolean;
}) {
  const labelText = `${focused ? "▸" : " "}${label.padEnd(labelWidth)} `;
  const labelSpan = focused ? (
    <span fg={STATION_COLORS.cyan}>{labelText}</span>
  ) : (
    <span attributes={TextAttributes.DIM}>{labelText}</span>
  );
  if (isValidElement(value)) {
    return (
      <text fg={STATION_COLORS.foreground}>
        {labelSpan}
        {value}
      </text>
    );
  }
  return (
    <text fg={STATION_COLORS.foreground}>
      {labelSpan}
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

export function SheetChoiceLine({
  choiceKey,
  label,
  detail,
  color,
  width,
  current = false,
  selected = false,
  note,
}: {
  choiceKey: string;
  label: string;
  detail: string;
  color?: string | undefined;
  width: number;
  /** Marks the row as the currently-selected option (e.g. a project's default). */
  current?: boolean;
  /** Marks the row under the keyboard cursor; painted like hover so ↑↓ and mouse agree. */
  selected?: boolean;
  /** Right-aligned dim status (e.g. "updating…") shown in the row's free space. */
  note?: string | undefined;
}) {
  const dispatch = useStationMouse();
  const [hover, setHover] = useState(false);
  const focused = hover || selected;
  // The marker reuses the prefix's leading margin column so the key/label
  // columns stay aligned and the row width is unchanged whether or not it is set.
  const marker = current ? "✓" : " ";
  const keyPrefix = `${choiceKey} `;
  const detailPrefix = `${label} `;
  const detailWidth = Math.max(0, width - 1 - keyPrefix.length - detailPrefix.length);
  const visibleDetail = detail.slice(0, detailWidth);
  // Whatever the detail leaves unused is split into a gap then the right-aligned
  // note, so the row stays exactly `width` wide whether or not a note is set.
  const free = Math.max(0, detailWidth - visibleDetail.length);
  const visibleNote = (note ?? "").slice(0, free);
  const gap = spaces(free - visibleNote.length);
  return (
    <text
      fg={focused ? STATION_COLORS.green : STATION_COLORS.foreground}
      {...(focused ? { bg: STATION_COLORS.hoverBackground } : {})}
      {...stationMouseProps(dispatch, { kind: "sheetChoice", choiceKey })}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      <span {...(current ? { fg: STATION_COLORS.cyan } : {})}>{marker}</span>
      {keyPrefix}
      {detailPrefix}
      <span {...(color === undefined ? {} : { fg: color })}>{visibleDetail}</span>
      {gap}
      <span attributes={TextAttributes.DIM}>{visibleNote}</span>
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

export type SheetButtonTone = "success" | "danger";

const BUTTON_TONE_COLORS: Record<SheetButtonTone, string> = {
  success: STATION_COLORS.green,
  danger: STATION_COLORS.red,
};

export function SheetButton({
  label,
  shortcut,
  tone,
  fixedWidth,
  mouseTarget,
}: {
  label: string;
  shortcut: string;
  tone: SheetButtonTone;
  fixedWidth: number;
  mouseTarget: StationMouseTarget;
}) {
  const dispatch = useStationMouse();
  const [hover, setHover] = useState(false);
  const color = BUTTON_TONE_COLORS[tone];
  return (
    <text
      width={fixedWidth}
      fg={hover ? STATION_COLORS.background : color}
      attributes={hover ? TextAttributes.BOLD : TextAttributes.NONE}
      {...(hover ? { bg: color } : {})}
      {...stationMouseProps(dispatch, mouseTarget)}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      {fit(` ${label} (${shortcut})`, fixedWidth)}
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

/** The Yes/No confirm row shared by the bottom-sheet confirm dialogs. */
export function SheetConfirmButtons({ width }: { width: number }) {
  const gap = width >= 22 ? 2 : 0;
  const buttonWidth = Math.max(1, Math.min(10, Math.floor((width - gap) / 2)));
  return (
    <box flexDirection="row" width={width}>
      <SheetButton
        label="Yes"
        shortcut="y"
        tone="success"
        fixedWidth={buttonWidth}
        mouseTarget={{ kind: "sheetButton", key: "y" }}
      />
      {gap > 0 ? <text>{spaces(gap)}</text> : null}
      <SheetButton
        label="No"
        shortcut="n"
        tone="danger"
        fixedWidth={buttonWidth}
        mouseTarget={{ kind: "sheetButton", key: "n" }}
      />
    </box>
  );
}

/** Width for the compact bottom-sheet confirm dialogs (capped at 46 columns). */
export function compactSheetWidth(columns: number): number {
  return Math.min(Math.max(1, Math.floor(columns)), 46);
}

/** Index-selected picker line (the add-project flow's cursor-driven lists). */
export function SheetPickerLine({
  width,
  selected,
  label,
  detail,
  mouseTarget,
}: {
  width: number;
  selected: boolean;
  label: string;
  detail: string;
  /** When set, clicking the row moves the flow cursor to it. */
  mouseTarget?: StationMouseTarget;
}) {
  const dispatch = useStationMouse();
  const [hover, setHover] = useState(false);
  const prefix = selected ? " > " : "   ";
  const detailText = detail.length === 0 ? "" : ` ${detail}`;
  const maxDetailWidth = Math.max(0, width - prefix.length - 10);
  const visibleDetail = fit(detailText, Math.min(detailText.length, maxDetailWidth));
  const labelWidth = Math.max(1, width - prefix.length - visibleDetail.length);
  const color = selected || hover ? STATION_COLORS.cyan : STATION_COLORS.foreground;
  return (
    <text
      fg={STATION_COLORS.foreground}
      {...(mouseTarget === undefined
        ? {}
        : {
            ...stationMouseProps(dispatch, mouseTarget),
            onMouseOver: () => setHover(true),
            onMouseOut: () => setHover(false),
          })}
    >
      <span fg={color}>{prefix}</span>
      <span fg={color}>{fit(label, labelWidth)}</span>
      {visibleDetail.length > 0 ? (
        <span attributes={TextAttributes.DIM}>{visibleDetail}</span>
      ) : null}
    </text>
  );
}
