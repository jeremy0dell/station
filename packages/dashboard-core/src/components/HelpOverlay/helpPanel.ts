import type { TuiHelpContentLine } from "../../state/keymap.js";

export { TUI_HELP_CONTENT } from "../../state/keymap.js";

export type HelpPanelLayout = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type HelpContentLine = TuiHelpContentLine;

const MAX_PANEL_WIDTH = 64;
const MIN_PANEL_WIDTH = 30;
const PANEL_HORIZONTAL_PADDING = 2;

export function helpPanelLayout(
  columns: number,
  rows: number,
  content: readonly HelpContentLine[],
): HelpPanelLayout {
  const availableColumns = Math.max(1, columns);
  const availableRows = Math.max(1, rows);
  const desiredWidth = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, availableColumns - 4));
  const width = Math.min(availableColumns, desiredWidth);
  const desiredHeight = content.length + 2;
  const maxHeight = availableRows >= 8 ? availableRows - 4 : availableRows;
  const height = Math.min(maxHeight, desiredHeight);
  return {
    left: Math.max(0, Math.floor((availableColumns - width) / 2)),
    top: Math.max(0, Math.floor((availableRows - height) / 2)),
    width,
    height,
  };
}

export function helpPanelLines(
  width: number,
  height: number,
  content: readonly HelpContentLine[],
): string[] {
  const panelWidth = Math.max(1, width);
  const panelHeight = Math.max(1, height);
  if (panelHeight === 1) {
    return [horizontalBorder(panelWidth)];
  }

  const bodyRows = Math.max(0, panelHeight - 2);
  const lines = [horizontalBorder(panelWidth)];
  for (let index = 0; index < bodyRows; index += 1) {
    lines.push(contentLine(panelWidth, content[index]));
  }
  lines.push(bottomBorder(panelWidth));
  return lines;
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

function contentLine(width: number, content: HelpContentLine | undefined): string {
  if (width === 1) {
    return "│";
  }
  const innerWidth = width - 2;
  const padding = horizontalPaddingFor(innerWidth);
  const contentWidth = Math.max(0, innerWidth - padding * 2);
  const body = formatContent(content, contentWidth);
  return `│${" ".repeat(padding)}${body}${" ".repeat(padding)}│`;
}

function formatContent(content: HelpContentLine | undefined, width: number): string {
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
