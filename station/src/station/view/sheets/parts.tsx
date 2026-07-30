// OpenTUI translation of apps/tui's bottom-sheet line primitives
// (AddProjectBottomSheet/parts.tsx + the per-sheet helpers): width-fitted
// single-line rows. Ink's dimColor becomes the DIM attribute; named colors
// come from the theme.
import { TextAttributes } from "@opentui/core";
import { isValidElement, type ReactNode } from "react";
import type { StationMouseTarget } from "../../input/stationMouse.js";
import {
  useStationHoverState,
  useStationMouse,
  stationMouseProps,
} from "../stationMouseContext.js";
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
  const [hover, setHover] = useStationHoverState();
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

export type SheetButtonTone = "neutral" | "primary" | "success" | "danger";

const BUTTON_TONE_COLORS: Record<SheetButtonTone, string> = {
  neutral: STATION_COLORS.foreground,
  primary: STATION_COLORS.cyan,
  success: STATION_COLORS.green,
  danger: STATION_COLORS.red,
};

export function SheetButton({
  label,
  shortcut,
  tone,
  fixedWidth,
  mouseTarget,
  focused = false,
  disabled = false,
}: {
  label: string;
  shortcut: string;
  tone: SheetButtonTone;
  fixedWidth: number;
  mouseTarget: StationMouseTarget;
  focused?: boolean;
  disabled?: boolean;
}) {
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  const color = disabled ? STATION_COLORS.gray : BUTTON_TONE_COLORS[tone];
  const active = !disabled && hover;
  const attributes = interactiveAttributes({
    active,
    disabled,
    emphasized: focused,
  });
  const background = interactiveBackground(active, focused, color);
  return (
    <text
      width={fixedWidth}
      fg={active ? STATION_COLORS.background : color}
      attributes={attributes}
      {...background}
      {...(disabled ? {} : stationMouseProps(dispatch, mouseTarget))}
      onMouseOver={() => {
        if (!disabled) setHover(true);
      }}
      onMouseOut={() => setHover(false)}
    >
      {fit(`${focused ? "▸" : " "}${label} (${shortcut})`, fixedWidth)}
    </text>
  );
}

export type SheetActionTone = "neutral" | "primary" | "secondary" | "danger";

export function SheetActionRow({
  width,
  label,
  shortcut,
  detail,
  detailCells,
  status,
  tone = "secondary",
  focused = false,
  disabled = false,
  mouseTarget,
}: {
  width: number;
  label: string;
  shortcut?: string;
  detail?: string | ReactNode;
  detailCells?: number;
  status?: { glyph: string; text: string; color?: string };
  tone?: SheetActionTone;
  focused?: boolean;
  disabled?: boolean;
  mouseTarget: StationMouseTarget;
}) {
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  const active = !disabled && hover;
  const foreground = sheetActionForeground(tone, disabled);
  const attributes = interactiveAttributes({
    active,
    disabled,
    emphasized: focused || tone === "primary",
  });
  const background = interactiveBackground(active, focused, foreground);
  const shortcutLabel = shortcut === undefined ? "" : ` (${shortcut})`;
  const actionLabel = `${label}${shortcutLabel}`;
  const visibleLabel = tone === "primary" ? `[ ${actionLabel} ]` : actionLabel;
  const prefix = `${focused ? "▸" : " "} ${visibleLabel}`;
  const statusText = status === undefined ? "" : ` ${status.glyph} ${status.text}`;
  const detailBudget = Math.max(0, width - prefix.length - statusText.length - 1);
  const detailElement = isValidElement(detail) ? detail : undefined;
  const visibleDetail = typeof detail === "string" ? fit(detail, detailBudget) : "";
  const renderedDetailCells =
    detailElement === undefined ? visibleDetail.length : Math.min(detailBudget, detailCells ?? 0);
  const trailing = Math.max(0, width - prefix.length - renderedDetailCells - statusText.length);
  return (
    <text
      width={width}
      fg={active ? STATION_COLORS.background : foreground}
      attributes={attributes}
      {...background}
      {...(disabled ? {} : stationMouseProps(dispatch, mouseTarget))}
      onMouseOver={() => {
        if (!disabled) setHover(true);
      }}
      onMouseOut={() => setHover(false)}
    >
      {prefix}
      {visibleDetail.length > 0 ? ` ${visibleDetail}` : null}
      {detailElement === undefined ? null : (
        <>
          {" "}
          {detailElement}
        </>
      )}
      {spaces(Math.max(0, trailing - Number(detail !== undefined)))}
      {status === undefined ? null : (
        <span fg={status.color ?? foreground}>{statusText}</span>
      )}
    </text>
  );
}

function sheetActionForeground(tone: SheetActionTone, disabled: boolean): string {
  if (disabled) return STATION_COLORS.gray;
  if (tone === "primary") return STATION_COLORS.cyan;
  if (tone === "danger") return STATION_COLORS.red;
  return STATION_COLORS.foreground;
}

function interactiveAttributes({
  active,
  disabled,
  emphasized,
}: {
  active: boolean;
  disabled: boolean;
  emphasized: boolean;
}) {
  if (disabled) return TextAttributes.DIM;
  return active || emphasized ? TextAttributes.BOLD : TextAttributes.NONE;
}

function interactiveBackground(
  active: boolean,
  focused: boolean,
  activeColor: string,
): { bg?: string } {
  if (active) return { bg: activeColor };
  if (focused) return { bg: STATION_COLORS.focusBackground };
  return {};
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
  const [hover, setHover] = useStationHoverState();
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
