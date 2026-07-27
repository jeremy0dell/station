// Installs/uninstalls the STATION hook into Cursor's .cursor/hooks.json.
// Upstream hook contract: https://cursor.com/docs/hooks
// STATION ingress flow: docs/harness-ingress.md. Generated command + payload must match the ingress parser.
import type { ProviderHookArtifactOwner } from "@station/contracts";
import {
  assignBackupPaths,
  classifyProviderHookArtifactOwnership,
  createHookSetupFileOps,
  expectedProviderHookScript,
  hookCommandsForEvents,
  installConfigScriptHook,
  type ProviderHookArtifactOwnership,
  type ProviderHookScriptOptions,
  planConfigScriptHook,
  providerHookScriptLauncher,
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

export type { CursorHookEventName } from "./hooks/hookConstants.js";
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
  artifactOwner?: ProviderHookArtifactOwner;
  takeover?: boolean;
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
  ownership?: ProviderHookArtifactOwnership;
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
  ownership?: ProviderHookArtifactOwnership;
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

  const legacyLauncher = providerHookScriptLauncher(scriptBefore, "cursor");
  const ownership =
    options.artifactOwner === undefined
      ? undefined
      : classifyProviderHookArtifactOwnership({
          contents: scriptBefore,
          requested: options.artifactOwner,
          ...(legacyLauncher === undefined ? {} : { legacyLauncher }),
        });
  const ownershipConflict =
    ownership?.status === "different-owner" || ownership?.status === "legacy-unknown";

  return {
    provider: "cursor",
    hooksPath: resolveCursorHooksPath(options),
    hookScriptPath,
    status: ownershipConflict ? "warn" : "ok",
    installed: !ownershipConflict,
    missing: [],
    commands: expectedCursorHookCommands({ hookScriptPath }),
    message: ownershipConflict
      ? "Cursor hook artifact ownership conflicts with this Station runtime; run `stn hooks install cursor --yes --takeover` only to transfer it."
      : "Cursor hooks are installed.",
    ...(ownership === undefined ? {} : { ownership }),
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
    provider: "cursor",
    ...(options.artifactOwner === undefined ? {} : { artifactOwner: options.artifactOwner }),
  });

  const result: CursorHookPlan = {
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
  if (plan.ownership !== undefined) result.ownership = plan.ownership;
  return result;
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
    provider: "cursor",
    ...(options.artifactOwner === undefined ? {} : { artifactOwner: options.artifactOwner }),
    ...(options.takeover === undefined ? {} : { takeover: options.takeover }),
  });
  const result: CursorHookInstallResult = { ...plan, installed: true };
  if (options.artifactOwner !== undefined) {
    result.ownership = {
      status: "same-owner",
      requested: options.artifactOwner,
      currentLauncher: options.artifactOwner.launcher,
    };
  }
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
    provider: "cursor",
    ...(options.artifactOwner === undefined ? {} : { artifactOwner: options.artifactOwner }),
    ...(options.takeover === undefined ? {} : { takeover: options.takeover }),
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
  const plan = await planCursorHooks(options);
  if (options.enabled === false) {
    return {
      provider: "cursor",
      hooksPath: plan.hooksPath,
      hookScriptPath: plan.hookScriptPath,
      status: "ok",
      installed: false,
      missing: [],
      commands: plan.commands,
      message: "Cursor hooks are not requested in station config.",
      ...(plan.ownership === undefined ? {} : { ownership: plan.ownership }),
    };
  }

  const installed = plan.missing.length === 0 && !plan.configChanged && !plan.scriptChanged;
  const ownershipConflict =
    plan.ownership?.status === "different-owner" || plan.ownership?.status === "legacy-unknown";
  if (!installed) {
    const shared = await sharedGeneratedHookPlan(plan.before, options);
    if (shared !== undefined) {
      return shared;
    }
  }
  const result: CursorHookDoctorResult = {
    provider: "cursor",
    hooksPath: plan.hooksPath,
    hookScriptPath: plan.hookScriptPath,
    status: installed && !ownershipConflict ? "ok" : "warn",
    installed: installed && !ownershipConflict,
    missing: plan.missing,
    commands: plan.commands,
    message: ownershipConflict
      ? "Cursor hook artifact ownership conflicts with this Station runtime; run `stn hooks install cursor --yes --takeover` only to transfer it."
      : installed
        ? "Cursor hooks are installed."
        : `Cursor hooks are missing or stale: ${missingDescription(plan)}.`,
  };
  if (plan.ownership !== undefined) result.ownership = plan.ownership;
  return result;
}
