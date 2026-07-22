import { parse } from "smol-toml";
import { z } from "zod";
import { loadConfigFromToml } from "../load/index.js";

export type SetHarnessInstallHooksInTomlOptions = {
  harness: string;
  installHooks: boolean;
  configPath?: string;
  homeDir?: string;
};

type StringState = "normal" | "basic" | "literal" | "multiline-basic" | "multiline-literal";

type TomlLine = {
  start: number;
  contentEnd: number;
  end: number;
  code?: string;
};

const HEADER_SENTINEL = "__station_setup_install_hooks_table__";
const InstallHooksAssignmentSchema = z.object({ install_hooks: z.boolean() }).strict();

export type HarnessConfigMutationError = Error & {
  tag: "HarnessConfigMutationError";
  code: "HARNESS_CONFIG_BLOCK_NOT_FOUND" | "HARNESS_CONFIG_MUTATION_INVALID";
};

/**
 * Updates one harness hook flag without reserializing TOML or changing unrelated source.
 * The candidate is accepted only when the canonical config loader observes the requested value.
 */
export async function setHarnessInstallHooksInToml(
  source: string,
  options: SetHarnessInstallHooksInTomlOptions,
): Promise<string> {
  const lines = scanTomlLines(source);
  const tableStart = lines.findIndex((line) => {
    return line.code !== undefined && isHarnessTableHeader(line.code, options.harness);
  });
  if (tableStart === -1) {
    throw harnessConfigMutationError(
      "HARNESS_CONFIG_BLOCK_NOT_FOUND",
      `Could not find the harness.${options.harness} table in config.toml.`,
    );
  }

  const tableEnd = nextTableLine(lines, tableStart + 1);
  let candidate = source;
  const assignment = findInstallHooksAssignment(lines, tableStart + 1, tableEnd);
  if (assignment !== undefined) {
    candidate = `${source.slice(0, assignment.valueStart)}${options.installHooks ? "true" : "false"}${source.slice(assignment.valueEnd)}`;
  } else {
    const header = lines[tableStart];
    if (header === undefined) {
      throw harnessConfigMutationError(
        "HARNESS_CONFIG_BLOCK_NOT_FOUND",
        `Could not find the harness.${options.harness} table in config.toml.`,
      );
    }
    const headerHasNewline = header.end > header.contentEnd;
    const newline = headerHasNewline
      ? source.slice(header.contentEnd, header.end)
      : preferredNewline(source);
    const insertion = headerHasNewline
      ? `install_hooks = ${options.installHooks ? "true" : "false"}${newline}`
      : `${newline}install_hooks = ${options.installHooks ? "true" : "false"}`;
    candidate = `${source.slice(0, header.end)}${insertion}${source.slice(header.end)}`;
  }

  const loadOptions: { configPath?: string; homeDir?: string } = {};
  if (options.configPath !== undefined) loadOptions.configPath = options.configPath;
  if (options.homeDir !== undefined) loadOptions.homeDir = options.homeDir;
  const loaded = await loadConfigFromToml(candidate, loadOptions);
  if (loaded.config.harness?.[options.harness]?.installHooks !== options.installHooks) {
    throw harnessConfigMutationError(
      "HARNESS_CONFIG_MUTATION_INVALID",
      `Could not set install_hooks in the harness.${options.harness} table.`,
    );
  }
  return candidate;
}

function scanTomlLines(source: string): TomlLine[] {
  const lines: TomlLine[] = [];
  let offset = 0;
  let state: StringState = "normal";
  while (offset < source.length) {
    const newlineIndex = source.indexOf("\n", offset);
    const end = newlineIndex === -1 ? source.length : newlineIndex + 1;
    const contentEnd =
      newlineIndex === -1
        ? end
        : source[newlineIndex - 1] === "\r"
          ? newlineIndex - 1
          : newlineIndex;
    const content = source.slice(offset, contentEnd);
    const scanned = scanTomlLine(content, state);
    const line: TomlLine = { start: offset, contentEnd, end };
    if (scanned.code !== undefined) line.code = scanned.code;
    lines.push(line);
    state = scanned.state;
    offset = end;
  }
  return lines;
}

function scanTomlLine(
  line: string,
  initialState: StringState,
): { state: StringState; code?: string } {
  let state = initialState;
  const startsInMultiline = state === "multiline-basic" || state === "multiline-literal";
  let commentStart: number | undefined;
  for (let index = 0; index < line.length; index += 1) {
    if (state === "normal") {
      if (line[index] === "#") {
        commentStart = index;
        break;
      }
      if (line.startsWith('"""', index)) {
        state = "multiline-basic";
        index += 2;
      } else if (line.startsWith("'''", index)) {
        state = "multiline-literal";
        index += 2;
      } else if (line[index] === '"') {
        state = "basic";
      } else if (line[index] === "'") {
        state = "literal";
      }
      continue;
    }
    if (state === "basic") {
      if (line[index] === "\\") index += 1;
      else if (line[index] === '"') state = "normal";
      continue;
    }
    if (state === "literal") {
      if (line[index] === "'") state = "normal";
      continue;
    }
    if (state === "multiline-basic") {
      if (line[index] === "\\") index += 1;
      else if (line.startsWith('"""', index)) {
        index = endQuoteRun(line, index, '"') - 1;
        state = "normal";
      }
      continue;
    }
    if (line.startsWith("'''", index)) {
      index = endQuoteRun(line, index, "'") - 1;
      state = "normal";
    }
  }
  if (startsInMultiline) return { state };
  return { state, code: line.slice(0, commentStart) };
}

function nextTableLine(lines: readonly TomlLine[], start: number): number {
  for (let index = start; index < lines.length; index += 1) {
    const code = lines[index]?.code;
    if (code !== undefined && parseAnyTableHeader(code)) return index;
  }
  return lines.length;
}

function findInstallHooksAssignment(
  lines: readonly TomlLine[],
  start: number,
  end: number,
): { valueStart: number; valueEnd: number } | undefined {
  for (let index = start; index < end; index += 1) {
    const line = lines[index];
    if (line?.code === undefined) continue;
    const equals = topLevelEquals(line.code);
    if (equals === -1) continue;
    try {
      if (!InstallHooksAssignmentSchema.safeParse(parse(line.code)).success) continue;
    } catch {
      continue;
    }
    const value = booleanValueRange(line.code, equals + 1);
    if (value === undefined) continue;
    return {
      valueStart: line.start + value.start,
      valueEnd: line.start + value.end,
    };
  }
  return undefined;
}

function parseAnyTableHeader(code: string): boolean {
  const trimmed = code.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return false;
  try {
    parse(`${trimmed}\n${HEADER_SENTINEL} = true`);
    return true;
  } catch {
    return false;
  }
}

function isHarnessTableHeader(code: string, harness: string): boolean {
  const trimmed = code.trim();
  if (!trimmed.startsWith("[") || trimmed.startsWith("[[") || !trimmed.endsWith("]")) {
    return false;
  }
  try {
    const schema = z
      .object({
        harness: z
          .object({
            [harness]: z.object({ [HEADER_SENTINEL]: z.literal(true) }).passthrough(),
          })
          .passthrough(),
      })
      .passthrough();
    return schema.safeParse(parse(`${trimmed}\n${HEADER_SENTINEL} = true`)).success;
  } catch {
    return false;
  }
}

function topLevelEquals(input: string): number {
  let state: "normal" | "basic" | "literal" = "normal";
  for (let index = 0; index < input.length; index += 1) {
    if (state === "normal") {
      if (input[index] === "=") return index;
      if (input[index] === '"') state = "basic";
      else if (input[index] === "'") state = "literal";
    } else if (state === "basic") {
      if (input[index] === "\\") index += 1;
      else if (input[index] === '"') state = "normal";
    } else if (input[index] === "'") {
      state = "normal";
    }
  }
  return -1;
}

function booleanValueRange(
  input: string,
  start: number,
): { start: number; end: number } | undefined {
  let valueStart = start;
  while (input[valueStart] === " " || input[valueStart] === "\t") valueStart += 1;
  const value = input.startsWith("true", valueStart)
    ? "true"
    : input.startsWith("false", valueStart)
      ? "false"
      : undefined;
  if (value === undefined) return undefined;
  const valueEnd = valueStart + value.length;
  return input.slice(valueEnd).trim().length === 0
    ? { start: valueStart, end: valueEnd }
    : undefined;
}

function endQuoteRun(input: string, start: number, quote: '"' | "'"): number {
  let end = start;
  while (input[end] === quote) end += 1;
  return end;
}

function preferredNewline(source: string): "\n" | "\r\n" {
  return source.includes("\r\n") ? "\r\n" : "\n";
}

function harnessConfigMutationError(
  code: "HARNESS_CONFIG_BLOCK_NOT_FOUND" | "HARNESS_CONFIG_MUTATION_INVALID",
  message: string,
): HarnessConfigMutationError {
  const error = new Error(message) as HarnessConfigMutationError;
  error.name = "HarnessConfigMutationError";
  error.tag = "HarnessConfigMutationError";
  error.code = code;
  return error;
}
