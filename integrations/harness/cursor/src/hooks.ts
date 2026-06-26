// Installs/uninstalls the STATION hook into Cursor's .cursor/hooks.json.
// Upstream hook contract: https://cursor.com/docs/hooks
// STATION ingress flow: docs/harness-ingress.md. Generated command + payload must match the ingress parser.
import {
  assignBackupPaths,
  createHookSetupFileOps,
  expectedProviderHookScript,
  hookCommandsForEvents,
  installConfigScriptHook,
  type ProviderHookScriptOptions,
  planConfigScriptHook,
  providerHookScriptOptions,
  providerHookScriptRoutesByStationEnv,
  uninstallConfigScriptHook,
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
import { CursorHookSetupError } from "./hooks/hookErrors.js";
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

const fileOps = createHookSetupFileOps(({ operation, cause }) => {
  if (operation === "read" || operation === "metadata") {
    return new CursorHookSetupError(
      "CURSOR_HOOK_CONFIG_UNREADABLE",
      operation === "read"
        ? "Cursor hook config could not be read."
        : "Cursor hook config metadata could not be read.",
      { cause },
    );
  }
  return new CursorHookSetupError(
    "CURSOR_HOOK_WRITE_FAILED",
    operation === "remove"
      ? "Cursor hook script could not be removed."
      : operation === "writeScript"
        ? "Cursor hook script could not be written."
        : operation === "backup"
          ? "Cursor hook config backup could not be written."
          : "Cursor hook config could not be written.",
    { cause },
  );
});

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

async function sharedGeneratedHookPlan(
  source: string,
  options: CursorHookPlanOptions,
): Promise<CursorHookDoctorResult | undefined> {
  const document = parseJsonDocument(source);
  const hookScriptPath = sharedGeneratedHookScriptPath(generatedCursorHookCommands(document));
  if (hookScriptPath === undefined) {
    return undefined;
  }

  const scriptBefore = await fileOps.readOptionalFile(hookScriptPath);
  const expectedScript = expectedCursorHookScript(
    providerHookScriptOptions(hookScriptPath, options),
  );
  if (
    scriptBefore !== expectedScript &&
    !providerHookScriptRoutesByStationEnv(scriptBefore, "cursor")
  ) {
    return undefined;
  }

  return {
    provider: "cursor",
    hooksPath: resolveCursorHooksPath(options),
    hookScriptPath,
    status: "ok",
    installed: true,
    missing: [],
    commands: expectedCursorHookCommands({ hookScriptPath }),
    message: "Cursor hooks are installed.",
  };
}

function sharedGeneratedHookScriptPath(
  commands: Record<CursorHookEventName, string[]>,
): string | undefined {
  let shared: string | undefined;
  for (const eventName of CURSOR_HOOK_EVENT_NAMES) {
    const eventCommands = commands[eventName];
    if (eventCommands.length !== 1) {
      return undefined;
    }
    const command = eventCommands[0];
    if (command === undefined) {
      return undefined;
    }
    if (shared === undefined) {
      shared = command;
    } else if (shared !== command) {
      return undefined;
    }
  }
  return shared;
}

export async function planCursorHooks(
  options: CursorHookPlanOptions = {},
): Promise<CursorHookPlan> {
  const hooksPath = resolveCursorHooksPath(options);
  const hookScriptPath = resolveCursorHookScriptPath(options);
  const script = expectedCursorHookScript(providerHookScriptOptions(hookScriptPath, options));
  const plan = await planConfigScriptHook({
    readOptionalFile: fileOps.readOptionalFile,
    configPath: hooksPath,
    hookScriptPath,
    parseDocument: parseJsonDocument,
    installCommands: installCursorHookCommands,
    stringifyDocument: stringifyJsonDocument,
    missingEvents: missingCursorHookEvents,
    expectedCommands: (path) => expectedCursorHookCommands({ hookScriptPath: path }),
    expectedScript: script,
  });

  return {
    provider: "cursor",
    hooksPath,
    hookScriptPath,
    commands: plan.commands,
    missing: plan.missing,
    changed: plan.changed,
    configChanged: plan.configChanged,
    scriptChanged: plan.scriptChanged,
    before: plan.before,
    after: plan.after,
  };
}

export async function installCursorHooks(
  options: CursorHookPlanOptions = {},
): Promise<CursorHookInstallResult> {
  const plan = await planCursorHooks(options);
  const backupPath = await installConfigScriptHook({
    configPath: plan.hooksPath,
    hookScriptPath: plan.hookScriptPath,
    after: plan.after,
    expectedScript: expectedCursorHookScript(
      providerHookScriptOptions(plan.hookScriptPath, options),
    ),
    configChanged: plan.configChanged,
    scriptChanged: plan.scriptChanged,
    fileOps,
  });
  const result: CursorHookInstallResult = { ...plan, installed: true };
  assignBackupPaths(result, [backupPath]);
  return result;
}

export async function uninstallCursorHooks(
  options: CursorHookPlanOptions = {},
): Promise<CursorHookInstallResult> {
  const hooksPath = resolveCursorHooksPath(options);
  const hookScriptPath = resolveCursorHookScriptPath(options);
  const plan = await uninstallConfigScriptHook({
    readOptionalFile: fileOps.readOptionalFile,
    configPath: hooksPath,
    hookScriptPath,
    parseDocument: parseJsonDocument,
    removeCommands: removeGeneratedCursorHookCommands,
    stringifyDocument: stringifyJsonDocument,
    missingEvents: missingCursorHookEvents,
    documentContainsCommand,
    expectedCommands: (path) => expectedCursorHookCommands({ hookScriptPath: path }),
    fileOps,
  });
  const result: CursorHookInstallResult = {
    provider: "cursor",
    hooksPath,
    hookScriptPath,
    commands: plan.commands,
    missing: plan.missing,
    changed: plan.changed,
    configChanged: plan.configChanged,
    scriptChanged: plan.scriptRemoved,
    before: plan.before,
    after: plan.after,
    installed: false,
    scriptRemoved: plan.scriptRemoved,
  };
  assignBackupPaths(result, [plan.backupPath]);
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
  if (!installed) {
    const shared = await sharedGeneratedHookPlan(plan.before, options);
    if (shared !== undefined) {
      return shared;
    }
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
