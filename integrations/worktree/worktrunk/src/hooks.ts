import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  classifyProviderHookArtifactOwnership,
  createHookSetupFileOps,
  PROVIDER_HOOK_OWNER_MARKER,
  ProviderHookArtifactOwnershipError,
  parseProviderHookOwnerMarker,
  providerHookCommandLine,
  providerHookOwnerMarker,
} from "@station/runtime";
import { parse, stringify } from "smol-toml";
import {
  WORKTRUNK_HOOK_NAMES,
  type WorktrunkHookDoctorResult,
  type WorktrunkHookExpectation,
  type WorktrunkHookInstallResult,
  type WorktrunkHookName,
  type WorktrunkHookPlan,
  type WorktrunkHookPlanOptions,
  type WorktrunkHookSetupErrorCode,
} from "./types.js";

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
  options: WorktrunkHookPlanOptions,
): Promise<WorktrunkHookPlan> {
  const configPath = resolveWorktrunkConfigPath(options);
  const before = await fileOps.readOptionalFile(configPath);
  const commands = expectedWorktrunkHookCommands(options.expectation);
  const document = parseTomlDocument(before);
  const inspection = inspectWorktrunkHooks(document, options.expectation);
  const ownership = worktrunkArtifactOwnership(inspection, options.expectation);
  const missing = WORKTRUNK_HOOK_NAMES.filter(
    (hookName) => !hookContainsCommand(document, hookName, commands[hookName]),
  );
  const afterDocument = installCommands(inspection.document, commands);
  const after = stringifyTomlDocument(afterDocument);

  const result: WorktrunkHookPlan = {
    provider: "worktrunk",
    configPath,
    commands,
    missing,
    changed: before.trim() !== after.trim(),
    before,
    after,
  };
  if (ownership !== undefined) result.ownership = ownership;
  return result;
}

export async function installWorktrunkHooks(
  options: WorktrunkHookPlanOptions,
): Promise<WorktrunkHookInstallResult> {
  let plan = await planWorktrunkHooks(options);
  if (!plan.changed) {
    return {
      ...plan,
      installed: true,
    };
  }

  plan = await planWorktrunkHooks(options);
  assertWorktrunkArtifactOwnership("install", plan.configPath, plan.ownership, options);
  if (!plan.changed) {
    return {
      ...plan,
      installed: true,
    };
  }
  const backupPath = await fileOps.backupIfPresent(plan.configPath);
  await fileOps.writeHookConfig(plan.configPath, plan.after);
  const result: WorktrunkHookInstallResult = {
    ...plan,
    installed: true,
    ...(backupPath === undefined ? {} : { backupPath }),
  };
  if (options.expectation.artifactOwner !== undefined) {
    result.ownership = {
      status: "same-owner",
      requested: options.expectation.artifactOwner,
      currentLauncher: options.expectation.artifactOwner.launcher,
    };
  }
  return result;
}

export async function uninstallWorktrunkHooks(
  options: WorktrunkHookPlanOptions,
): Promise<WorktrunkHookInstallResult> {
  const configPath = resolveWorktrunkConfigPath(options);
  const before = await fileOps.readOptionalFile(configPath);
  const commands = expectedWorktrunkHookCommands(options.expectation);
  const document = parseTomlDocument(before);
  const inspection = inspectWorktrunkHooks(document, options.expectation);
  const ownership = worktrunkArtifactOwnership(inspection, options.expectation);
  assertWorktrunkArtifactOwnership("uninstall", configPath, ownership, options);
  const afterDocument = inspection.document;
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
  options: WorktrunkHookPlanOptions & { enabled?: boolean },
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
      ...(plan.ownership === undefined ? {} : { ownership: plan.ownership }),
    };
  }

  const installed = plan.missing.length === 0;
  const ownershipConflict =
    plan.ownership?.status === "different-owner" || plan.ownership?.status === "unknown-owner";
  const result: WorktrunkHookDoctorResult = {
    provider: "worktrunk",
    configPath: plan.configPath,
    status: installed && !ownershipConflict ? "ok" : "warn",
    installed: installed && !ownershipConflict,
    missing: plan.missing,
    commands: plan.commands,
    message: ownershipConflict
      ? "Worktrunk lifecycle hook ownership conflicts with this Station runtime; run `stn hooks install worktrunk --yes --takeover` only to transfer it."
      : installed
        ? "Worktrunk lifecycle hooks are installed."
        : `Worktrunk lifecycle hooks are missing: ${plan.missing.join(", ")}.`,
  };
  if (plan.ownership !== undefined) result.ownership = plan.ownership;
  return result;
}

export function resolveWorktrunkConfigPath(
  options: Pick<WorktrunkHookPlanOptions, "worktrunkConfigPath" | "env" | "homeDir"> = {},
): string {
  if (options.worktrunkConfigPath !== undefined) {
    return resolvePath(options.worktrunkConfigPath, options.homeDir ?? homedir());
  }

  const env = options.env ?? process.env;
  const base = env.XDG_CONFIG_HOME ?? join(options.homeDir ?? homedir(), ".config");
  return resolve(base, "worktrunk", "config.toml");
}

export function expectedWorktrunkHookCommands(
  expectation: WorktrunkHookExpectation,
): Record<WorktrunkHookName, string> {
  return Object.fromEntries(
    WORKTRUNK_HOOK_NAMES.map((hookName) => [
      hookName,
      `${providerHookCommandLine("worktrunk", expectation, hookName)}${
        expectation.artifactOwner === undefined
          ? ""
          : ` # ${providerHookOwnerMarker(expectation.artifactOwner)}`
      }`,
    ]),
  ) as Record<WorktrunkHookName, string>;
}

function worktrunkArtifactOwnership(
  inspection: WorktrunkHookInspection,
  expectation: WorktrunkHookExpectation,
): WorktrunkHookPlan["ownership"] {
  if (expectation.artifactOwner === undefined) return undefined;
  if (inspection.commands.length === 0 && !inspection.unknownOwner) {
    return { status: "absent", requested: expectation.artifactOwner };
  }
  const owners = inspection.commands.map(parseProviderHookOwnerMarker);
  const markedLaunchers = new Set(
    owners.filter((owner) => owner !== undefined).map((owner) => owner.launcher),
  );
  if (
    inspection.unknownOwner ||
    markedLaunchers.size > 1 ||
    owners.some((owner) => owner === undefined)
  ) {
    return { status: "unknown-owner", requested: expectation.artifactOwner };
  }
  return classifyProviderHookArtifactOwnership({
    contents: inspection.commands.join("\n"),
    requested: expectation.artifactOwner,
  });
}

function assertWorktrunkArtifactOwnership(
  action: "install" | "uninstall",
  configPath: string,
  ownership: WorktrunkHookPlan["ownership"],
  options: WorktrunkHookPlanOptions,
): void {
  if (options.expectation.artifactOwner === undefined) return;
  if (
    options.takeover !== true &&
    (ownership?.status === "different-owner" || ownership?.status === "unknown-owner")
  ) {
    throw new ProviderHookArtifactOwnershipError({
      provider: "worktrunk",
      action,
      artifactPath: configPath,
      ownership,
    });
  }
}

type WorktrunkHookInspection = {
  document: Record<string, unknown>;
  commands: string[];
  unknownOwner: boolean;
};

function inspectWorktrunkHooks(
  document: Record<string, unknown>,
  expectation: WorktrunkHookExpectation,
): WorktrunkHookInspection {
  const next = { ...document };
  const commands: string[] = [];
  let unknownOwner = false;
  for (const hookName of WORKTRUNK_HOOK_NAMES) {
    const inspected = inspectWorktrunkHookValue(
      next[hookName],
      providerHookCommandLine("worktrunk", expectation, hookName),
    );
    commands.push(...inspected.commands);
    unknownOwner ||= inspected.unknownOwner;
    if (inspected.value === undefined) delete next[hookName];
    else next[hookName] = inspected.value;
  }
  return { document: next, commands, unknownOwner };
}

function inspectWorktrunkHookValue(
  value: unknown,
  unmarkedCommand: string,
): { value: unknown; commands: string[]; unknownOwner: boolean } {
  if (typeof value === "string") {
    const stationCommand = value === unmarkedCommand || value.includes(PROVIDER_HOOK_OWNER_MARKER);
    return stationCommand
      ? {
          value: undefined,
          commands: [value],
          unknownOwner: !value.includes(PROVIDER_HOOK_OWNER_MARKER),
        }
      : { value, commands: [], unknownOwner: false };
  }
  if (Array.isArray(value)) {
    const commands: string[] = [];
    let unknownOwner = false;
    const next = value.flatMap((entry) => {
      const inspected = inspectWorktrunkHookValue(entry, unmarkedCommand);
      commands.push(...inspected.commands);
      unknownOwner ||= inspected.unknownOwner;
      return inspected.value === undefined ? [] : [inspected.value];
    });
    return {
      value: next.length === 0 ? undefined : next,
      commands,
      unknownOwner,
    };
  }
  if (!isRecord(value) || !(generatedCommandKey in value)) {
    return { value, commands: [], unknownOwner: false };
  }
  const command = value[generatedCommandKey];
  const next = { ...value };
  delete next[generatedCommandKey];
  return {
    value: Object.keys(next).length === 0 ? undefined : next,
    commands: typeof command === "string" ? [command] : [],
    unknownOwner: typeof command !== "string" || !command.includes(PROVIDER_HOOK_OWNER_MARKER),
  };
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

// Worktrunk hook values may be strings, arrays, or tables; "station" is our reserved table key.
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

function hookContainsCommand(
  document: Record<string, unknown>,
  hookName: WorktrunkHookName,
  command: string,
): boolean {
  const value = document[hookName];
  if (typeof value === "string") {
    return value === command;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => commandInHookValue(entry, command));
  }
  return commandInHookValue(value, command);
}

function commandInHookValue(value: unknown, command: string): boolean {
  if (typeof value === "string") {
    return value === command;
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).some((child) => child === command);
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
