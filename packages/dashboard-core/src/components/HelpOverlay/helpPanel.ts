import type { TuiHelpContentLine } from "../../state/keymap.js";
import { scrollbarOffsetForTrackIndex, verticalScrollbarCells } from "../scrollbar.js";

export type HelpPanelLayout = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type HelpPanelBorderLine = {
  kind: "border";
  text: string;
};

export type HelpPanelBodyLine = {
  kind: "body";
  prefix: string;
  bar: string;
  suffix: string;
  trackIndex: number;
  offset: number;
};

export type HelpPanelLine = HelpPanelBorderLine | HelpPanelBodyLine;

export type HelpPanelModel = {
  lines: HelpPanelLine[];
  overflow: boolean;
  bodyRows: number;
  scrollOffset: number;
};

export type { TuiHelpContentLine };

const MAX_PANEL_WIDTH = 64;
const MIN_PANEL_WIDTH = 30;
const PANEL_HORIZONTAL_PADDING = 2;

export function helpPanelLayout(
  columns: number,
  rows: number,
  content: readonly TuiHelpContentLine[],
): HelpPanelLayout {
  const availableColumns = Math.max(1, columns);
  const availableRows = Math.max(1, rows);
  const desiredWidth = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, availableColumns - 4));
  const width = Math.min(availableColumns, desiredWidth);
  const height = helpPanelHeight(availableRows, content.length);
  return {
    left: Math.max(0, Math.floor((availableColumns - width) / 2)),
    top: Math.max(0, Math.floor((availableRows - height) / 2)),
    width,
    height,
  };
}

export function helpPanelHeight(terminalRows: number, contentLength: number): number {
  const availableRows = Math.max(1, terminalRows);
  const desiredHeight = Math.max(0, Math.floor(contentLength)) + 2;
  const maxHeight = availableRows >= 8 ? availableRows - 4 : availableRows;
  return Math.min(maxHeight, desiredHeight);
}

export function helpPanelBodyRows(terminalRows: number, contentLength: number): number {
  return Math.max(0, helpPanelHeight(terminalRows, contentLength) - 2);
}

export function clampHelpScrollOffset(
  contentLength: number,
  bodyRows: number,
  offset: number,
): number {
  const viewport = Math.max(0, Math.floor(bodyRows));
  const maxOffset = Math.max(0, Math.floor(contentLength) - viewport);
  const requested = Number.isFinite(offset) ? Math.floor(offset) : 0;
  return Math.min(Math.max(0, requested), maxOffset);
}

export function helpPanelModel(
  width: number,
  height: number,
  content: readonly TuiHelpContentLine[],
  scrollOffset = 0,
): HelpPanelModel {
  const panelWidth = Math.max(1, width);
  const panelHeight = Math.max(1, height);
  if (panelHeight === 1) {
    return {
      lines: [{ kind: "border", text: horizontalBorder(panelWidth) }],
      overflow: content.length > 0,
      bodyRows: 0,
      scrollOffset: 0,
    };
  }

  const bodyRows = Math.max(0, panelHeight - 2);
  const overflow = content.length > bodyRows;
  const offset = clampHelpScrollOffset(content.length, bodyRows, scrollOffset);
  const bars = verticalScrollbarCells({
    trackHeight: bodyRows,
    contentLength: content.length,
    viewportLength: bodyRows,
    offset,
  });
  const lines: HelpPanelLine[] = [{ kind: "border", text: horizontalBorder(panelWidth) }];
  for (let index = 0; index < bodyRows; index += 1) {
    const bar = bars[index] ?? " ";
    const parts = contentLineParts(panelWidth, content[offset + index], bar);
    lines.push({
      kind: "body",
      prefix: parts.prefix,
      bar: parts.bar,
      suffix: parts.suffix,
      trackIndex: index,
      offset: scrollbarOffsetForTrackIndex({
        trackHeight: bodyRows,
        contentLength: content.length,
        viewportLength: bodyRows,
        offset,
        trackIndex: index,
      }),
    });
  }
  lines.push({ kind: "border", text: bottomBorder(panelWidth) });
  return {
    lines,
    overflow,
    bodyRows,
    scrollOffset: offset,
  };
}

export function helpPanelLines(
  width: number,
  height: number,
  content: readonly TuiHelpContentLine[],
  scrollOffset = 0,
): string[] {
  return helpPanelModel(width, height, content, scrollOffset).lines.map(joinHelpPanelLine);
}

export function joinHelpPanelLine(line: HelpPanelLine): string {
  return line.kind === "border" ? line.text : `${line.prefix}${line.bar}${line.suffix}`;
}

function horizontalBorder(width: number): string {
  if (width === 1) {
    return "─";
  }
  if (width === 2) {
    return "──";
  }
  return `╭${"─".repeat(width - 2)}╮`;
}

function bottomBorder(width: number): string {
  if (width === 1) {
    return "─";
  }
  if (width === 2) {
    return "──";
  }
  return `╰${"─".repeat(width - 2)}╯`;
}

function contentLineParts(
  width: number,
  content: TuiHelpContentLine | undefined,
  barGlyph: string,
): { prefix: string; bar: string; suffix: string } {
  if (width === 1) {
    return { prefix: "│", bar: "", suffix: "" };
  }
  if (width === 2) {
    return { prefix: "│", bar: "", suffix: "│" };
  }
  const innerWidth = width - 2;
  const padding = horizontalPaddingFor(innerWidth);
  const contentWidth = Math.max(0, innerWidth - padding * 2);
  const body = formatContent(content, contentWidth);
  const leftPad = " ".repeat(padding);
  // The thumb lives in the last inner pad cell so ╭╮│╰╯ stay rounded chrome.
  if (padding === 0) {
    return { prefix: `│${body}`, bar: "", suffix: "│" };
  }
  const rightPad = " ".repeat(padding - 1);
  return {
    prefix: `│${leftPad}${body}${rightPad}`,
    bar: barGlyph,
    suffix: "│",
  };
}

function formatContent(content: TuiHelpContentLine | undefined, width: number): string {
  if (content === undefined) {
    return " ".repeat(width);
  }
  if ("key" in content) {
    return formatHelpRow(content.key, content.description, width);
  }
  if (content.align === "center") {
    return centerText(content.text, width);
  }
  return fitText(content.text, width);
}

function formatHelpRow(key: string, description: string, width: number): string {
  if (width < 18) {
    return fitText(`${key} ${description}`, width);
  }
  const keyWidth = 9;
  const row = `${key.padEnd(keyWidth)}  ${description}`;
  return fitText(row, width);
}

function horizontalPaddingFor(innerWidth: number): number {
  if (innerWidth >= PANEL_HORIZONTAL_PADDING * 2 + 1) {
    return PANEL_HORIZONTAL_PADDING;
  }
  if (innerWidth >= 3) {
    return 1;
  }
  return 0;
}

function centerText(text: string, width: number): string {
  const fitted = fitText(text, width).trimEnd();
  const leftPadding = Math.max(0, Math.floor((width - fitted.length) / 2));
  return `${" ".repeat(leftPadding)}${fitted}`.padEnd(width);
}

function fitText(text: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  if (text.length > width) {
    return text.slice(0, width);
  }
  return text.padEnd(width);
}
