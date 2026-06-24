// Installs/uninstalls the STATION hook into Crush's .crush.json hooks.PreToolUse.
// Upstream hook contract: https://github.com/charmbracelet/crush/blob/main/docs/hooks/README.md
// STATION ingress flow: docs/harness-ingress.md. Matcher omitted = fires on every tool; the script exits 0 with
// empty stdout so Crush treats it as "no opinion" (never blocks a tool call).
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  expectedIngressHookScript,
  type IngressHookScriptOptions,
  ingressHookScriptOptions,
} from "@station/harness-shared";
import { z } from "zod";

export const CRUSH_HOOK_EVENT_NAMES = ["PreToolUse"] as const;
export const CRUSH_STATION_HOOK_SCRIPT_NAME = "station-crush-hook.sh";

export type CrushHookEventName = (typeof CRUSH_HOOK_EVENT_NAMES)[number];

export type CrushHookPlanOptions = {
  crushConfigPath?: string;
  hookScriptPath?: string;
  stateDir?: string;
  observerSocketPath?: string;
  hookSpoolDir?: string;
  autoStartFromHooks?: boolean;
  stationConfigPath?: string;
  hookBin?: string;
  cwd?: string;
};

export type CrushHookPlan = {
  provider: "crush";
  configPath: string;
  hookScriptPath: string;
  commands: Record<CrushHookEventName, string>;
  missing: CrushHookEventName[];
  changed: boolean;
  configChanged: boolean;
  scriptChanged: boolean;
  before: string;
  after: string;
};

export type CrushHookInstallResult = CrushHookPlan & {
  installed: boolean;
  backupPath?: string;
  backupPaths?: string[];
  scriptRemoved?: boolean;
};

export type CrushHookDoctorResult = {
  provider: "crush";
  configPath: string;
  hookScriptPath: string;
  status: "ok" | "warn";
  installed: boolean;
  missing: CrushHookEventName[];
  commands: Record<CrushHookEventName, string>;
  message: string;
};

type CrushHookEntry = z.infer<typeof crushHookEntrySchema>;
type CrushConfigDocument = z.infer<typeof crushConfigDocumentSchema>;

const crushHookEntrySchema = z
  .object({
    name: z.string().min(1).optional(),
    matcher: z.string().optional(),
    command: z.string().min(1).optional(),
    timeout: z.number().int().positive().optional(),
  })
  .catchall(z.unknown());

const crushConfigDocumentSchema = z
  .object({
    hooks: z.record(z.string(), z.array(crushHookEntrySchema)).optional(),
  })
  .catchall(z.unknown());

export class CrushHookSetupError extends Error {
  readonly tag = "CrushHookSetupError";
  readonly provider = "crush";

  constructor(
    readonly code: "CRUSH_HOOK_INVALID_JSON" | "CRUSH_HOOK_WRITE_FAILED",
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    Object.defineProperty(this, "name", {
      value: this.tag,
      enumerable: false,
      configurable: true,
    });
  }
}

export async function planCrushHooks(options: CrushHookPlanOptions = {}): Promise<CrushHookPlan> {
  const configPath = resolveCrushConfigPath(options);
  const hookScriptPath = resolveCrushHookScriptPath(options);
  const before = await readOptionalFile(configPath);
  const document = parseCrushConfigDocument(before);
  const commands = expectedCrushHookCommands({ hookScriptPath });
  const afterDocument = installCrushHookCommands(document, commands);
  const after = stringifyCrushConfigDocument(afterDocument);
  const script = expectedCrushHookScript(ingressHookScriptOptions(hookScriptPath, options));
  const scriptBefore = await readOptionalFile(hookScriptPath);
  const configChanged = before.trim() !== after.trim();
  const scriptChanged = scriptBefore !== script;
  return {
    provider: "crush",
    configPath,
    hookScriptPath,
    commands,
    missing: missingCrushHookEvents(document, commands),
    changed: configChanged || scriptChanged,
    configChanged,
    scriptChanged,
    before,
    after,
  };
}

export async function installCrushHooks(
  options: CrushHookPlanOptions = {},
): Promise<CrushHookInstallResult> {
  const plan = await planCrushHooks(options);
  let backupPath: string | undefined;
  if (plan.configChanged) {
    backupPath = await backupIfPresent(plan.configPath);
    await writeHookConfig(plan.configPath, plan.after);
  }
  if (plan.scriptChanged) {
    await writeHookScript(
      plan.hookScriptPath,
      expectedCrushHookScript(ingressHookScriptOptions(plan.hookScriptPath, options)),
    );
  }
  const result: CrushHookInstallResult = {
    ...plan,
    installed: true,
  };
  if (backupPath !== undefined) {
    result.backupPath = backupPath;
    result.backupPaths = [backupPath];
  }
  return result;
}

export async function uninstallCrushHooks(
  options: CrushHookPlanOptions = {},
): Promise<CrushHookInstallResult> {
  const configPath = resolveCrushConfigPath(options);
  const hookScriptPath = resolveCrushHookScriptPath(options);
  const before = await readOptionalFile(configPath);
  const document = parseCrushConfigDocument(before);
  const commands = expectedCrushHookCommands({ hookScriptPath });
  const afterDocument = removeGeneratedCrushHookCommands(document, commands);
  const after = stringifyCrushConfigDocument(afterDocument);
  const configChanged = before.trim() !== after.trim();
  let backupPath: string | undefined;
  if (configChanged) {
    backupPath = await backupIfPresent(configPath);
    await writeHookConfig(configPath, after);
  }
  const scriptStillNeeded = documentContainsCommand(afterDocument, hookScriptPath);
  const scriptRemoved = scriptStillNeeded ? false : await removeHookScriptIfPresent(hookScriptPath);
  const result: CrushHookInstallResult = {
    provider: "crush",
    configPath,
    hookScriptPath,
    commands,
    missing: missingCrushHookEvents(afterDocument, commands),
    changed: configChanged || scriptRemoved,
    configChanged,
    scriptChanged: scriptRemoved,
    before,
    after,
    installed: false,
    scriptRemoved,
  };
  if (backupPath !== undefined) {
    result.backupPath = backupPath;
    result.backupPaths = [backupPath];
  }
  return result;
}

export async function doctorCrushHooks(
  options: CrushHookPlanOptions & { enabled?: boolean } = {},
): Promise<CrushHookDoctorResult> {
  if (options.enabled === false) {
    const hookScriptPath = resolveCrushHookScriptPath(options);
    return {
      provider: "crush",
      configPath: resolveCrushConfigPath(options),
      hookScriptPath,
      status: "ok",
      installed: false,
      missing: [],
      commands: expectedCrushHookCommands({ hookScriptPath }),
      message: "Crush hooks are not requested in station config.",
    };
  }
  const plan = await planCrushHooks(options);
  const installed = plan.missing.length === 0 && !plan.configChanged && !plan.scriptChanged;
  return {
    provider: "crush",
    configPath: plan.configPath,
    hookScriptPath: plan.hookScriptPath,
    status: installed ? "ok" : "warn",
    installed,
    missing: plan.missing,
    commands: plan.commands,
    message: installed
      ? "Crush PreToolUse hook is installed."
      : `Crush PreToolUse hook is missing or stale: ${missingDescription(plan)}.`,
  };
}

export function resolveCrushConfigPath(options: CrushHookPlanOptions = {}): string {
  return options.crushConfigPath ?? join(options.cwd ?? process.cwd(), ".crush.json");
}

export function resolveCrushHookScriptPath(options: CrushHookPlanOptions = {}): string {
  return (
    options.hookScriptPath ??
    join(
      dirname(resolveCrushConfigPath(options)),
      ".crush",
      "hooks",
      CRUSH_STATION_HOOK_SCRIPT_NAME,
    )
  );
}

export function expectedCrushHookCommands(input: {
  hookScriptPath: string;
}): Record<CrushHookEventName, string> {
  return { PreToolUse: input.hookScriptPath };
}

export function expectedCrushHookScript(input: CrushHookScriptOptions): string {
  return expectedIngressHookScript({ ...input, provider: "crush", swallowErrors: true });
}

type CrushHookScriptOptions = IngressHookScriptOptions & {
  hookScriptPath: string;
};

function parseCrushConfigDocument(source: string): CrushConfigDocument {
  if (source.trim().length === 0) {
    return {};
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (cause) {
    throw new CrushHookSetupError("CRUSH_HOOK_INVALID_JSON", "Crush config is not valid JSON.", {
      cause,
    });
  }
  const result = crushConfigDocumentSchema.safeParse(value);
  if (!result.success) {
    throw new CrushHookSetupError(
      "CRUSH_HOOK_INVALID_JSON",
      "Crush config does not match the expected hooks shape.",
      { cause: result.error },
    );
  }
  return result.data;
}

function stringifyCrushConfigDocument(document: CrushConfigDocument): string {
  if (Object.keys(document).length === 0) {
    return "";
  }
  return `${JSON.stringify(document, null, 2)}\n`;
}

function installCrushHookCommands(
  document: CrushConfigDocument,
  commands: Record<CrushHookEventName, string>,
): CrushConfigDocument {
  const next = cloneDocument(document);
  const hooks = cloneHooks(document.hooks);
  hooks.PreToolUse = withGeneratedHookEntry(hooks.PreToolUse, commands.PreToolUse);
  next.hooks = hooks;
  return next;
}

function removeGeneratedCrushHookCommands(
  document: CrushConfigDocument,
  commands: Record<CrushHookEventName, string>,
): CrushConfigDocument {
  const next = cloneDocument(document);
  if (document.hooks === undefined) {
    return next;
  }
  const hooks = cloneHooks(document.hooks);
  const entries = withoutGeneratedHookEntries(hooks.PreToolUse ?? [], commands.PreToolUse);
  if (entries.length === 0) {
    delete hooks.PreToolUse;
  } else {
    hooks.PreToolUse = entries;
  }
  if (Object.keys(hooks).length === 0) {
    delete next.hooks;
  } else {
    next.hooks = hooks;
  }
  return next;
}

function missingCrushHookEvents(
  document: CrushConfigDocument,
  commands: Record<CrushHookEventName, string>,
): CrushHookEventName[] {
  return document.hooks?.PreToolUse?.some((entry) => entry.command === commands.PreToolUse) === true
    ? []
    : ["PreToolUse"];
}

function withGeneratedHookEntry(
  value: CrushHookEntry[] | undefined,
  command: string,
): CrushHookEntry[] {
  const entries = withoutGeneratedHookEntries(value ?? [], command);
  entries.push({
    name: "station",
    command,
    timeout: 30,
  });
  return entries;
}

function withoutGeneratedHookEntries(entries: CrushHookEntry[], command: string): CrushHookEntry[] {
  return entries.filter((entry) => !isGeneratedStationHook(entry, command));
}

function isGeneratedStationHook(entry: CrushHookEntry, command: string): boolean {
  if (entry.command === command) {
    return true;
  }
  if (entry.command === undefined) {
    return false;
  }
  return (
    entry.command === CRUSH_STATION_HOOK_SCRIPT_NAME ||
    entry.command.endsWith(`/${CRUSH_STATION_HOOK_SCRIPT_NAME}`)
  );
}

function documentContainsCommand(document: CrushConfigDocument, command: string): boolean {
  return (
    document.hooks !== undefined &&
    Object.values(document.hooks).some((entries) =>
      entries.some((entry) => entry.command === command),
    )
  );
}

async function readOptionalFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function backupIfPresent(path: string): Promise<string | undefined> {
  try {
    await stat(path);
  } catch {
    return undefined;
  }
  const backupPath = `${path}.station-backup-${Date.now()}`;
  await writeFile(backupPath, await readFile(path, "utf8"), "utf8");
  return backupPath;
}

async function writeHookConfig(path: string, content: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, content, { mode: 0o600 });
  } catch (cause) {
    throw new CrushHookSetupError("CRUSH_HOOK_WRITE_FAILED", "Failed to write Crush config.", {
      cause,
    });
  }
}

async function writeHookScript(path: string, content: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, content, { mode: 0o700 });
    await chmod(path, 0o700);
  } catch (cause) {
    throw new CrushHookSetupError("CRUSH_HOOK_WRITE_FAILED", "Failed to write Crush hook script.", {
      cause,
    });
  }
}

async function removeHookScriptIfPresent(path: string): Promise<boolean> {
  try {
    await rm(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

function missingDescription(plan: CrushHookPlan): string {
  const missing = plan.missing.length === 0 ? "none" : plan.missing.join(", ");
  if (plan.configChanged && plan.scriptChanged) {
    return `${missing}; config and script are stale`;
  }
  if (plan.configChanged) {
    return `${missing}; config is stale`;
  }
  return plan.scriptChanged ? `${missing}; script is missing or stale` : missing;
}

function cloneDocument(document: CrushConfigDocument): CrushConfigDocument {
  return { ...document };
}

function cloneHooks(
  hooks: Record<string, CrushHookEntry[]> | undefined,
): Record<string, CrushHookEntry[]> {
  const next: Record<string, CrushHookEntry[]> = {};
  if (hooks === undefined) {
    return next;
  }
  for (const [eventName, entries] of Object.entries(hooks)) {
    next[eventName] = entries.map((entry) => ({ ...entry }));
  }
  return next;
}
