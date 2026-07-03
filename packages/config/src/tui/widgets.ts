import { loadConfig, loadConfigFromToml } from "../load/index.js";
import { atomicWriteConfig, loadConfigSource } from "../projects/source.js";
import type { StationConfig, TuiWidgetConfig } from "../schema.js";

export type SetTuiWidgetsOptions = {
  widgets: readonly TuiWidgetConfig[];
  configPath?: string;
  homeDir?: string;
};

export type SetTuiWidgetsResult = {
  status: "updated" | "unchanged";
  configPath: string;
  widgets: readonly TuiWidgetConfig[];
  config: StationConfig;
};

export async function setTuiWidgetsInConfig(
  options: SetTuiWidgetsOptions,
): Promise<SetTuiWidgetsResult> {
  const loaded = await loadConfigSource(options);
  const candidateSource = replaceTuiWidgets(loaded.source, options.widgets);
  if (candidateSource === loaded.source) {
    return {
      status: "unchanged",
      configPath: loaded.configPath,
      widgets: loaded.loaded.config.tui?.widgets ?? [],
      config: loaded.loaded.config,
    };
  }

  await loadConfigFromToml(candidateSource, {
    configPath: loaded.configPath,
    homeDir: loaded.homeDir,
  });
  await atomicWriteConfig(loaded.configPath, candidateSource);
  const after = await loadConfig({ configPath: loaded.configPath, homeDir: loaded.homeDir });
  return {
    status: "updated",
    configPath: loaded.configPath,
    widgets: after.config.tui?.widgets ?? [],
    config: after.config,
  };
}

export function replaceTuiWidgets(source: string, widgets: readonly TuiWidgetConfig[]): string {
  const withoutWidgets = removeExistingTuiWidgets(source.split("\n"));
  const formatted = formatTuiWidgets(widgets);
  const insertAt = tuiInsertIndex(withoutWidgets);
  const next =
    insertAt.kind === "existing"
      ? [
          ...withoutWidgets.slice(0, insertAt.index),
          ...formatted,
          ...withoutWidgets.slice(insertAt.index),
        ]
      : appendTuiSection(withoutWidgets, formatted);
  return `${trimRepeatedBlankLines(next).join("\n").trimEnd()}\n`;
}

function removeExistingTuiWidgets(lines: readonly string[]): string[] {
  const result: string[] = [];
  let inTuiTable = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (isTuiWidgetsTable(line)) {
      index = skipTuiWidgetsBlock(lines, index) - 1;
      continue;
    }
    if (isAnyTable(line)) {
      inTuiTable = isTuiTable(line);
    }
    if (inTuiTable && /^\s*widgets\s*=/.test(line)) {
      index = skipInlineWidgetsAssignment(lines, index) - 1;
      continue;
    }
    result.push(line);
  }
  return result;
}

function skipTuiWidgetsBlock(lines: readonly string[], start: number): number {
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (isAnyTable(line) && !isTuiWidgetsNestedTable(line)) {
      return index;
    }
  }
  return lines.length;
}

function skipInlineWidgetsAssignment(lines: readonly string[], start: number): number {
  const first = lines[start] ?? "";
  if (first.includes("]")) {
    return start + 1;
  }
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.includes("]")) {
      return index + 1;
    }
  }
  return lines.length;
}

function tuiInsertIndex(
  lines: readonly string[],
): { kind: "existing"; index: number } | { kind: "append" } {
  const tableIndex = lines.findIndex(isTuiTable);
  if (tableIndex === -1) {
    return { kind: "append" };
  }
  for (let index = tableIndex + 1; index < lines.length; index += 1) {
    if (isAnyTable(lines[index] ?? "")) {
      return { kind: "existing", index };
    }
  }
  return { kind: "existing", index: lines.length };
}

function appendTuiSection(lines: readonly string[], formatted: readonly string[]): string[] {
  const prefix = lines.length > 0 && (lines.at(-1) ?? "").trim().length > 0 ? [""] : [];
  return [...lines, ...prefix, "[tui]", ...formatted];
}

function formatTuiWidgets(widgets: readonly TuiWidgetConfig[]): string[] {
  if (widgets.length === 0) {
    return ["widgets = []"];
  }
  return widgets.flatMap((widget, index) => [
    ...(index === 0 ? [] : [""]),
    "[[tui.widgets]]",
    ...formatTuiWidget(widget),
  ]);
}

function formatTuiWidget(widget: TuiWidgetConfig): string[] {
  const lines = [`type = ${quoteTomlString(widget.type)}`];
  if (widget.enabled !== undefined) {
    lines.push(`enabled = ${widget.enabled ? "true" : "false"}`);
  }
  switch (widget.type) {
    case "time":
      if (widget.timeFormat !== undefined) {
        lines.push(`time_format = ${quoteTomlString(widget.timeFormat)}`);
      }
      return lines;
    case "weather":
      lines.push(`city = ${quoteTomlString(widget.city)}`);
      if (widget.label !== undefined) {
        lines.push(`label = ${quoteTomlString(widget.label)}`);
      }
      if (widget.temperatureUnit !== undefined) {
        lines.push(`temperature_unit = ${quoteTomlString(widget.temperatureUnit)}`);
      }
      if (widget.refreshIntervalMinutes !== undefined) {
        lines.push(`refresh_interval_minutes = ${widget.refreshIntervalMinutes}`);
      }
      return lines;
    case "fleet":
    case "prs":
    case "moon":
      return lines;
    case "tz":
      if (widget.timeFormat !== undefined) {
        lines.push(`time_format = ${quoteTomlString(widget.timeFormat)}`);
      }
      for (const zone of widget.zones) {
        lines.push("", "[[tui.widgets.zones]]");
        lines.push(`label = ${quoteTomlString(zone.label)}`);
        lines.push(`time_zone = ${quoteTomlString(zone.timeZone)}`);
      }
      return lines;
  }
}

function isAnyTable(line: string): boolean {
  return /^\s*\[/.test(line);
}

function isTuiTable(line: string): boolean {
  return /^\s*\[\s*tui\s*\]\s*(?:#.*)?$/.test(line);
}

function isTuiWidgetsTable(line: string): boolean {
  return /^\s*\[\[\s*tui\.widgets\s*\]\]\s*(?:#.*)?$/.test(line);
}

function isTuiWidgetsNestedTable(line: string): boolean {
  return /^\s*\[\[?\s*tui\.widgets(?:\.|\s*\])/.test(line);
}

function trimRepeatedBlankLines(lines: readonly string[]): string[] {
  const result: string[] = [];
  let previousBlank = false;
  for (const line of lines) {
    const blank = line.trim().length === 0;
    if (blank && previousBlank) {
      continue;
    }
    result.push(line);
    previousBlank = blank;
  }
  return result;
}

function quoteTomlString(value: string): string {
  return JSON.stringify(value);
}
