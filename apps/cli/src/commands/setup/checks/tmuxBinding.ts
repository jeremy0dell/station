import { join } from "node:path";
import { type ExternalCommandRunner, runExternalCommand } from "@station/runtime";
import { persistentUiOwnerClientOption } from "@station/tmux";
import type { SetupTmuxBindingFact } from "../adapters/inspectionTypes.js";
import type { SetupFileSystemReader } from "./config.js";
import { setupProbeTimeoutMs } from "./constants.js";

export const tmuxPopupBindingMarker = "# >>> station popup binding >>>";
export const tmuxPopupBindingEndMarker = "# <<< station popup binding <<<";

const defaultBindingKey = "Space";
const bindingEditComment = "# Change Space to any tmux key; stn setup preserves it.";
const supportedBindingKeyPattern =
  /^(?:[A-Za-z0-9]|Space|F(?:[1-9]|1[0-2])|[CM]-(?:[A-Za-z0-9]|Space|F(?:[1-9]|1[0-2])))$/;
const quotedShellValuePattern = /^'[^']*'(?:\\''[^']*')*$/;
// A popup binding runs through a nested tmux client, so prefer the renderer session's outer owner.
const popupFocusClientFormat = `#{?#{${persistentUiOwnerClientOption}},#{q:${persistentUiOwnerClientOption}},#{q:client_name}}`;

export type CheckSetupTmuxBindingOptions = {
  homeDir: string;
  env?: NodeJS.ProcessEnv;
  fs?: SetupFileSystemReader;
  launcherCommand?: string;
  runShellCommand?: string;
  runner?: ExternalCommandRunner;
  tmuxCommand?: string;
};

export type TmuxPopupBindingBlockOptions = {
  bindingKey?: string;
  runShellCommand?: string;
};

export function setupTmuxConfigPath(
  options: Pick<CheckSetupTmuxBindingOptions, "homeDir">,
): string {
  return join(options.homeDir, ".tmux.conf");
}

export async function checkSetupTmuxBinding(
  options: CheckSetupTmuxBindingOptions,
): Promise<SetupTmuxBindingFact> {
  const path = setupTmuxConfigPath(options);
  const fs = options.fs ?? nodeFsReader();
  const launcherCommand = options.launcherCommand ?? "stn-tmux-popup";
  const runShellCommand = options.runShellCommand ?? tmuxPopupRunShellCommand(launcherCommand);
  const insideTmux = (options.env ?? process.env).TMUX !== undefined;
  const persisted = parseOwnedBindingBlock(await readTmuxConfig(fs, path));

  if (persisted.status === "conflict") {
    return {
      status: "conflict",
      path,
      marker: tmuxPopupBindingMarker,
      launcherCommand,
      runShellCommand,
      insideTmux,
      liveStatus: "unknown",
      message: persisted.message,
    };
  }

  const bindingKey = persisted.bindingKey;
  const liveInput: Parameters<typeof checkLiveTmuxBinding>[0] = {
    insideTmux,
    bindingKey,
    launcherCommand,
    runShellCommand,
  };
  if (options.env !== undefined) liveInput.env = options.env;
  if (options.runner !== undefined) liveInput.runner = options.runner;
  if (options.tmuxCommand !== undefined) liveInput.tmuxCommand = options.tmuxCommand;
  const liveStatus = await checkLiveTmuxBinding(liveInput);
  if (liveStatus === "occupied") {
    return {
      status: "conflict",
      path,
      marker: tmuxPopupBindingMarker,
      launcherCommand,
      runShellCommand,
      insideTmux,
      liveStatus: "unknown",
      message: `tmux prefix + ${bindingKey} is already assigned by the current tmux server; setup will not replace it.`,
    };
  }

  if (
    persisted.status === "binding" &&
    persisted.quotedRunShellCommand === quoteShellValue(runShellCommand)
  ) {
    return {
      status: "ok",
      path,
      marker: tmuxPopupBindingMarker,
      launcherCommand,
      runShellCommand,
      bindingKey,
      insideTmux,
      liveStatus,
    };
  }

  return missingTmuxBinding({
    path,
    launcherCommand,
    runShellCommand,
    bindingKey,
    insideTmux,
    liveStatus,
    ...(persisted.status === "binding"
      ? {
          message: `tmux popup binding command is stale; rerun stn setup to update it while preserving ${bindingKey}.`,
        }
      : {}),
  });
}

export function tmuxPopupBindingBlock(
  launcherCommand = "stn-tmux-popup",
  options: TmuxPopupBindingBlockOptions = {},
): string {
  return [
    tmuxPopupBindingMarker,
    bindingEditComment,
    tmuxPopupBindingLine(launcherCommand, options),
    tmuxPopupBindingEndMarker,
    "",
  ].join("\n");
}

export function tmuxPopupBindingLine(
  launcherCommand = "stn-tmux-popup",
  options: TmuxPopupBindingBlockOptions = {},
): string {
  const bindingKey = options.bindingKey ?? defaultBindingKey;
  if (!supportedBindingKeyPattern.test(bindingKey)) {
    throw new Error(`Unsupported tmux popup binding key: ${bindingKey}`);
  }
  const runShellCommand = options.runShellCommand ?? tmuxPopupRunShellCommand(launcherCommand);
  return `bind-key ${bindingKey} run-shell -b ${quoteShellValue(runShellCommand)}`;
}

export function tmuxPopupRunShellCommand(
  launcherCommand = "stn-tmux-popup",
  configPath?: string,
): string {
  if (containsUnsafeShellValue(launcherCommand)) {
    throw new Error("tmux popup launcher contains an unsupported control character.");
  }
  if (configPath !== undefined && containsUnsafeShellValue(configPath)) {
    throw new Error("tmux popup config path contains an unsupported control character.");
  }
  const command = ["env"];
  if (configPath !== undefined) {
    command.push(
      `STATION_CONFIG_PATH=${quoteShellValue(escapeTmuxFormat(configPath))}`,
      "STATION_DISABLE_FAST_POPUP=1",
    );
  }
  command.push(
    "STATION_FOCUS_PROVIDER=tmux",
    `STATION_FOCUS_CLIENT_ID=${popupFocusClientFormat}`,
    quoteShellValue(escapeTmuxFormat(launcherCommand)),
  );
  if (configPath !== undefined) {
    command.push("--config", quoteShellValue(escapeTmuxFormat(configPath)));
  }
  return command.join(" ");
}

function containsUnsafeShellValue(value: string): boolean {
  return value.includes("\0") || value.includes("\r") || value.includes("\n");
}

function missingTmuxBinding(input: {
  path: string;
  launcherCommand: string;
  runShellCommand: string;
  bindingKey: string;
  insideTmux: boolean;
  liveStatus: "loaded" | "missing" | "unknown";
  message?: string;
}): SetupTmuxBindingFact {
  return {
    status: "missing",
    path: input.path,
    marker: tmuxPopupBindingMarker,
    launcherCommand: input.launcherCommand,
    runShellCommand: input.runShellCommand,
    bindingKey: input.bindingKey,
    insideTmux: input.insideTmux,
    liveStatus: input.liveStatus,
    message: input.message ?? "Optional tmux popup binding is not installed.",
  };
}

type ParsedOwnedBindingBlock =
  | { status: "absent"; bindingKey: typeof defaultBindingKey }
  | { status: "binding"; bindingKey: string; quotedRunShellCommand: string }
  | { status: "conflict"; message: string };

function parseOwnedBindingBlock(source: string | undefined): ParsedOwnedBindingBlock {
  if (source === undefined) return { status: "absent", bindingKey: defaultBindingKey };

  const lines = source.split(/\r?\n/);
  const startLines = markerLineIndexes(lines, tmuxPopupBindingMarker);
  const endLines = markerLineIndexes(lines, tmuxPopupBindingEndMarker);
  if (startLines.length === 0 && endLines.length === 0) {
    return absentManagedBinding({ lines });
  }
  if (
    startLines.length !== 1 ||
    endLines.length !== 1 ||
    startLines[0]?.exact !== true ||
    endLines[0]?.exact !== true ||
    (startLines[0]?.index ?? -1) >= (endLines[0]?.index ?? -1)
  ) {
    return bindingConflict(
      "tmux popup binding markers are duplicated or malformed; edit ~/.tmux.conf manually before rerunning stn setup.",
    );
  }
  return parseMarkedBinding({
    lines,
    ownedRange: { start: startLines[0].index, end: endLines[0].index },
  });
}

function parseMarkedBinding(input: {
  readonly lines: readonly string[];
  readonly ownedRange: { readonly start: number; readonly end: number };
}): ParsedOwnedBindingBlock {
  const activeLines = input.lines
    .slice(input.ownedRange.start + 1, input.ownedRange.end)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (activeLines.length === 0) return absentManagedBinding(input);
  if (activeLines.length !== 1) {
    return bindingConflict(
      "tmux popup binding block contains multiple active lines; edit ~/.tmux.conf manually before rerunning stn setup.",
    );
  }

  const parsed = /^bind-key(?:\s+-T\s+(\S+))?\s+(\S+)\s+run-shell\s+-b\s+(.+)$/.exec(
    activeLines[0] ?? "",
  );
  if (parsed === null) return unsupportedBindingConflict();
  const [, table, bindingKey, quotedRunShellCommand] = parsed;
  if (
    (table !== undefined && table !== "prefix") ||
    bindingKey === undefined ||
    !supportedBindingKeyPattern.test(bindingKey) ||
    quotedRunShellCommand === undefined ||
    !quotedShellValuePattern.test(quotedRunShellCommand)
  ) {
    return unsupportedBindingConflict();
  }
  if (
    hasConfiguredPrefixBinding({
      lines: input.lines,
      bindingKey,
      ownedRange: input.ownedRange,
    })
  ) {
    return bindingConflict(configuredKeyConflictMessage(bindingKey));
  }
  return { status: "binding", bindingKey, quotedRunShellCommand };
}

function absentManagedBinding(input: {
  readonly lines: readonly string[];
  readonly ownedRange?: { readonly start: number; readonly end: number };
}): ParsedOwnedBindingBlock {
  const configured =
    input.ownedRange === undefined
      ? hasConfiguredPrefixBinding({ lines: input.lines, bindingKey: defaultBindingKey })
      : hasConfiguredPrefixBinding({
          lines: input.lines,
          bindingKey: defaultBindingKey,
          ownedRange: input.ownedRange,
        });
  // A user-owned assignment wins over setup's fresh default key.
  return configured
    ? bindingConflict(configuredKeyConflictMessage(defaultBindingKey))
    : { status: "absent", bindingKey: defaultBindingKey };
}

function unsupportedBindingConflict(): ParsedOwnedBindingBlock {
  return bindingConflict(
    "tmux popup binding block has an unsupported selector; edit ~/.tmux.conf manually before rerunning stn setup.",
  );
}

function hasConfiguredPrefixBinding(input: {
  readonly lines: readonly string[];
  readonly bindingKey: string;
  readonly ownedRange?: { readonly start: number; readonly end: number };
}): boolean {
  let assigned = false;
  for (const [index, line] of input.lines.entries()) {
    if (
      input.ownedRange !== undefined &&
      index >= input.ownedRange.start &&
      index <= input.ownedRange.end
    ) {
      continue;
    }
    const action = directPrefixBindingAction({ line, bindingKey: input.bindingKey });
    if (action === "bind") assigned = true;
    if (action === "unbind") assigned = false;
  }
  return assigned;
}

const bindingCommands = new Set(["bind", "bind-key", "unbind", "unbind-key"]);
const bindCommands = new Set(["bind", "bind-key"]);

type TmuxBindingSelector = {
  readonly table: string;
  readonly key?: string;
  readonly unbindAll: boolean;
};

function directPrefixBindingAction(input: {
  readonly line: string;
  readonly bindingKey: string;
}): "bind" | "unbind" | undefined {
  const tokens = tmuxConfigTokens(input.line);
  const command = tokens[0] ?? "";
  if (!bindingCommands.has(command)) return undefined;

  const selector = tmuxBindingSelector(tokens.slice(1));
  if (selector.table !== "prefix") return undefined;
  const action = bindCommands.has(command) ? "bind" : "unbind";
  if (selector.key === input.bindingKey) return action;
  return action === "unbind" && selector.unbindAll ? "unbind" : undefined;
}

function tmuxBindingSelector(tokens: readonly string[]): TmuxBindingSelector {
  let table = "prefix";
  let unbindAll = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "-T") {
      table = tokens[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (token === "-N") {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      if (token.includes("n")) table = "root";
      if (token.includes("a")) unbindAll = true;
      continue;
    }
    return { table, key: token, unbindAll };
  }
  return { table, unbindAll };
}

function tmuxConfigTokens(line: string): readonly string[] {
  const tokens = line.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s#]+|#.*/g) ?? [];
  const commentIndex = tokens.findIndex((token) => token.startsWith("#"));
  return commentIndex < 0 ? tokens : tokens.slice(0, commentIndex);
}

function configuredKeyConflictMessage(bindingKey: string): string {
  return `tmux prefix + ${bindingKey} is already assigned outside Station’s managed block; setup will not replace it.`;
}

function markerLineIndexes(
  lines: readonly string[],
  marker: string,
): Array<{ index: number; exact: boolean }> {
  const result: Array<{ index: number; exact: boolean }> = [];
  for (const [index, line] of lines.entries()) {
    if (line.includes(marker)) {
      result.push({ index, exact: line.trim() === marker });
    }
  }
  return result;
}

function bindingConflict(message: string): ParsedOwnedBindingBlock {
  return { status: "conflict", message };
}

async function readTmuxConfig(
  fs: SetupFileSystemReader,
  path: string,
): Promise<string | undefined> {
  try {
    return await fs.readFile(path);
  } catch {
    return undefined;
  }
}

async function checkLiveTmuxBinding(input: {
  env?: NodeJS.ProcessEnv;
  insideTmux: boolean;
  bindingKey: string;
  launcherCommand: string;
  runShellCommand: string;
  runner?: ExternalCommandRunner;
  tmuxCommand?: string;
}): Promise<"loaded" | "missing" | "unknown" | "occupied"> {
  if (!input.insideTmux) {
    return "unknown";
  }
  try {
    const listed = await runExternalCommand(
      {
        command: input.tmuxCommand ?? "tmux",
        args: ["list-keys", "-T", "prefix"],
        timeoutMs: setupProbeTimeoutMs,
        maxOutputChars: 32_768,
        ...(input.env === undefined ? {} : { env: envForExternalCommand(input.env) }),
      },
      input.runner,
    );
    const binding = classifyLiveTmuxBinding({
      source: listed.stdout,
      bindingKey: input.bindingKey,
      runShellCommand: input.runShellCommand,
    });
    if (binding === "occupied") return "occupied";
    // tmux ships prefix + Space as next-layout; setup may replace only that default action.
    if (binding !== "station") return "missing";
    const startup = await runExternalCommand(
      {
        command: input.tmuxCommand ?? "tmux",
        args: [
          "run-shell",
          `env STATION_SETUP_LAUNCHER_PROBE=1 ${quoteShellValue(escapeTmuxFormat(input.launcherCommand))} --help >/dev/null 2>&1`,
        ],
        allowedExitCodes: [0, 1, 126, 127],
        timeoutMs: setupProbeTimeoutMs,
        maxOutputChars: 4096,
        ...(input.env === undefined ? {} : { env: envForExternalCommand(input.env) }),
      },
      input.runner,
    );
    return startup.exitCode === 0 ? "loaded" : "missing";
  } catch {
    return "unknown";
  }
}

function classifyLiveTmuxBinding(input: {
  readonly source: string;
  readonly bindingKey: string;
  readonly runShellCommand: string;
}): "station" | "default" | "occupied" | "missing" {
  for (const line of input.source.split(/\r?\n/)) {
    const match = /^bind-key\s+-T\s+prefix\s+(\S+)\s+(.*)$/.exec(line.trim());
    if (match?.[1] !== input.bindingKey) continue;
    if (parseListedRunShellCommand(match[2]) === input.runShellCommand) return "station";
    return match[2]?.trim() === "next-layout" ? "default" : "occupied";
  }
  return "missing";
}

function parseListedRunShellCommand(value: string | undefined): string | undefined {
  const prefix = 'run-shell -b "';
  if (value === undefined || !value.startsWith(prefix) || !value.endsWith('"')) {
    return undefined;
  }
  const serialized = value.slice(prefix.length, -1);
  let command = "";
  for (let index = 0; index < serialized.length; index += 1) {
    const character = serialized[index];
    if (character !== "\\") {
      command += character;
      continue;
    }
    index += 1;
    const escaped = serialized[index];
    if (escaped !== "\\" && escaped !== '"' && escaped !== "$") return undefined;
    command += escaped;
  }
  return command;
}

function escapeTmuxFormat(value: string): string {
  return value.replaceAll("#", "##");
}

function quoteShellValue(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function envForExternalCommand(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function nodeFsReader(): SetupFileSystemReader {
  return {
    async readFile(path) {
      const { readFile } = await import("node:fs/promises");
      return readFile(path, "utf8");
    },
  };
}
