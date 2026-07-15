import { join } from "node:path";
import { type ExternalCommandRunner, runExternalCommand } from "@station/runtime";
import type { SetupTmuxBindingFact } from "../model.js";
import type { SetupFileSystemReader } from "./config.js";
import { setupProbeTimeoutMs } from "./constants.js";

export const tmuxPopupBindingMarker = "# >>> station popup binding >>>";
export const tmuxPopupBindingEndMarker = "# <<< station popup binding <<<";

const defaultBindingKey = "Space";
const bindingEditComment = "# Change Space to any tmux key; stn setup preserves it.";
const supportedBindingKeyPattern =
  /^(?:[A-Za-z0-9]|Space|F(?:[1-9]|1[0-2])|[CM]-(?:[A-Za-z0-9]|Space|F(?:[1-9]|1[0-2])))$/;
const quotedShellValuePattern = /^'[^']*'(?:\\''[^']*')*$/;

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
  if (!isSupportedBindingKey(bindingKey)) {
    throw new Error(`Unsupported tmux popup binding key: ${bindingKey}`);
  }
  const runShellCommand = options.runShellCommand ?? tmuxPopupRunShellCommand(launcherCommand);
  return `bind-key ${bindingKey} run-shell -b ${quoteShellValue(runShellCommand)}`;
}

export function tmuxPopupRunShellCommand(launcherCommand = "stn-tmux-popup"): string {
  return `env STATION_FOCUS_PROVIDER=tmux STATION_FOCUS_CLIENT_ID=#{q:client_name} ${quoteShellValue(escapeTmuxFormat(launcherCommand))}`;
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
  if (source === undefined) {
    return { status: "absent", bindingKey: defaultBindingKey };
  }

  const lines = source.split(/\r?\n/);
  const startLines = markerLineIndexes(lines, tmuxPopupBindingMarker);
  const endLines = markerLineIndexes(lines, tmuxPopupBindingEndMarker);
  if (startLines.length === 0 && endLines.length === 0) {
    return { status: "absent", bindingKey: defaultBindingKey };
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

  const start = startLines[0].index;
  const end = endLines[0].index;
  const activeLines = lines
    .slice(start + 1, end)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (activeLines.length === 0) {
    return { status: "absent", bindingKey: defaultBindingKey };
  }
  if (activeLines.length !== 1) {
    return bindingConflict(
      "tmux popup binding block contains multiple active lines; edit ~/.tmux.conf manually before rerunning stn setup.",
    );
  }

  const activeLine = activeLines[0];
  if (activeLine === undefined) {
    return { status: "absent", bindingKey: defaultBindingKey };
  }
  const parsed = /^bind-key(?:\s+-T\s+(\S+))?\s+(\S+)\s+run-shell\s+-b\s+(.+)$/.exec(activeLine);
  if (parsed === null) {
    return bindingConflict(
      "tmux popup binding block has an unsupported selector; edit ~/.tmux.conf manually before rerunning stn setup.",
    );
  }
  const [, table, bindingKey, quotedRunShellCommand] = parsed;
  if (
    (table !== undefined && table !== "prefix") ||
    bindingKey === undefined ||
    !isSupportedBindingKey(bindingKey) ||
    quotedRunShellCommand === undefined ||
    !quotedShellValuePattern.test(quotedRunShellCommand)
  ) {
    return bindingConflict(
      "tmux popup binding block has an unsupported selector; edit ~/.tmux.conf manually before rerunning stn setup.",
    );
  }
  return { status: "binding", bindingKey, quotedRunShellCommand };
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

function isSupportedBindingKey(value: string): boolean {
  return supportedBindingKeyPattern.test(value);
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
}): Promise<"loaded" | "missing" | "unknown"> {
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
    if (!hasLiveTmuxBinding(listed.stdout, input.bindingKey, input.runShellCommand)) {
      return "missing";
    }
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

function hasLiveTmuxBinding(source: string, bindingKey: string, runShellCommand: string): boolean {
  return source.split(/\r?\n/).some((line) => {
    const match = /^bind-key\s+-T\s+prefix\s+(\S+)\s+(.*)$/.exec(line.trim());
    return match?.[1] === bindingKey && parseListedRunShellCommand(match[2]) === runShellCommand;
  });
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
