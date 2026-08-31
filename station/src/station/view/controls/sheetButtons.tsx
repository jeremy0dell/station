import { TextAttributes, type ColorInput } from "@opentui/core";
import { cellWidth, clipCells } from "@station/dashboard-core/text";
import { isValidElement, type ReactNode } from "react";
import type { StationMouseTarget } from "../../input/stationMouse.js";
import {
  toOpenTuiColor,
  useStationTheme,
  type StationColor,
  type StationTheme,
} from "../../../theme/index.js";
import {
  stationMouseProps,
  useStationHoverState,
  useStationMouse,
} from "../stationMouseContext.js";
import { SheetText, spaces } from "./sheetText.js";

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
  status?: { glyph: string; text: string; color?: StationColor } | undefined;
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
