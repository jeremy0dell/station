import { loadConfigFromToml } from "../load/index.js";
import { atomicWriteConfig, loadConfigSource } from "../projects/source.js";
import type { StationConfig, TuiWidgetConfig } from "../schema.js";
import { quoteTomlString, trimRepeatedBlankLines } from "../tomlEdit.js";

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

  // Parse the candidate before writing so an edit this writer mishandled can
  // never land on disk; the same parse result then serves as the reload.
  const after = await loadConfigFromToml(candidateSource, {
    configPath: loaded.configPath,
    homeDir: loaded.homeDir,
  });
  await atomicWriteConfig(loaded.configPath, candidateSource);
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
  let topLevel = true;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (isTuiWidgetsTable(line)) {
      index = skipTuiWidgetsBlock(lines, index) - 1;
      continue;
    }
    if (isAnyTable(line)) {
      inTuiTable = isTuiTable(line);
      topLevel = false;
    }
    // `widgets =` inside [tui], or the dotted `tui.widgets =` form before any
    // table header; the dotted key must go too or the appended [tui] header
    // would illegally redefine the table.
    const isWidgetsAssignment =
      (inTuiTable && /^\s*widgets\s*=/.test(line)) ||
      (topLevel && /^\s*tui\s*\.\s*widgets\s*=/.test(line));
    if (isWidgetsAssignment) {
      index = skipInlineWidgetsAssignment(lines, index) - 1;
      continue;
    }
    result.push(line);
  }
  return result;
}

function skipTuiWidgetsBlock(lines: readonly string[], start: number): number {
  // The block ends after its last key or nested-table line; trailing blank and
  // comment lines belong to whatever follows, so user annotations survive.
  let end = start + 1;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (isAnyTable(line) && !isTuiWidgetsNestedTable(line)) {
      break;
    }
    const trimmed = line.trim();
    if (trimmed.length > 0 && !trimmed.startsWith("#")) {
      end = index + 1;
    }
  }
  return end;
}

function skipInlineWidgetsAssignment(lines: readonly string[], start: number): number {
  let depth = 0;
  for (let index = start; index < lines.length; index += 1) {
    depth += bracketDepthDelta(lines[index] ?? "");
    if (depth <= 0) {
      return index + 1;
    }
  }
  return lines.length;
}

/** Net `[`/`]` depth of a line, ignoring brackets inside strings and comments. */
function bracketDepthDelta(line: string): number {
  let delta = 0;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote !== undefined) {
      if (char === "\\" && quote === '"') {
        index += 1;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "#") {
      break;
    } else if (char === "[") {
      delta += 1;
    } else if (char === "]") {
      delta -= 1;
    }
  }
  return delta;
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
    case "aqi":
      lines.push(`city = ${quoteTomlString(widget.city)}`);
      if (widget.label !== undefined) {
        lines.push(`label = ${quoteTomlString(widget.label)}`);
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
