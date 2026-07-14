import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  createHookSetupFileOps,
  providerHookCommandLine,
  providerHookInvocationMatchesIgnoringBin,
} from "@station/runtime";
import { parse, stringify } from "smol-toml";

export const WORKTRUNK_HOOK_NAMES = [
  "post-create",
  "post-switch",
  "pre-remove",
  "post-remove",
] as const;

export type WorktrunkHookName = (typeof WORKTRUNK_HOOK_NAMES)[number];

export type WorktrunkHookPlanOptions = {
  worktrunkConfigPath?: string;
  stationConfigPath?: string;
  observerSocketPath?: string;
  stateDir?: string;
  hookSpoolDir?: string;
  autoStartFromHooks?: boolean;
  hookBin?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

export type WorktrunkHookPlan = {
  provider: "worktrunk";
  configPath: string;
  commands: Record<WorktrunkHookName, string>;
  missing: WorktrunkHookName[];
  changed: boolean;
  before: string;
  after: string;
};

export type WorktrunkHookInstallResult = WorktrunkHookPlan & {
  installed: boolean;
  backupPath?: string;
};

export type WorktrunkHookDoctorResult = {
  provider: "worktrunk";
  configPath: string;
  status: "ok" | "warn";
  installed: boolean;
  missing: WorktrunkHookName[];
  commands: Record<WorktrunkHookName, string>;
  message: string;
};

export type WorktrunkHookSetupErrorCode =
  | "WORKTRUNK_HOOK_CONFIG_UNREADABLE"
  | "WORKTRUNK_HOOK_INVALID_TOML"
  | "WORKTRUNK_HOOK_WRITE_FAILED";

export class WorktrunkHookSetupError extends Error {
  readonly tag = "WorktrunkHookSetupError";
  readonly code: WorktrunkHookSetupErrorCode;
  readonly provider = "worktrunk";

  constructor(
    code: WorktrunkHookSetupErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    Object.defineProperty(this, "name", {
      value: this.tag,
      enumerable: false,
      configurable: true,
    });
    this.code = code;
  }
}

const generatedCommandKey = "station";
const fileOps = createHookSetupFileOps(({ operation, cause }) => {
  if (operation === "read" || operation === "metadata") {
    return new WorktrunkHookSetupError(
      "WORKTRUNK_HOOK_CONFIG_UNREADABLE",
      operation === "read"
        ? "Worktrunk hook config could not be read."
        : "Worktrunk hook config metadata could not be read.",
      { cause },
    );
  }
  return new WorktrunkHookSetupError(
    "WORKTRUNK_HOOK_WRITE_FAILED",
    operation === "backup"
      ? "Worktrunk hook config backup could not be written."
      : "Worktrunk hook config could not be written.",
    { cause },
  );
});

export async function planWorktrunkHooks(
  options: WorktrunkHookPlanOptions = {},
): Promise<WorktrunkHookPlan> {
  const configPath = resolveWorktrunkConfigPath(options);
  const before = await fileOps.readOptionalFile(configPath);
  const commands = expectedWorktrunkHookCommands(options);
  const document = parseTomlDocument(before);
  const missing = WORKTRUNK_HOOK_NAMES.filter(
    (hookName) => !hookContainsCommand(document, hookName, commands[hookName]),
  );
  const afterDocument = installCommands(document, commands);
  const after = stringifyTomlDocument(afterDocument);

  return {
    provider: "worktrunk",
    configPath,
    commands,
    missing,
    changed: before.trim() !== after.trim(),
    before,
    after,
  };
}

export async function installWorktrunkHooks(
  options: WorktrunkHookPlanOptions = {},
): Promise<WorktrunkHookInstallResult> {
  const plan = await planWorktrunkHooks(options);
  if (!plan.changed) {
    return {
      ...plan,
      installed: true,
    };
  }

  const backupPath = await fileOps.backupIfPresent(plan.configPath);
  await fileOps.writeHookConfig(plan.configPath, plan.after);
  return {
    ...plan,
    installed: true,
    ...(backupPath === undefined ? {} : { backupPath }),
  };
}

export async function uninstallWorktrunkHooks(
  options: WorktrunkHookPlanOptions = {},
): Promise<WorktrunkHookInstallResult> {
  const configPath = resolveWorktrunkConfigPath(options);
  const before = await fileOps.readOptionalFile(configPath);
  const commands = expectedWorktrunkHookCommands(options);
  const document = parseTomlDocument(before);
  const afterDocument = uninstallCommands(document, commands);
  const after = stringifyTomlDocument(afterDocument);
  const missing = WORKTRUNK_HOOK_NAMES.filter(
    (hookName) => !hookContainsCommand(afterDocument, hookName, commands[hookName]),
  );
  const changed = before.trim() !== after.trim();

  if (changed) {
    const backupPath = await fileOps.backupIfPresent(configPath);
    await fileOps.writeHookConfig(configPath, after);
    return {
      provider: "worktrunk",
      configPath,
      commands,
      missing,
      changed,
      before,
      after,
      installed: false,
      ...(backupPath === undefined ? {} : { backupPath }),
    };
  }

  return {
    provider: "worktrunk",
    configPath,
    commands,
    missing,
    changed,
    before,
    after,
    installed: false,
  };
}

export async function doctorWorktrunkHooks(
  options: WorktrunkHookPlanOptions & { enabled?: boolean } = {},
): Promise<WorktrunkHookDoctorResult> {
  const plan = await planWorktrunkHooks(options);
  if (options.enabled === false) {
    return {
      provider: "worktrunk",
      configPath: plan.configPath,
      status: "ok",
      installed: false,
      missing: WORKTRUNK_HOOK_NAMES.slice(),
      commands: plan.commands,
      message:
        "Worktrunk lifecycle hooks are disabled in station config; automated mutations skip hooks.",
    };
  }

  const document = parseTomlDocument(plan.before);
  const missing = WORKTRUNK_HOOK_NAMES.filter(
    (hookName) =>
      !hookContainsCommand(document, hookName, plan.commands[hookName], (actual, expected) =>
        providerHookInvocationMatchesIgnoringBin(actual, expected, "worktrunk"),
      ),
  );
  const installed = missing.length === 0;
  return {
    provider: "worktrunk",
    configPath: plan.configPath,
    status: installed ? "ok" : "warn",
    installed,
    missing,
    commands: plan.commands,
    message: installed
      ? "Worktrunk lifecycle hooks are installed."
      : `Worktrunk lifecycle hooks are missing: ${missing.join(", ")}.`,
  };
}

export function resolveWorktrunkConfigPath(options: WorktrunkHookPlanOptions = {}): string {
  if (options.worktrunkConfigPath !== undefined) {
    return resolvePath(options.worktrunkConfigPath, options.homeDir ?? homedir());
  }

  const env = options.env ?? process.env;
  const base = env.XDG_CONFIG_HOME ?? join(options.homeDir ?? homedir(), ".config");
  return resolve(base, "worktrunk", "config.toml");
}

export function expectedWorktrunkHookCommands(
  options: Pick<
    WorktrunkHookPlanOptions,
    | "stationConfigPath"
    | "observerSocketPath"
    | "stateDir"
    | "hookSpoolDir"
    | "autoStartFromHooks"
    | "hookBin"
  > = {},
): Record<WorktrunkHookName, string> {
  const hookBin = options.hookBin ?? "stn-ingress";
  return Object.fromEntries(
    WORKTRUNK_HOOK_NAMES.map((hookName) => [
      hookName,
      providerHookCommandLine("worktrunk", { ...options, hookBin }, hookName),
    ]),
  ) as Record<WorktrunkHookName, string>;
}

export function normalizeWorktrunkLifecycleEvent(event: string): string {
  if (event === "post-start") {
    return "post-create";
  }
  if (event === "pre-start") {
    return "pre-create";
  }
  return event;
}

function installCommands(
  document: Record<string, unknown>,
  commands: Record<WorktrunkHookName, string>,
): Record<string, unknown> {
  const next = { ...document };
  for (const hookName of WORKTRUNK_HOOK_NAMES) {
    next[hookName] = withGeneratedCommand(next[hookName], commands[hookName]);
  }
  return next;
}

function uninstallCommands(
  document: Record<string, unknown>,
  commands: Record<WorktrunkHookName, string>,
): Record<string, unknown> {
  const next = { ...document };
  for (const hookName of WORKTRUNK_HOOK_NAMES) {
    const value = withoutGeneratedCommand(next[hookName], commands[hookName]);
    if (value === undefined) {
      delete next[hookName];
    } else {
      next[hookName] = value;
    }
  }
  return next;
}

// Worktrunk hook values may be strings, arrays, or tables. Preserve user hooks
// and add/remove only our generated command under the stable "station" key.
function withGeneratedCommand(value: unknown, command: string): unknown {
  if (value === undefined) {
    return { [generatedCommandKey]: command };
  }
  if (typeof value === "string") {
    return value === command ? value : { existing: value, [generatedCommandKey]: command };
  }
  if (Array.isArray(value)) {
    return [...value, { [generatedCommandKey]: command }];
  }
  if (isRecord(value)) {
    return { ...value, [generatedCommandKey]: command };
  }
  return { existing: String(value), [generatedCommandKey]: command };
}

function withoutGeneratedCommand(value: unknown, command: string): unknown {
  if (typeof value === "string") {
    return value === command ? undefined : value;
  }
  if (Array.isArray(value)) {
    const next = value
      .map((entry) => withoutGeneratedCommand(entry, command))
      .filter((entry) => entry !== undefined);
    return next.length === 0 ? undefined : next;
  }
  if (isRecord(value)) {
    const next = { ...value };
    if (next[generatedCommandKey] === command) {
      delete next[generatedCommandKey];
    }
    return Object.keys(next).length === 0 ? undefined : next;
  }
  return value;
}

function hookContainsCommand(
  document: Record<string, unknown>,
  hookName: WorktrunkHookName,
  command: string,
  matches: (actual: string, expected: string) => boolean = (actual, expected) =>
    actual === expected,
): boolean {
  const value = document[hookName];
  if (typeof value === "string") {
    return matches(value, command);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => commandInHookValue(entry, command, matches));
  }
  return commandInHookValue(value, command, matches);
}

function commandInHookValue(
  value: unknown,
  command: string,
  matches: (actual: string, expected: string) => boolean,
): boolean {
  if (typeof value === "string") {
    return matches(value, command);
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).some((child) => typeof child === "string" && matches(child, command));
}

function parseTomlDocument(source: string): Record<string, unknown> {
  if (source.trim().length === 0) {
    return {};
  }
  try {
    return parse(source) as Record<string, unknown>;
  } catch (cause) {
    throw new WorktrunkHookSetupError(
      "WORKTRUNK_HOOK_INVALID_TOML",
      "Worktrunk hook config is not valid TOML.",
      { cause },
    );
  }
}

function stringifyTomlDocument(document: Record<string, unknown>): string {
  const result = stringify(document);
  return result.endsWith("\n") ? result : `${result}\n`;
}

function resolvePath(input: string, homeDir: string): string {
  const expanded =
    input === "~" ? homeDir : input.startsWith("~/") ? join(homeDir, input.slice(2)) : input;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
