// OpenTUI translation of apps/tui's bottom-sheet line primitives
// (AddProjectBottomSheet/parts.tsx + the per-sheet helpers): width-fitted
// single-line rows. Ink's dimColor becomes the DIM attribute; named colors
// come from the theme.
import { TextAttributes } from "@opentui/core";
import type { TextProps } from "@opentui/react";
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
      <SheetText fg={STATION_COLORS.foreground}>
        {labelSpan}
        {value}
      </SheetText>
    );
  }
  return (
    <SheetText fg={STATION_COLORS.foreground}>
      {labelSpan}
      <span {...(valueColor === undefined ? {} : { fg: valueColor })}>
        {fit(String(value), Math.max(1, width - labelText.length))}
      </span>
    </SheetText>
  );
}

export function SheetLine({ width, children }: { width: number; children: string | ReactNode }) {
  if (isValidElement(children)) {
    return <SheetText fg={STATION_COLORS.foreground}>{children}</SheetText>;
  }
  return <SheetText fg={STATION_COLORS.foreground}>{fit(String(children), width)}</SheetText>;
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
    <SheetText fg={STATION_COLORS.foreground} attributes={TextAttributes.DIM}>
      {fit(` ${children}`, width)}
    </SheetText>
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
    <SheetText
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
    </SheetText>
  );
}

export function SheetProgressFooter({ width, children }: { width: number; children: string }) {
  const throbberWidth = 3;
  const labelText = ` ${children}`.slice(0, Math.max(0, width - throbberWidth));
  const fillWidth = Math.max(0, width - labelText.length - throbberWidth);
  return (
    <SheetText fg={STATION_COLORS.foreground}>
      <span attributes={TextAttributes.DIM}>{labelText}</span>
      <Throbber variant="dots" />
      {fillWidth > 0 ? <span attributes={TextAttributes.DIM}>{spaces(fillWidth)}</span> : null}
    </SheetText>
  );
}

export type SheetButtonTone = "neutral" | "primary" | "success" | "danger";

const BUTTON_TONE_COLORS: Record<SheetButtonTone, string> = {
  neutral: STATION_COLORS.foreground,
  primary: STATION_COLORS.cyan,
  success: STATION_COLORS.green,
  danger: STATION_COLORS.red,
};

function SheetButton({
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
  const marker = focused ? "▸ " : "  ";
  const shortcutText = `(${shortcut})`;
  const available = Math.max(0, fixedWidth - marker.length);
  const showShortcut = available > shortcutText.length + 1;
  const labelWidth = Math.max(0, available - (showShortcut ? shortcutText.length + 1 : 0));
  const visibleLabel = label.slice(0, labelWidth);
  const renderedShortcut = showShortcut ? ` ${shortcutText}` : "";
  const trailing = spaces(fixedWidth - marker.length - visibleLabel.length - renderedShortcut.length);
  const shortcutColor = active
    ? STATION_COLORS.background
    : disabled
      ? STATION_COLORS.gray
      : STATION_COLORS.yellow;
  return (
    <SheetText
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
      {marker}
      {visibleLabel}
      {showShortcut ? (
        <>
          {" "}
          <span
            fg={shortcutColor}
            attributes={disabled ? TextAttributes.DIM : TextAttributes.BOLD}
          >
            {shortcutText}
          </span>
        </>
      ) : null}
      {trailing}
    </SheetText>
  );
}

export type SheetButtonSpec = {
  id: string;
  label: string;
  compactLabel?: string;
  shortcut: string;
  tone: SheetButtonTone;
  mouseTarget: StationMouseTarget;
  focused: boolean;
  disabled: boolean;
};

function naturalSheetButtonWidth(button: SheetButtonSpec): number {
  return button.label.length + button.shortcut.length + 5;
}

/** Natural-width action group that uses compact equal-width controls only when content cannot fit. */
export function SheetButtonRow({
  width,
  buttons,
}: {
  width: number;
  buttons: readonly SheetButtonSpec[];
}) {
  if (buttons.length === 0) return null;
  const naturalWidths = buttons.map(naturalSheetButtonWidth);
  const roomyGap = 2;
  const naturalTotal =
    naturalWidths.reduce((total, buttonWidth) => total + buttonWidth, 0) +
    roomyGap * (buttons.length - 1);
  const naturalLayout = naturalTotal <= width;
  const gap = naturalLayout ? roomyGap : width >= buttons.length * 8 ? 1 : 0;
  const fallbackWidth = Math.max(1, Math.floor((width - gap * (buttons.length - 1)) / buttons.length));

  return (
    <box flexDirection="row" width={width} height={1}>
      {buttons.map((button, index) => (
        <box key={button.id} flexDirection="row" height={1}>
          {index === 0 || gap === 0 ? null : <SheetText>{spaces(gap)}</SheetText>}
          <SheetButton
            label={naturalLayout ? button.label : button.compactLabel ?? button.label}
            shortcut={button.shortcut}
            tone={button.tone}
            fixedWidth={naturalLayout ? (naturalWidths[index] ?? fallbackWidth) : fallbackWidth}
            mouseTarget={button.mouseTarget}
            focused={button.focused}
            disabled={button.disabled}
          />
        </box>
      ))}
    </box>
  );
}

/** Interactive field whose label, accelerator, value, and status remain visually associated. */
export function SheetControlRow({
  width,
  label,
  labelWidth = 11,
  shortcut,
  value,
  valueCells,
  status,
  focused = false,
  disabled = false,
  mouseTarget,
}: {
  width: number;
  label: string;
  labelWidth?: number;
  shortcut?: string;
  value: string | ReactNode;
  valueCells?: number;
  status?: { glyph: string; text: string; color?: string };
  focused?: boolean;
  disabled?: boolean;
  mouseTarget: StationMouseTarget;
}) {
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  const marker = focused ? "▸ " : "  ";
  const shortcutText = shortcut === undefined ? "" : ` (${shortcut})`;
  const labelPadding = spaces(Math.max(0, labelWidth - label.length - shortcutText.length));
  const statusText = status === undefined ? "" : ` ${status.glyph} ${status.text}`;
  const prefixCells = marker.length + label.length + shortcutText.length + labelPadding.length + 1;
  const valueBudget = Math.max(0, width - prefixCells - statusText.length);
  const valueElement = isValidElement(value) ? value : undefined;
  const visibleValue = typeof value === "string" ? value.slice(0, valueBudget) : "";
  const renderedValueCells =
    valueElement === undefined ? visibleValue.length : Math.min(valueBudget, valueCells ?? 0);
  const rowWidth = Math.max(
    1,
    Math.min(width, prefixCells + renderedValueCells + statusText.length),
  );
  const foreground = disabled ? STATION_COLORS.gray : STATION_COLORS.foreground;

  return (
    <SheetText
      width={rowWidth}
      wrapMode="none"
      fg={foreground}
      attributes={disabled ? TextAttributes.DIM : TextAttributes.NONE}
      {...(hover && !disabled ? { bg: STATION_COLORS.hoverBackground } : {})}
      {...(disabled ? {} : stationMouseProps(dispatch, mouseTarget))}
      onMouseOver={() => {
        if (!disabled) setHover(true);
      }}
      onMouseOut={() => setHover(false)}
    >
      <span fg={focused ? STATION_COLORS.cyan : foreground}>{marker}</span>
      <span
        fg={focused ? STATION_COLORS.cyan : foreground}
        attributes={focused ? TextAttributes.BOLD : TextAttributes.DIM}
      >
        {label}
      </span>
      {shortcut === undefined ? null : (
        <span
          fg={disabled ? STATION_COLORS.gray : STATION_COLORS.yellow}
          attributes={disabled ? TextAttributes.DIM : TextAttributes.BOLD}
        >
          {shortcutText}
        </span>
      )}
      {labelPadding}
      {" "}
      {valueElement ?? visibleValue}
      {status === undefined ? null : (
        <span fg={status.color ?? foreground}>{statusText}</span>
      )}
    </SheetText>
  );
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
    <SheetText
      fg={color ?? STATION_COLORS.foreground}
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
  const labelText = ` ${label.padEnd(7)} `;
  return (
    <SheetText fg={STATION_COLORS.foreground}>
      <span attributes={TextAttributes.DIM}>{labelText}</span>
      {fit(value, Math.max(1, width - labelText.length))}
    </SheetText>
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
      {gap > 0 ? <SheetText>{spaces(gap)}</SheetText> : null}
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
    <SheetText
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
    </SheetText>
  );
}
