// Installs/uninstalls the STATION hook into Cursor's .cursor/hooks.json.
// Upstream hook contract: https://cursor.com/docs/hooks
// STATION ingress flow: docs/harness-ingress.md. Generated command + payload must match the ingress parser.
import {
  assignBackupPaths,
  expectedProviderHookScript,
  hookCommandsForEvents,
  type ProviderHookScriptOptions,
  providerHookScriptOptions,
} from "@station/runtime";
import {
  documentContainsCommand,
  generatedCursorHookCommands,
  installCursorHookCommands,
  missingCursorHookEvents,
  parseJsonDocument,
  removeGeneratedCursorHookCommands,
  stringifyJsonDocument,
} from "./hooks/hookConfigEditor.js";
import { CURSOR_HOOK_EVENT_NAMES, type CursorHookEventName } from "./hooks/hookConstants.js";
import {
  backupIfPresent,
  readOptionalFile,
  removeHookScriptIfPresent,
  writeHookConfig,
  writeHookScript,
} from "./hooks/hookFiles.js";
import { resolveCursorHookScriptPath, resolveCursorHooksPath } from "./hooks/hookPaths.js";

export { CURSOR_HOOK_EVENT_NAMES, type CursorHookEventName } from "./hooks/hookConstants.js";
export { CursorHookSetupError, type CursorHookSetupErrorCode } from "./hooks/hookErrors.js";
export { resolveCursorHookScriptPath, resolveCursorHooksPath } from "./hooks/hookPaths.js";
export { expectedCursorHookCommands, expectedCursorHookScript };

export type CursorHookPlanOptions = {
  cursorHooksPath?: string;
  hookScriptPath?: string;
  stateDir?: string;
  observerSocketPath?: string;
  hookSpoolDir?: string;
  autoStartFromHooks?: boolean;
  stationConfigPath?: string;
  hookBin?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

export type CursorHookPlan = {
  provider: "cursor";
  hooksPath: string;
  hookScriptPath: string;
  commands: Record<CursorHookEventName, string>;
  missing: CursorHookEventName[];
  changed: boolean;
  configChanged: boolean;
  scriptChanged: boolean;
  before: string;
  after: string;
};

export type CursorHookInstallResult = CursorHookPlan & {
  installed: boolean;
  backupPath?: string;
  backupPaths?: string[];
  scriptRemoved?: boolean;
};

export type CursorHookDoctorResult = {
  provider: "cursor";
  hooksPath: string;
  hookScriptPath: string;
  status: "ok" | "warn";
  installed: boolean;
  missing: CursorHookEventName[];
  commands: Record<CursorHookEventName, string>;
  message: string;
};

export type CursorHookScriptOptions = ProviderHookScriptOptions & {
  hookScriptPath: string;
};

function missingDescription(plan: CursorHookPlan): string {
  const missing = plan.missing.length === 0 ? "none" : plan.missing.join(", ");
  if (plan.configChanged && plan.scriptChanged) {
    return `${missing}; hooks config and script are stale`;
  }
  if (plan.configChanged) {
    return `${missing}; hooks config is stale`;
  }
  return plan.scriptChanged ? `${missing}; script is missing or stale` : missing;
}

function expectedCursorHookCommands(input: {
  hookScriptPath: string;
}): Record<CursorHookEventName, string> {
  return hookCommandsForEvents(CURSOR_HOOK_EVENT_NAMES, input.hookScriptPath);
}

function expectedCursorHookScript(input: CursorHookScriptOptions): string {
  return expectedProviderHookScript({ provider: "cursor", options: input });
}

export async function planCursorHooks(
  options: CursorHookPlanOptions = {},
): Promise<CursorHookPlan> {
  const hooksPath = resolveCursorHooksPath(options);
  const hookScriptPath = resolveCursorHookScriptPath(options);
  const before = await readOptionalFile(hooksPath);
  const document = parseJsonDocument(before);
  const commands = expectedCursorHookCommands({ hookScriptPath });
  const afterDocument = installCursorHookCommands(document, commands);
  const after = stringifyJsonDocument(afterDocument);
  const script = expectedCursorHookScript(providerHookScriptOptions(hookScriptPath, options));
  const scriptBefore = await readOptionalFile(hookScriptPath);
  const configChanged = before.trim() !== after.trim();
  const scriptChanged = scriptBefore !== script;

  return {
    provider: "cursor",
    hooksPath,
    hookScriptPath,
    commands,
    missing: missingCursorHookEvents(document, commands),
    changed: configChanged || scriptChanged,
    configChanged,
    scriptChanged,
    before,
    after,
  };
}

export async function installCursorHooks(
  options: CursorHookPlanOptions = {},
): Promise<CursorHookInstallResult> {
  const plan = await planCursorHooks(options);
  let backupPath: string | undefined;

  if (plan.configChanged) {
    backupPath = await backupIfPresent(plan.hooksPath);
    await writeHookConfig(plan.hooksPath, plan.after);
  }
  if (plan.scriptChanged) {
    await writeHookScript(
      plan.hookScriptPath,
      expectedCursorHookScript(providerHookScriptOptions(plan.hookScriptPath, options)),
    );
  }
  const result: CursorHookInstallResult = { ...plan, installed: true };
  assignBackupPaths(result, [backupPath]);
  return result;
}

export async function uninstallCursorHooks(
  options: CursorHookPlanOptions = {},
): Promise<CursorHookInstallResult> {
  const hooksPath = resolveCursorHooksPath(options);
  const hookScriptPath = resolveCursorHookScriptPath(options);
  const before = await readOptionalFile(hooksPath);
  const document = parseJsonDocument(before);
  const commands = expectedCursorHookCommands({ hookScriptPath });
  const afterDocument = removeGeneratedCursorHookCommands(document, commands);
  const after = stringifyJsonDocument(afterDocument);
  const configChanged = before.trim() !== after.trim();
  let backupPath: string | undefined;

  if (configChanged) {
    backupPath = await backupIfPresent(hooksPath);
    await writeHookConfig(hooksPath, after);
  }

  const scriptStillNeeded = documentContainsCommand(afterDocument, hookScriptPath);
  const scriptRemoved = scriptStillNeeded ? false : await removeHookScriptIfPresent(hookScriptPath);
  const result: CursorHookInstallResult = {
    provider: "cursor",
    hooksPath,
    hookScriptPath,
    commands,
    missing: missingCursorHookEvents(afterDocument, commands),
    changed: configChanged || scriptRemoved,
    configChanged,
    scriptChanged: scriptRemoved,
    before,
    after,
    installed: false,
    scriptRemoved,
  };
  assignBackupPaths(result, [backupPath]);
  return result;
}

export async function doctorCursorHooks(
  options: CursorHookPlanOptions & { enabled?: boolean } = {},
): Promise<CursorHookDoctorResult> {
  if (options.enabled === false) {
    const hookScriptPath = resolveCursorHookScriptPath(options);
    return {
      provider: "cursor",
      hooksPath: resolveCursorHooksPath(options),
      hookScriptPath,
      status: "ok",
      installed: false,
      missing: [],
      commands: expectedCursorHookCommands({ hookScriptPath }),
      message: "Cursor hooks are not requested in station config.",
    };
  }

  const plan = await planCursorHooks(options);
  const installed = plan.missing.length === 0 && !plan.configChanged && !plan.scriptChanged;
  const compatibleSharedInstall = installed
    ? undefined
    : await findCompatibleSharedCursorHookInstall(plan);
  if (compatibleSharedInstall !== undefined) {
    return {
      provider: "cursor",
      hooksPath: plan.hooksPath,
      hookScriptPath: compatibleSharedInstall.hookScriptPath,
      status: "ok",
      installed: true,
      missing: [],
      commands: compatibleSharedInstall.commands,
      message: "Cursor hooks are installed.",
    };
  }
  return {
    provider: "cursor",
    hooksPath: plan.hooksPath,
    hookScriptPath: plan.hookScriptPath,
    status: installed ? "ok" : "warn",
    installed,
    missing: plan.missing,
    commands: plan.commands,
    message: installed
      ? "Cursor hooks are installed."
      : `Cursor hooks are missing or stale: ${missingDescription(plan)}.`,
  };
}

async function findCompatibleSharedCursorHookInstall(plan: CursorHookPlan): Promise<
  | {
      hookScriptPath: string;
      commands: Record<CursorHookEventName, string>;
    }
  | undefined
> {
  const document = parseJsonDocument(plan.before);
  const generatedCommands = generatedCursorHookCommands(document);
  const commands: Partial<Record<CursorHookEventName, string>> = {};

  for (const eventName of CURSOR_HOOK_EVENT_NAMES) {
    const command = await firstCompatibleGeneratedHookScript(generatedCommands[eventName]);
    if (command === undefined) {
      return undefined;
    }
    commands[eventName] = command;
  }

  const hookScriptPath = commands[CURSOR_HOOK_EVENT_NAMES[0]];
  if (hookScriptPath === undefined) {
    return undefined;
  }
  return {
    hookScriptPath,
    commands: commands as Record<CursorHookEventName, string>,
  };
}

async function firstCompatibleGeneratedHookScript(
  commands: readonly string[],
): Promise<string | undefined> {
  for (const command of commands) {
    if (!command.startsWith("/")) {
      continue;
    }
    const script = await readOptionalFile(command);
    if (generatedHookScriptSupportsRuntimeStationConfig(script)) {
      return command;
    }
  }
  return undefined;
}

function generatedHookScriptSupportsRuntimeStationConfig(script: string): boolean {
  return (
    script.includes("STATION_SESSION_ID") &&
    script.includes("STATION_WORKTREE_ID") &&
    script.includes("STATION_OBSERVER_SOCKET_PATH") &&
    script.includes("STATION_CONFIG_PATH") &&
    script.includes(" cursor > /dev/null")
  );
}
