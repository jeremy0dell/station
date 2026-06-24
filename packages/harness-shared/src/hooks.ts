import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathExists, readTextFileIfPresent, removeFileIfPresent } from "@station/runtime";

export type HookFileErrorFactory = (code: string, message: string, cause?: unknown) => Error;

export type HookFileCodes = {
  unreadable: string;
  writeFailed: string;
};

export type HookFileMessages = {
  configUnreadable: string;
  configMetadataUnreadable: string;
  configWriteFailed: string;
  scriptWriteFailed: string;
  scriptRemoveFailed: string;
  backupWriteFailed: string;
};

export type HookFileOps = {
  readOptionalFile(path: string): Promise<string>;
  writeHookConfig(path: string, contents: string): Promise<void>;
  writeHookScript(path: string, contents: string): Promise<void>;
  removeHookScriptIfPresent(path: string): Promise<boolean>;
  backupIfPresent(path: string): Promise<string | undefined>;
};

export type IngressHookScriptOptions = {
  stationConfigPath?: string;
  observerSocketPath?: string;
  stateDir?: string;
  hookSpoolDir?: string;
  autoStartFromHooks?: boolean;
  hookBin?: string;
};

export type NestedHookDocument = Record<string, unknown>;

export type NestedHookDocumentSpec<TName extends string> = {
  eventNames: readonly TName[];
  generatedScriptName: string;
  statusMessage: string;
  matcherForEvent?: (eventName: TName) => string | undefined;
  timeout?: number;
};

function nestedHooksRecord(document: NestedHookDocument): Record<string, unknown> | undefined {
  return isPlainRecord(document.hooks) ? document.hooks : undefined;
}

function nestedHookEntries(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => (isPlainRecord(entry) ? [entry] : []));
  }
  return isPlainRecord(value) ? [value] : [];
}

function cloneRecord(source: Record<string, unknown>): Record<string, unknown> {
  const cloned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) cloned[key] = value;
  return cloned;
}

function generatedNestedHookEntry<TName extends string>(
  eventName: TName,
  command: string,
  spec: NestedHookDocumentSpec<TName>,
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    hooks: [
      {
        type: "command",
        command,
        timeout: spec.timeout ?? 30,
        statusMessage: spec.statusMessage,
      },
    ],
  };
  const matcher = spec.matcherForEvent?.(eventName);
  if (matcher !== undefined) entry.matcher = matcher;
  return entry;
}

function withGeneratedNestedHookEntry<TName extends string>(
  value: unknown,
  eventName: TName,
  command: string,
  spec: NestedHookDocumentSpec<TName>,
): unknown {
  const cleanedValue = withoutGeneratedNestedHookEntry(value, command, spec);
  const entries = nestedHookEntries(cleanedValue);
  if (entries.some((entry) => nestedHookEntryContainsCommand(entry, command))) return entries;
  return [...entries, generatedNestedHookEntry(eventName, command, spec)];
}

function withoutGeneratedNestedHookEntry<TName extends string>(
  value: unknown,
  command: string | undefined,
  spec: NestedHookDocumentSpec<TName>,
): unknown {
  const entries = nestedHookEntries(value);
  if (value !== undefined && entries.length === 0) return value;
  const nextEntries = entries
    .map((entry) => withoutGeneratedHooksFromNestedEntry(entry, command, spec))
    .filter((entry) => entry !== undefined);
  return nextEntries.length === 0 ? undefined : nextEntries;
}

function withoutGeneratedHooksFromNestedEntry<TName extends string>(
  entry: Record<string, unknown>,
  command: string | undefined,
  spec: NestedHookDocumentSpec<TName>,
): Record<string, unknown> | undefined {
  const hooks = entry.hooks;
  if (!Array.isArray(hooks)) return entry;
  const nextHooks = hooks.filter((hook) => !isGeneratedNestedHookCommand(hook, command, spec));
  if (nextHooks.length === hooks.length) return entry;
  if (nextHooks.length > 0) {
    const next = cloneRecord(entry);
    next.hooks = nextHooks;
    return next;
  }
  const rest = cloneRecord(entry);
  delete rest.hooks;
  return Object.keys(rest).length === 0 || onlyGeneratedMatcherKeys(rest) ? undefined : rest;
}

function nestedHookEntryContainsCommand(entry: Record<string, unknown>, command: string): boolean {
  const hooks = entry.hooks;
  return (
    Array.isArray(hooks) && hooks.some((hook) => isPlainRecord(hook) && hook.command === command)
  );
}

function nestedHookEntryContainsGeneratedCommand<TName extends string>(
  entry: Record<string, unknown>,
  command: string | undefined,
  spec: NestedHookDocumentSpec<TName>,
): boolean {
  const hooks = entry.hooks;
  return (
    Array.isArray(hooks) && hooks.some((hook) => isGeneratedNestedHookCommand(hook, command, spec))
  );
}

function isGeneratedNestedHookCommand<TName extends string>(
  hook: unknown,
  command: string | undefined,
  spec: NestedHookDocumentSpec<TName>,
): boolean {
  if (!isPlainRecord(hook) || typeof hook.command !== "string") return false;
  if (command !== undefined && hook.command === command) return true;
  return (
    hook.type === "command" &&
    hook.statusMessage === spec.statusMessage &&
    commandLooksLikeGeneratedHookScript(hook.command, spec.generatedScriptName)
  );
}

function commandLooksLikeGeneratedHookScript(
  command: string,
  generatedScriptName: string,
): boolean {
  return command === generatedScriptName || command.endsWith(`/${generatedScriptName}`);
}

function onlyGeneratedMatcherKeys(entry: Record<string, unknown>): boolean {
  return Object.keys(entry).every((key) => key === "matcher");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function expectedNestedHookSettings<TName extends string>(
  spec: NestedHookDocumentSpec<TName>,
  input: { hookScriptPath: string },
): NestedHookDocument {
  const hooks: Record<string, unknown> = {};
  for (const eventName of spec.eventNames) {
    hooks[eventName] = [generatedNestedHookEntry(eventName, input.hookScriptPath, spec)];
  }
  return { hooks };
}

export function installNestedHookCommands<TName extends string>(
  document: NestedHookDocument,
  commands: Record<TName, string>,
  spec: NestedHookDocumentSpec<TName>,
): NestedHookDocument {
  const next = cloneRecord(document);
  const hooksRecord = nestedHooksRecord(next);
  const hooks = hooksRecord === undefined ? {} : cloneRecord(hooksRecord);
  for (const eventName of spec.eventNames) {
    hooks[eventName] = withGeneratedNestedHookEntry(
      hooks[eventName],
      eventName,
      commands[eventName],
      spec,
    );
  }
  next.hooks = hooks;
  return next;
}

export function removeGeneratedNestedHookCommands<TName extends string>(
  document: NestedHookDocument,
  commands: Record<TName, string>,
  spec: NestedHookDocumentSpec<TName>,
): NestedHookDocument {
  const next = cloneRecord(document);
  const hooksRecord = nestedHooksRecord(next);
  if (hooksRecord === undefined) return next;
  const hooks = cloneRecord(hooksRecord);
  for (const eventName of spec.eventNames) {
    const value = withoutGeneratedNestedHookEntry(hooks[eventName], commands[eventName], spec);
    if (value === undefined) {
      delete hooks[eventName];
    } else {
      hooks[eventName] = value;
    }
  }
  if (Object.keys(hooks).length === 0) {
    delete next.hooks;
  } else {
    next.hooks = hooks;
  }
  return next;
}

export function removeGeneratedNestedHookEntries<TName extends string>(
  document: NestedHookDocument,
  spec: NestedHookDocumentSpec<TName>,
): NestedHookDocument {
  const hooks = nestedHooksRecord(document);
  if (hooks === undefined) return document;
  const cleanedHooks: Record<string, unknown> = {};
  for (const [eventName, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) {
      cleanedHooks[eventName] = entries;
      continue;
    }
    const cleanedEntries = entries
      .map((entry) =>
        isPlainRecord(entry) ? withoutGeneratedHooksFromNestedEntry(entry, undefined, spec) : entry,
      )
      .filter((entry) => entry !== undefined);
    if (cleanedEntries.length > 0) cleanedHooks[eventName] = cleanedEntries;
  }
  const cleaned = cloneRecord(document);
  if (Object.keys(cleanedHooks).length > 0) {
    cleaned.hooks = cleanedHooks;
  } else {
    delete cleaned.hooks;
  }
  return cleaned;
}

export function missingNestedHookEvents<TName extends string>(
  document: NestedHookDocument,
  commands: Record<TName, string>,
  spec: NestedHookDocumentSpec<TName>,
): TName[] {
  const hooks = nestedHooksRecord(document);
  if (hooks === undefined) return [...spec.eventNames];
  return spec.eventNames.filter(
    (eventName) =>
      !nestedHookEntries(hooks[eventName]).some((entry) =>
        nestedHookEntryContainsCommand(entry, commands[eventName]),
      ),
  );
}

export function generatedNestedHookEvents<TName extends string>(
  document: NestedHookDocument,
  spec: NestedHookDocumentSpec<TName>,
  commands?: Record<TName, string>,
): TName[] {
  const hooks = nestedHooksRecord(document);
  if (hooks === undefined) return [];
  return spec.eventNames
    .filter((eventName) =>
      nestedHookEntries(hooks[eventName]).some((entry) =>
        nestedHookEntryContainsGeneratedCommand(entry, commands?.[eventName], spec),
      ),
    )
    .sort();
}

export function nestedDocumentContainsCommand(
  document: NestedHookDocument,
  command: string,
): boolean {
  const hooks = nestedHooksRecord(document);
  if (hooks === undefined) return false;
  return Object.values(hooks).some((value) =>
    nestedHookEntries(value).some((entry) => nestedHookEntryContainsCommand(entry, command)),
  );
}

export function ingressHookScriptOptions(
  hookScriptPath: string,
  options: IngressHookScriptOptions,
): IngressHookScriptOptions & { hookScriptPath: string } {
  const input: IngressHookScriptOptions & { hookScriptPath: string } = { hookScriptPath };
  if (options.stationConfigPath !== undefined) input.stationConfigPath = options.stationConfigPath;
  if (options.observerSocketPath !== undefined)
    input.observerSocketPath = options.observerSocketPath;
  if (options.stateDir !== undefined) input.stateDir = options.stateDir;
  if (options.hookSpoolDir !== undefined) input.hookSpoolDir = options.hookSpoolDir;
  if (options.autoStartFromHooks !== undefined)
    input.autoStartFromHooks = options.autoStartFromHooks;
  if (options.hookBin !== undefined) input.hookBin = options.hookBin;
  return input;
}

export function createHookFileOps(input: {
  codes: HookFileCodes;
  messages: HookFileMessages;
  error: HookFileErrorFactory;
}): HookFileOps {
  return {
    async readOptionalFile(path) {
      try {
        return (await readTextFileIfPresent(path)) ?? "";
      } catch (cause) {
        throw input.error(input.codes.unreadable, input.messages.configUnreadable, cause);
      }
    },
    async writeHookConfig(path, contents) {
      try {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, contents, { mode: 0o600 });
      } catch (cause) {
        throw input.error(input.codes.writeFailed, input.messages.configWriteFailed, cause);
      }
    },
    async writeHookScript(path, contents) {
      try {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, contents, { mode: 0o700 });
        await chmod(path, 0o700);
      } catch (cause) {
        throw input.error(input.codes.writeFailed, input.messages.scriptWriteFailed, cause);
      }
    },
    async removeHookScriptIfPresent(path) {
      try {
        return await removeFileIfPresent(path);
      } catch (cause) {
        throw input.error(input.codes.writeFailed, input.messages.scriptRemoveFailed, cause);
      }
    },
    async backupIfPresent(path) {
      try {
        if (!(await pathExists(path))) return undefined;
      } catch (cause) {
        throw input.error(input.codes.unreadable, input.messages.configMetadataUnreadable, cause);
      }
      const backupPath = `${path}.bak.${new Date().toISOString().replaceAll(/[^0-9]/g, "")}`;
      try {
        await copyFile(path, backupPath);
      } catch (cause) {
        throw input.error(input.codes.writeFailed, input.messages.backupWriteFailed, cause);
      }
      return backupPath;
    },
  };
}

export function expectedIngressHookScript(
  input: IngressHookScriptOptions & {
    provider: string;
    swallowErrors?: boolean;
  },
): string {
  const hookArgs = [input.hookBin ?? "stn-ingress"];
  if (input.observerSocketPath !== undefined) hookArgs.push("--socket", input.observerSocketPath);
  if (input.stateDir !== undefined) hookArgs.push("--state-dir", input.stateDir);
  if (input.hookSpoolDir !== undefined) hookArgs.push("--spool-dir", input.hookSpoolDir);
  if (input.stationConfigPath !== undefined) hookArgs.push("--config", input.stationConfigPath);
  if (input.autoStartFromHooks === false) hookArgs.push("--no-auto-start");
  hookArgs.push(input.provider);
  const redirect = input.swallowErrors === true ? "> /dev/null 2>&1 || true" : "> /dev/null";
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `if [ -z "\${STATION_SESSION_ID:-}" ] || [ -z "\${STATION_WORKTREE_ID:-}" ]; then`,
    "  exit 0",
    "fi",
    `${commandLine(hookArgs)} ${redirect}`,
    "",
  ].join("\n");
}

export function expectedHookCommands<TName extends string>(
  eventNames: readonly TName[],
  hookScriptPath: string,
): Record<TName, string> {
  return Object.fromEntries(eventNames.map((eventName) => [eventName, hookScriptPath])) as Record<
    TName,
    string
  >;
}

export function commandLine(args: readonly string[]): string {
  return args.map(shellQuote).join(" ");
}

export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
