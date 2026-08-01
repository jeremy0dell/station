import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type ProviderHookArtifactOwner,
  ProviderHookArtifactOwnerSchema,
  type ProviderHookArtifactOwnership,
  type ProviderId,
} from "@station/contracts";
import type { StationBuildInfo } from "./buildInfo.js";
import {
  pathExists,
  readTextFileIfPresent,
  removeFileIfPresent,
  replaceTextFile,
} from "./files.js";

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
  artifactOwner?: ProviderHookArtifactOwner;
  takeover?: boolean;
};

export const PROVIDER_HOOK_OWNER_MARKER = "station-provider-artifact-owner:v1:";

export class ProviderHookArtifactOwnershipError extends Error {
  readonly tag = "ProviderHookArtifactOwnershipError";
  readonly code = "PROVIDER_HOOK_OWNERSHIP_CONFLICT";
  readonly provider: ProviderId;
  readonly action: "install" | "uninstall";
  readonly artifactPath: string;
  readonly ownership: Extract<
    ProviderHookArtifactOwnership,
    { status: "different-owner" | "unknown-owner" }
  >;

  constructor(input: {
    provider: ProviderId;
    action: "install" | "uninstall";
    artifactPath: string;
    ownership: Extract<
      ProviderHookArtifactOwnership,
      { status: "different-owner" | "unknown-owner" }
    >;
  }) {
    super(`Provider hook artifact ownership conflicts at ${input.artifactPath}.`);
    this.name = this.tag;
    this.provider = input.provider;
    this.action = input.action;
    this.artifactPath = input.artifactPath;
    this.ownership = input.ownership;
  }
}

export function providerHookArtifactOwner(
  launcher: string,
  buildInfo: StationBuildInfo,
): ProviderHookArtifactOwner {
  return ProviderHookArtifactOwnerSchema.parse({
    schemaVersion: 1,
    launcher: resolve(launcher),
    runtimeKind: buildInfo.compiled ? "compiled" : "source",
    version: buildInfo.version,
    buildIdentity: buildInfo.buildIdentity,
  });
}

export function providerHookOwnerMarker(owner: ProviderHookArtifactOwner): string {
  const encoded = Buffer.from(
    JSON.stringify(ProviderHookArtifactOwnerSchema.parse(owner)),
    "utf8",
  ).toString("base64url");
  return `${PROVIDER_HOOK_OWNER_MARKER}${encoded}`;
}

export function parseProviderHookOwnerMarker(
  contents: string,
): ProviderHookArtifactOwner | undefined {
  const markerIndex = contents.indexOf(PROVIDER_HOOK_OWNER_MARKER);
  if (markerIndex < 0) return undefined;
  const encoded = contents
    .slice(markerIndex + PROVIDER_HOOK_OWNER_MARKER.length)
    .match(/^[A-Za-z0-9_-]+/u)?.[0];
  if (encoded === undefined) return undefined;
  try {
    return ProviderHookArtifactOwnerSchema.parse(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
    );
  } catch {
    return undefined;
  }
}

/**
 * POLICY
 *
 * Uses the canonical launcher path as the durable owner key so upgrades at one installed
 * location remain automatic. Only a valid marker establishes ownership; unmarked or malformed
 * artifacts require explicit takeover.
 */
export function classifyProviderHookArtifactOwnership(input: {
  contents: string;
  requested: ProviderHookArtifactOwner;
}): ProviderHookArtifactOwnership {
  if (input.contents.trim().length === 0) {
    return { status: "absent", requested: input.requested };
  }
  const current = parseProviderHookOwnerMarker(input.contents);
  if (current === undefined) {
    return { status: "unknown-owner", requested: input.requested };
  }
  const currentLauncher = current.launcher;
  if (resolve(currentLauncher) === resolve(input.requested.launcher)) {
    return { status: "same-owner", requested: input.requested, currentLauncher };
  }
  return {
    status: "different-owner",
    requested: input.requested,
    currentLauncher,
    current,
  };
}

export function assertProviderHookArtifactOwnership(input: {
  provider: ProviderId;
  action: "install" | "uninstall";
  artifactPath: string;
  contents: string;
  requested?: ProviderHookArtifactOwner;
  takeover?: boolean;
}): ProviderHookArtifactOwnership | undefined {
  if (input.requested === undefined) return undefined;
  const ownership = classifyProviderHookArtifactOwnership({
    contents: input.contents,
    requested: input.requested,
  });
  if (
    input.takeover !== true &&
    (ownership.status === "different-owner" || ownership.status === "unknown-owner")
  ) {
    throw new ProviderHookArtifactOwnershipError({
      provider: input.provider,
      action: input.action,
      artifactPath: input.artifactPath,
      ownership,
    });
  }
  return ownership;
}

export type ConfigScriptHookPlan<Document, EventName extends string> = {
  before: string;
  after: string;
  document: Document;
  commands: Record<EventName, string>;
  missing: EventName[];
  configChanged: boolean;
  scriptChanged: boolean;
  changed: boolean;
  ownership?: ProviderHookArtifactOwnership;
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
    await replaceTextFile({ path, contents, mode, directoryMode: 0o700 });
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

  const backupPath = `${path}.bak.${new Date().toISOString().replaceAll(/[^0-9]/g, "")}.${randomUUID()}`;
  try {
    await copyFile(path, backupPath, constants.COPYFILE_EXCL);
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
  if (options.artifactOwner !== undefined) {
    input.artifactOwner = options.artifactOwner;
  }
  if (options.takeover !== undefined) {
    input.takeover = options.takeover;
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
  // No station-env gate: sessions Station did not launch (plain `claude` or
  // `codex` in any terminal) still deliver, and the provider adapter decides
  // scope — the observer correlates env-less events by their payload cwd.
  return [
    "#!/usr/bin/env bash",
    ...(options.artifactOwner === undefined
      ? []
      : [`# ${providerHookOwnerMarker(options.artifactOwner)}`]),
    "set -euo pipefail",
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
  provider?: ProviderId;
  artifactOwner?: ProviderHookArtifactOwner;
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
  const ownership =
    input.provider === undefined || input.artifactOwner === undefined
      ? undefined
      : classifyProviderHookArtifactOwnership({
          contents: scriptBefore,
          requested: input.artifactOwner,
        });

  const result: ConfigScriptHookPlan<Document, EventName> = {
    before,
    after,
    document,
    commands,
    missing: input.missingEvents(document, commands),
    configChanged,
    scriptChanged,
    changed,
  };
  if (ownership !== undefined) result.ownership = ownership;
  return result;
}

export async function installConfigScriptHook(input: {
  configPath: string;
  hookScriptPath: string;
  after: string;
  expectedScript: string;
  configChanged: boolean;
  scriptChanged: boolean;
  fileOps: HookSetupFileOps;
  provider?: ProviderId;
  artifactOwner?: ProviderHookArtifactOwner;
  takeover?: boolean;
}): Promise<string | undefined> {
  if (input.provider !== undefined) {
    const currentScript = await input.fileOps.readOptionalFile(input.hookScriptPath);
    assertProviderHookArtifactOwnership({
      provider: input.provider,
      action: "install",
      artifactPath: input.hookScriptPath,
      contents: currentScript,
      ...(input.artifactOwner === undefined ? {} : { requested: input.artifactOwner }),
      ...(input.takeover === undefined ? {} : { takeover: input.takeover }),
    });
  }
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
  provider?: ProviderId;
  artifactOwner?: ProviderHookArtifactOwner;
  takeover?: boolean;
}): Promise<ConfigScriptHookUninstallPlan<Document, EventName>> {
  if (input.provider !== undefined) {
    const currentScript = await input.fileOps.readOptionalFile(input.hookScriptPath);
    assertProviderHookArtifactOwnership({
      provider: input.provider,
      action: "uninstall",
      artifactPath: input.hookScriptPath,
      contents: currentScript,
      ...(input.artifactOwner === undefined ? {} : { requested: input.artifactOwner }),
      ...(input.takeover === undefined ? {} : { takeover: input.takeover }),
    });
  }
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
  return args.map((arg) => shellQuote(arg)).join(" ");
}

export function shellQuote(value: string, force = false): string {
  return !force && /^[A-Za-z0-9_./:=@+-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}
