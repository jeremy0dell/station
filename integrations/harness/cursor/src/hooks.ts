// Installs/uninstalls the STATION hook into Cursor's .cursor/hooks.json.
// Upstream hook contract: https://cursor.com/docs/hooks
// STATION ingress flow: docs/harness-ingress.md. Generated command + payload must match the ingress parser.
import { ingressHookScriptOptions } from "@station/harness-shared";
import {
  documentContainsCommand,
  installCursorHookCommands,
  missingCursorHookEvents,
  parseJsonDocument,
  removeGeneratedCursorHookCommands,
  stringifyJsonDocument,
} from "./hooks/hookConfigEditor.js";
import type { CursorHookEventName } from "./hooks/hookConstants.js";
import {
  backupIfPresent,
  readOptionalFile,
  removeHookScriptIfPresent,
  writeHookConfig,
  writeHookScript,
} from "./hooks/hookFiles.js";
import { resolveCursorHookScriptPath, resolveCursorHooksPath } from "./hooks/hookPaths.js";
import { expectedCursorHookCommands, expectedCursorHookScript } from "./hooks/hookScript.js";

export { CURSOR_HOOK_EVENT_NAMES, type CursorHookEventName } from "./hooks/hookConstants.js";
export { CursorHookSetupError, type CursorHookSetupErrorCode } from "./hooks/hookErrors.js";
export { resolveCursorHookScriptPath, resolveCursorHooksPath } from "./hooks/hookPaths.js";
export { expectedCursorHookCommands, expectedCursorHookScript } from "./hooks/hookScript.js";

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

function installResultFromPlan(plan: CursorHookPlan, installed: boolean): CursorHookInstallResult {
  return {
    provider: plan.provider,
    hooksPath: plan.hooksPath,
    hookScriptPath: plan.hookScriptPath,
    commands: plan.commands,
    missing: plan.missing,
    changed: plan.changed,
    configChanged: plan.configChanged,
    scriptChanged: plan.scriptChanged,
    before: plan.before,
    after: plan.after,
    installed,
  };
}

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
  const script = expectedCursorHookScript(ingressHookScriptOptions(hookScriptPath, options));
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
      expectedCursorHookScript(ingressHookScriptOptions(plan.hookScriptPath, options)),
    );
  }

  const result = installResultFromPlan(plan, true);
  if (backupPath !== undefined) {
    result.backupPath = backupPath;
    result.backupPaths = [backupPath];
  }
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
  if (backupPath !== undefined) {
    result.backupPath = backupPath;
    result.backupPaths = [backupPath];
  }
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
