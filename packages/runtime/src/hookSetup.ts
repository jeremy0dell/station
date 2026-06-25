import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathExists, readTextFileIfPresent, removeFileIfPresent } from "./files.js";

export type HookSetupErrorFactory = (input: {
  operation: "read" | "metadata" | "backup" | "writeConfig" | "writeScript" | "remove";
  path: string;
  cause: unknown;
}) => Error;

export type HookSetupFileOps = {
  readOptionalFile: (path: string) => Promise<string>;
  writeHookConfig: (path: string, contents: string) => Promise<void>;
  writeHookScript: (path: string, contents: string) => Promise<void>;
  removeHookFileIfPresent: (path: string) => Promise<boolean>;
  backupIfPresent: (path: string) => Promise<string | undefined>;
};

export type ProviderHookScriptOptions = {
  hookScriptPath?: string;
  stationConfigPath?: string;
  observerSocketPath?: string;
  stateDir?: string;
  hookSpoolDir?: string;
  autoStartFromHooks?: boolean;
  hookBin?: string;
};

export type ConfigScriptHookPlan<Document, EventName extends string> = {
  before: string;
  after: string;
  document: Document;
  commands: Record<EventName, string>;
  missing: EventName[];
  configChanged: boolean;
  scriptChanged: boolean;
  changed: boolean;
};

export type ConfigScriptHookUninstallPlan<Document, EventName extends string> = {
  before: string;
  after: string;
  document: Document;
  commands: Record<EventName, string>;
  missing: EventName[];
  configChanged: boolean;
  scriptRemoved: boolean;
  changed: boolean;
  backupPath?: string;
};

function providerHookCommandLineFromScriptArgs(
  provider: string,
  options: ProviderHookScriptOptions,
): string {
  return [
    shellQuote(options.hookBin ?? "stn-ingress"),
    guardedArrayExpansion("SOCKET_ARG"),
    guardedArrayExpansion("STATE_DIR_ARG"),
    guardedArrayExpansion("SPOOL_DIR_ARG"),
    guardedArrayExpansion("CONFIG_ARG"),
    ...(options.autoStartFromHooks === false ? ["--no-auto-start"] : []),
    shellQuote(provider),
  ].join(" ");
}

function guardedArrayExpansion(name: string): string {
  return ["$", `{${name}[@]+"`, "$", `{${name}[@]}"}`].join("");
}

function dynamicHookArg(
  name: string,
  envName: string,
  flag: string,
  fallback: string | undefined,
  options: { skipFallbackWhenEnvPresent?: string } = {},
): string[] {
  const lines = [
    `${name}=()`,
    `if [ -n "\${${envName}:-}" ]; then`,
    `  ${name}=(${flag} "$${envName}")`,
  ];
  if (fallback !== undefined) {
    if (options.skipFallbackWhenEnvPresent !== undefined) {
      lines.push(`elif [ -z "\${${options.skipFallbackWhenEnvPresent}:-}" ]; then`);
    } else {
      lines.push("else");
    }
    lines.push(`  ${name}=(${flag} ${shellQuote(fallback)})`);
  }
  lines.push("fi");
  return lines;
}

async function readOptionalHookFile(
  path: string,
  createError: HookSetupErrorFactory,
): Promise<string> {
  try {
    return (await readTextFileIfPresent(path)) ?? "";
  } catch (cause) {
    throw createError({ operation: "read", path, cause });
  }
}

async function writeHookFile(
  path: string,
  contents: string,
  mode: number,
  createError: HookSetupErrorFactory,
): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, contents, { mode });
    if (mode === 0o700) {
      await chmod(path, mode);
    }
  } catch (cause) {
    throw createError({
      operation: mode === 0o700 ? "writeScript" : "writeConfig",
      path,
      cause,
    });
  }
}

async function removeHookFile(path: string, createError: HookSetupErrorFactory): Promise<boolean> {
  try {
    return await removeFileIfPresent(path);
  } catch (cause) {
    throw createError({ operation: "remove", path, cause });
  }
}

async function backupHookFile(
  path: string,
  createError: HookSetupErrorFactory,
): Promise<string | undefined> {
  try {
    if (!(await pathExists(path))) {
      return undefined;
    }
  } catch (cause) {
    throw createError({ operation: "metadata", path, cause });
  }

  const backupPath = `${path}.bak.${new Date().toISOString().replaceAll(/[^0-9]/g, "")}`;
  try {
    await copyFile(path, backupPath);
  } catch (cause) {
    throw createError({ operation: "backup", path, cause });
  }
  return backupPath;
}

export function createHookSetupFileOps(createError: HookSetupErrorFactory): HookSetupFileOps {
  return {
    readOptionalFile: (path) => readOptionalHookFile(path, createError),
    writeHookConfig: (path, contents) => writeHookFile(path, contents, 0o600, createError),
    writeHookScript: (path, contents) => writeHookFile(path, contents, 0o700, createError),
    removeHookFileIfPresent: (path) => removeHookFile(path, createError),
    backupIfPresent: (path) => backupHookFile(path, createError),
  };
}

export function providerHookCommandArgs(
  provider: string,
  options: ProviderHookScriptOptions = {},
  event?: string,
): string[] {
  const hookArgs = [options.hookBin ?? "stn-ingress"];
  if (options.observerSocketPath !== undefined) {
    hookArgs.push("--socket", options.observerSocketPath);
  }
  if (options.stateDir !== undefined) {
    hookArgs.push("--state-dir", options.stateDir);
  }
  if (options.hookSpoolDir !== undefined) {
    hookArgs.push("--spool-dir", options.hookSpoolDir);
  }
  if (options.stationConfigPath !== undefined) {
    hookArgs.push("--config", options.stationConfigPath);
  }
  if (options.autoStartFromHooks === false) {
    hookArgs.push("--no-auto-start");
  }
  hookArgs.push(provider);
  if (event !== undefined) {
    hookArgs.push(event);
  }
  return hookArgs;
}

export function providerHookCommandLine(
  provider: string,
  options: ProviderHookScriptOptions = {},
  event?: string,
): string {
  return commandLine(providerHookCommandArgs(provider, options, event));
}

export function providerHookScriptOptions(
  hookScriptPath: string,
  options: ProviderHookScriptOptions = {},
): ProviderHookScriptOptions & { hookScriptPath: string } {
  const input: ProviderHookScriptOptions & { hookScriptPath: string } = { hookScriptPath };
  if (options.stationConfigPath !== undefined) {
    input.stationConfigPath = options.stationConfigPath;
  }
  if (options.observerSocketPath !== undefined) {
    input.observerSocketPath = options.observerSocketPath;
  }
  if (options.stateDir !== undefined) {
    input.stateDir = options.stateDir;
  }
  if (options.hookSpoolDir !== undefined) {
    input.hookSpoolDir = options.hookSpoolDir;
  }
  if (options.autoStartFromHooks !== undefined) {
    input.autoStartFromHooks = options.autoStartFromHooks;
  }
  if (options.hookBin !== undefined) {
    input.hookBin = options.hookBin;
  }
  return input;
}

export function expectedProviderHookScript(input: {
  provider: string;
  options?: ProviderHookScriptOptions;
  ignoreFailure?: boolean;
  redirectStderr?: boolean;
}): string {
  const suffix = input.ignoreFailure === true ? " || true" : "";
  const redirect = input.redirectStderr === true ? " > /dev/null 2>&1" : " > /dev/null";
  const options = input.options ?? {};
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `if [ -z "\${STATION_SESSION_ID:-}" ] || [ -z "\${STATION_WORKTREE_ID:-}" ]; then`,
    "  exit 0",
    "fi",
    ...dynamicHookArg(
      "SOCKET_ARG",
      "STATION_OBSERVER_SOCKET_PATH",
      "--socket",
      options.observerSocketPath,
    ),
    ...dynamicHookArg("CONFIG_ARG", "STATION_CONFIG_PATH", "--config", options.stationConfigPath),
    ...dynamicHookArg("STATE_DIR_ARG", "STATION_STATE_DIR", "--state-dir", options.stateDir, {
      skipFallbackWhenEnvPresent: "STATION_CONFIG_PATH",
    }),
    ...dynamicHookArg(
      "SPOOL_DIR_ARG",
      "STATION_HOOK_SPOOL_DIR",
      "--spool-dir",
      options.hookSpoolDir,
      { skipFallbackWhenEnvPresent: "STATION_CONFIG_PATH" },
    ),
    `${providerHookCommandLineFromScriptArgs(input.provider, options)}${redirect}${suffix}`,
    "",
  ].join("\n");
}

export function providerHookScriptRoutesByStationEnv(script: string, provider: string): boolean {
  return (
    script.includes(
      `if [ -z "\${STATION_SESSION_ID:-}" ] || [ -z "\${STATION_WORKTREE_ID:-}" ]; then`,
    ) &&
    script.includes("STATION_OBSERVER_SOCKET_PATH") &&
    script.includes("STATION_CONFIG_PATH") &&
    script.includes("STATION_STATE_DIR") &&
    script.includes("STATION_HOOK_SPOOL_DIR") &&
    script.includes(`${shellQuote(provider)} > /dev/null`)
  );
}

export function hookCommandsForEvents<EventName extends string>(
  eventNames: readonly EventName[],
  hookScriptPath: string,
): Record<EventName, string> {
  return Object.fromEntries(eventNames.map((eventName) => [eventName, hookScriptPath])) as Record<
    EventName,
    string
  >;
}

export async function planConfigScriptHook<Document, EventName extends string>(input: {
  readOptionalFile: (path: string) => Promise<string>;
  configPath: string;
  hookScriptPath: string;
  parseDocument: (source: string) => Document;
  installCommands: (document: Document, commands: Record<EventName, string>) => Document;
  stringifyDocument: (document: Document) => string;
  missingEvents: (document: Document, commands: Record<EventName, string>) => EventName[];
  expectedCommands: (hookScriptPath: string) => Record<EventName, string>;
  expectedScript: string;
  extraChanged?: boolean;
}): Promise<ConfigScriptHookPlan<Document, EventName>> {
  const before = await input.readOptionalFile(input.configPath);
  const document = input.parseDocument(before);
  const commands = input.expectedCommands(input.hookScriptPath);
  const afterDocument = input.installCommands(document, commands);
  const after = input.stringifyDocument(afterDocument);
  const scriptBefore = await input.readOptionalFile(input.hookScriptPath);
  const configChanged = before.trim() !== after.trim();
  const scriptChanged = scriptBefore !== input.expectedScript;
  const changed = configChanged || scriptChanged || input.extraChanged === true;

  return {
    before,
    after,
    document,
    commands,
    missing: input.missingEvents(document, commands),
    configChanged,
    scriptChanged,
    changed,
  };
}

export async function installConfigScriptHook(input: {
  configPath: string;
  hookScriptPath: string;
  after: string;
  expectedScript: string;
  configChanged: boolean;
  scriptChanged: boolean;
  fileOps: HookSetupFileOps;
}): Promise<string | undefined> {
  let backupPath: string | undefined;
  if (input.configChanged) {
    backupPath = await input.fileOps.backupIfPresent(input.configPath);
    await input.fileOps.writeHookConfig(input.configPath, input.after);
  }
  if (input.scriptChanged) {
    await input.fileOps.writeHookScript(input.hookScriptPath, input.expectedScript);
  }
  return backupPath;
}

export async function uninstallConfigScriptHook<Document, EventName extends string>(input: {
  readOptionalFile: (path: string) => Promise<string>;
  configPath: string;
  hookScriptPath: string;
  parseDocument: (source: string) => Document;
  removeCommands: (document: Document, commands: Record<EventName, string>) => Document;
  stringifyDocument: (document: Document) => string;
  missingEvents: (document: Document, commands: Record<EventName, string>) => EventName[];
  documentContainsCommand: (document: Document, command: string) => boolean;
  expectedCommands: (hookScriptPath: string) => Record<EventName, string>;
  fileOps: HookSetupFileOps;
}): Promise<ConfigScriptHookUninstallPlan<Document, EventName>> {
  const before = await input.readOptionalFile(input.configPath);
  const document = input.parseDocument(before);
  const commands = input.expectedCommands(input.hookScriptPath);
  const afterDocument = input.removeCommands(document, commands);
  const after = input.stringifyDocument(afterDocument);
  const configChanged = before.trim() !== after.trim();
  let backupPath: string | undefined;
  if (configChanged) {
    backupPath = await input.fileOps.backupIfPresent(input.configPath);
    await input.fileOps.writeHookConfig(input.configPath, after);
  }
  const scriptStillNeeded = input.documentContainsCommand(afterDocument, input.hookScriptPath);
  const scriptRemoved = scriptStillNeeded
    ? false
    : await input.fileOps.removeHookFileIfPresent(input.hookScriptPath);
  const result: ConfigScriptHookUninstallPlan<Document, EventName> = {
    before,
    after,
    document: afterDocument,
    commands,
    missing: input.missingEvents(afterDocument, commands),
    configChanged,
    scriptRemoved,
    changed: configChanged || scriptRemoved,
  };
  if (backupPath !== undefined) {
    result.backupPath = backupPath;
  }
  return result;
}

export function assignBackupPaths(
  target: { backupPath?: string; backupPaths?: string[] },
  paths: readonly (string | undefined)[],
): void {
  const backupPaths = paths.filter((path): path is string => path !== undefined);
  if (backupPaths.length === 0) {
    return;
  }
  const first = backupPaths[0];
  if (first === undefined) {
    return;
  }
  target.backupPath = first;
  target.backupPaths = backupPaths;
}

export function commandLine(args: readonly string[]): string {
  return args.map(shellQuote).join(" ");
}

export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
