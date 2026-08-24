// Compact controls intentionally remain terminal-cell leaf layouts. Their parent
// sheet boxes own intrinsic height, scrolling, clipping, padding, and framing.
import { TextAttributes, type ColorInput } from "@opentui/core";
import { cellWidth, clipCells } from "@station/dashboard-core/text";
import type { TextProps } from "@opentui/react";
import { isValidElement, type ReactNode } from "react";
import type { StationMouseTarget } from "../../input/stationMouse.js";
import {
  useStationHoverState,
  useStationMouse,
  stationMouseProps,
} from "../stationMouseContext.js";
import { Throbber } from "../Throbber.js";
import {
  toOpenTuiColor,
  useStationTheme,
  type StationColor,
  type StationTheme,
} from "../../../theme/index.js";
import { semanticItemRenderableId } from "../layout/scrollViewport.js";

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

export function SheetChoiceLine({
  choiceKey,
  label,
  detail,
  color,
  width,
  current = false,
  selected = false,
  note,
  itemId,
}: {
  choiceKey: string;
  label: string;
  detail: string;
  color?: StationColor | undefined;
  width: number;
  /** Marks the row as the currently-selected option (e.g. a project's default). */
  current?: boolean;
  /** Marks the row under the keyboard cursor; painted like hover so ↑↓ and mouse agree. */
  selected?: boolean;
  /** Right-aligned dim status (e.g. "updating…") shown in the row's free space. */
  note?: string | undefined;
  /** Semantic identity used by the sheet viewport for focus-follow. */
  itemId?: string;
}) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  const focused = hover || selected;
  // Cursor and canonical selection stay independent without changing row width.
  const cursor = selected ? "▸" : " ";
  const marker = current ? "✓" : " ";
  const keyPrefix = `${choiceKey} `;
  const content = detail.length === 0 ? label : `${label} ${detail}`;
  const contentWidth = Math.max(0, width - 2 - cellWidth(keyPrefix));
  const noteText = note ?? "";
  const noteWidth = Math.min(cellWidth(noteText), Math.max(0, contentWidth - 2));
  const visibleNote = clipCells(noteText, noteWidth);
  const visibleContent = clipCells(
    content,
    Math.max(0, contentWidth - (noteWidth > 0 ? noteWidth + 1 : 0)),
  );
  const gap = spaces(
    Math.max(0, contentWidth - cellWidth(visibleContent) - cellWidth(visibleNote)),
  );
  return (
    <SheetText
      {...(itemId === undefined ? {} : { id: semanticItemRenderableId(itemId) })}
      fg={toOpenTuiColor(focused ? theme.status.success : theme.text.primary)}
      {...(focused ? { bg: toOpenTuiColor(theme.interaction.hover) } : {})}
      {...stationMouseProps(dispatch, { kind: "sheetChoice", choiceKey })}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      width={width}
      wrapMode="none"
    >
      {cursor}
      <span {...(current ? { fg: toOpenTuiColor(theme.action.primary) } : {})}>{marker}</span>
      {keyPrefix}
      <span {...(color === undefined ? {} : { fg: toOpenTuiColor(color) })}>{visibleContent}</span>
      {gap}
      <span attributes={TextAttributes.DIM}>{visibleNote}</span>
    </SheetText>
  );
}

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

export type SheetButtonTone = "neutral" | "primary" | "success" | "danger";

function sheetButtonToneColor(theme: StationTheme, tone: SheetButtonTone): ColorInput {
  switch (tone) {
    case "neutral":
      return toOpenTuiColor(theme.text.primary);
    case "primary":
      return toOpenTuiColor(theme.action.primary);
    case "success":
      return toOpenTuiColor(theme.action.success);
    case "danger":
      return toOpenTuiColor(theme.action.danger);
  }
}

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
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  const color = disabled ? toOpenTuiColor(theme.text.muted) : sheetButtonToneColor(theme, tone);
  const active = !disabled && hover;
  const attributes = interactiveAttributes({
    active,
    disabled,
    emphasized: focused,
  });
  const background = interactiveBackground(
    active,
    focused,
    color,
    toOpenTuiColor(theme.interaction.keyboardFocus),
  );
  const marker = focused ? "▸ " : "  ";
  const shortcutText = `(${shortcut})`;
  const available = Math.max(0, fixedWidth - cellWidth(marker));
  const shortcutCells = cellWidth(shortcutText);
  // One-cell abbreviations make distinct actions such as Use and Up ambiguous.
  const showShortcut = available >= shortcutCells + 3;
  const labelWidth = Math.max(0, available - (showShortcut ? shortcutCells + 1 : 0));
  const visibleLabel = clipCells(label, labelWidth);
  const renderedShortcut = showShortcut ? ` ${shortcutText}` : "";
  const trailing = spaces(
    fixedWidth - cellWidth(marker) - cellWidth(visibleLabel) - cellWidth(renderedShortcut),
  );
  const shortcutColor = active
    ? toOpenTuiColor(theme.text.inverse)
    : disabled
      ? toOpenTuiColor(theme.text.muted)
      : toOpenTuiColor(theme.action.warning);
  return (
    <SheetText
      width={fixedWidth}
      fg={active ? toOpenTuiColor(theme.text.inverse) : color}
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
          <span fg={shortcutColor} attributes={disabled ? TextAttributes.DIM : TextAttributes.BOLD}>
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
  return cellWidth(button.label) + cellWidth(button.shortcut) + 5;
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
  const fallbackWidth = Math.max(
    1,
    Math.floor((width - gap * (buttons.length - 1)) / buttons.length),
  );

  return (
    <box flexDirection="row" width={width}>
      {buttons.map((button, index) => (
        <box key={button.id} flexDirection="row">
          {index === 0 || gap === 0 ? null : <SheetText>{spaces(gap)}</SheetText>}
          <SheetButton
            label={naturalLayout ? button.label : (button.compactLabel ?? button.label)}
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
  status?: { glyph: string; text: string; color?: StationColor };
  focused?: boolean;
  disabled?: boolean;
  mouseTarget: StationMouseTarget;
}) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  const marker = focused ? "▸ " : "  ";
  const shortcutText = shortcut === undefined ? "" : ` (${shortcut})`;
  const labelPadding = spaces(Math.max(0, labelWidth - cellWidth(label) - cellWidth(shortcutText)));
  const statusText = status === undefined ? "" : ` ${status.glyph} ${status.text}`;
  const prefixCells =
    cellWidth(marker) + cellWidth(label) + cellWidth(shortcutText) + cellWidth(labelPadding) + 1;
  const valueBudget = Math.max(0, width - prefixCells - cellWidth(statusText));
  const valueElement = isValidElement(value) ? value : undefined;
  const visibleValue = typeof value === "string" ? clipCells(value, valueBudget) : "";
  const renderedValueCells =
    valueElement === undefined ? cellWidth(visibleValue) : Math.min(valueBudget, valueCells ?? 0);
  const rowWidth = Math.max(
    1,
    Math.min(width, prefixCells + renderedValueCells + cellWidth(statusText)),
  );
  const foreground = toOpenTuiColor(disabled ? theme.text.muted : theme.text.primary);

  return (
    <SheetText
      width={rowWidth}
      wrapMode="none"
      fg={foreground}
      attributes={disabled ? TextAttributes.DIM : TextAttributes.NONE}
      {...(hover && !disabled ? { bg: toOpenTuiColor(theme.interaction.hover) } : {})}
      {...(disabled ? {} : stationMouseProps(dispatch, mouseTarget))}
      onMouseOver={() => {
        if (!disabled) setHover(true);
      }}
      onMouseOut={() => setHover(false)}
    >
      <span fg={focused ? toOpenTuiColor(theme.action.primary) : foreground}>{marker}</span>
      <span
        fg={focused ? toOpenTuiColor(theme.action.primary) : foreground}
        attributes={focused ? TextAttributes.BOLD : TextAttributes.DIM}
      >
        {label}
      </span>
      {shortcut === undefined ? null : (
        <span
          fg={toOpenTuiColor(disabled ? theme.text.muted : theme.action.warning)}
          attributes={disabled ? TextAttributes.DIM : TextAttributes.BOLD}
        >
          {shortcutText}
        </span>
      )}
      {labelPadding} {valueElement ?? visibleValue}
      {status === undefined ? null : (
        <span fg={status.color === undefined ? foreground : toOpenTuiColor(status.color)}>
          {statusText}
        </span>
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
  activeColor: ColorInput,
  focusedColor: ColorInput,
): { bg?: ColorInput } {
  if (active) return { bg: activeColor };
  if (focused) return { bg: focusedColor };
  return {};
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
  itemId,
}: {
  width: number;
  selected: boolean;
  label: string;
  detail: string;
  /** When set, clicking the row moves the flow cursor to it. */
  mouseTarget?: StationMouseTarget;
  /** Semantic identity used by the sheet viewport for focus-follow. */
  itemId?: string;
}) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  const prefix = selected ? " > " : "   ";
  const detailText = detail.length === 0 ? "" : ` ${detail}`;
  const maxDetailWidth = Math.max(0, width - cellWidth(prefix) - 10);
  const visibleDetail = fit(detailText, Math.min(cellWidth(detailText), maxDetailWidth));
  const labelWidth = Math.max(1, width - cellWidth(prefix) - cellWidth(visibleDetail));
  const color = toOpenTuiColor(selected || hover ? theme.action.primary : theme.text.primary);
  return (
    <SheetText
      {...(itemId === undefined ? {} : { id: semanticItemRenderableId(itemId) })}
      fg={toOpenTuiColor(theme.text.primary)}
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
      {cellWidth(visibleDetail) > 0 ? (
        <span attributes={TextAttributes.DIM}>{visibleDetail}</span>
      ) : null}
    </SheetText>
  );
}
