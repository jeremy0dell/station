// Installs/uninstalls the STATION hook into Codex's hook config.
// Upstream hook contract: https://developers.openai.com/codex/hooks
// STATION ingress flow: docs/harness-ingress.md. Generated command + payload must match the ingress parser.
import {
  createHookSetupFileOps,
  expectedProviderHookScript,
  hookCommandsForEvents,
  installConfigScriptHook,
  type ProviderHookScriptOptions,
  planConfigScriptHook,
  providerHookInvocationMatchesIgnoringBin,
  providerHookScriptOptions,
  uninstallConfigScriptHook,
} from "@station/runtime";
import {
  documentContainsCommand,
  generatedStationHookEvents,
  installCodexHookCommands,
  missingCodexHookEvents,
  parseTomlDocument,
  removeGeneratedCodexHookCommands,
  stringifyTomlDocument,
} from "./hooks/hookConfigEditor.js";
import {
  CODEX_HOOK_EVENT_NAMES,
  CODEX_STATION_PROFILE_NAME,
  type CodexHookEventName,
} from "./hooks/hookConstants.js";
import { CodexHookSetupError } from "./hooks/hookErrors.js";
import {
  resolveCodexBaseConfigPath,
  resolveCodexConfigPath,
  resolveCodexHookScriptPath,
} from "./hooks/hookPaths.js";

export { CODEX_HOOK_EVENT_NAMES, type CodexHookEventName } from "./hooks/hookConstants.js";
export { CodexHookSetupError, type CodexHookSetupErrorCode } from "./hooks/hookErrors.js";
export {
  resolveCodexBaseConfigPath,
  resolveCodexConfigPath,
  resolveCodexHookScriptPath,
} from "./hooks/hookPaths.js";
export { expectedCodexHookCommands, expectedCodexHookScript };

export type CodexHookPlanOptions = {
  codexConfigPath?: string;
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

export type CodexGeneratedGlobalHookCleanup = {
  configPath: string;
  changed: boolean;
  stale: CodexHookEventName[];
  before: string;
  after: string;
  skipped?: boolean;
  reason?: "same-as-profile";
};

export type CodexHookPlan = {
  provider: "codex";
  configPath: string;
  profileName: typeof CODEX_STATION_PROFILE_NAME;
  profileConfigPath: string;
  baseConfigPath: string;
  hookScriptPath: string;
  commands: Record<CodexHookEventName, string>;
  missing: CodexHookEventName[];
  changed: boolean;
  configChanged: boolean;
  generatedGlobalChanged: boolean;
  scriptChanged: boolean;
  generatedGlobalCleanup: CodexGeneratedGlobalHookCleanup;
  before: string;
  after: string;
};

export type CodexHookInstallResult = CodexHookPlan & {
  installed: boolean;
  backupPath?: string;
  profileBackupPath?: string;
  baseBackupPath?: string;
  backupPaths?: string[];
  scriptRemoved?: boolean;
};

export type CodexHookDoctorResult = {
  provider: "codex";
  configPath: string;
  profileName: typeof CODEX_STATION_PROFILE_NAME;
  profileConfigPath: string;
  baseConfigPath: string;
  hookScriptPath: string;
  status: "ok" | "warn";
  installed: boolean;
  missing: CodexHookEventName[];
  commands: Record<CodexHookEventName, string>;
  generatedGlobalCleanup: CodexGeneratedGlobalHookCleanup;
  message: string;
};

export type CodexHookScriptOptions = ProviderHookScriptOptions & {
  hookScriptPath: string;
};

const fileOps = createHookSetupFileOps(({ operation, cause }) => {
  if (operation === "read" || operation === "metadata") {
    return new CodexHookSetupError(
      "CODEX_HOOK_CONFIG_UNREADABLE",
      operation === "read"
        ? "Codex hook config could not be read."
        : "Codex hook config metadata could not be read.",
      { cause },
    );
  }
  return new CodexHookSetupError(
    "CODEX_HOOK_WRITE_FAILED",
    operation === "remove"
      ? "Codex hook script could not be removed."
      : operation === "writeScript"
        ? "Codex hook script could not be written."
        : operation === "backup"
          ? "Codex hook config backup could not be written."
          : "Codex hook config could not be written.",
    { cause },
  );
});

export async function planCodexHooks(options: CodexHookPlanOptions = {}): Promise<CodexHookPlan> {
  const configPath = resolveCodexConfigPath(options);
  const baseConfigPath = resolveCodexBaseConfigPath(options);
  const hookScriptPath = resolveCodexHookScriptPath(options);
  const script = expectedCodexHookScript(providerHookScriptOptions(hookScriptPath, options));
  const commands = expectedCodexHookCommands({ hookScriptPath });
  const generatedGlobalCleanup = await buildGeneratedGlobalHookCleanup({
    baseConfigPath,
    profileConfigPath: configPath,
    commands,
  });
  const plan = await planConfigScriptHook({
    readOptionalFile: fileOps.readOptionalFile,
    configPath,
    hookScriptPath,
    parseDocument: parseTomlDocument,
    installCommands: installCodexHookCommands,
    stringifyDocument: stringifyTomlDocument,
    missingEvents: missingCodexHookEvents,
    expectedCommands: (path) => expectedCodexHookCommands({ hookScriptPath: path }),
    expectedScript: script,
    extraChanged: generatedGlobalCleanup.changed,
  });

  return {
    provider: "codex",
    configPath,
    profileName: CODEX_STATION_PROFILE_NAME,
    profileConfigPath: configPath,
    baseConfigPath,
    hookScriptPath,
    commands: plan.commands,
    missing: plan.missing,
    changed: plan.changed,
    configChanged: plan.configChanged,
    generatedGlobalChanged: generatedGlobalCleanup.changed,
    scriptChanged: plan.scriptChanged,
    generatedGlobalCleanup,
    before: plan.before,
    after: plan.after,
  };
}

export async function installCodexHooks(
  options: CodexHookPlanOptions = {},
): Promise<CodexHookInstallResult> {
  const plan = await planCodexHooks(options);
  const profileBackupPath = await installConfigScriptHook({
    configPath: plan.configPath,
    hookScriptPath: plan.hookScriptPath,
    after: plan.after,
    expectedScript: expectedCodexHookScript(
      providerHookScriptOptions(plan.hookScriptPath, options),
    ),
    configChanged: plan.configChanged,
    scriptChanged: plan.scriptChanged,
    fileOps,
  });
  let baseBackupPath: string | undefined;
  if (plan.generatedGlobalCleanup.changed) {
    baseBackupPath = await fileOps.backupIfPresent(plan.baseConfigPath);
    await fileOps.writeHookConfig(plan.baseConfigPath, plan.generatedGlobalCleanup.after);
  }

  const result = installResultFromPlan(plan, true);
  assignBackupPaths(result, { profileBackupPath, baseBackupPath });
  return result;
}

export async function uninstallCodexHooks(
  options: CodexHookPlanOptions = {},
): Promise<CodexHookInstallResult> {
  const configPath = resolveCodexConfigPath(options);
  const baseConfigPath = resolveCodexBaseConfigPath(options);
  const hookScriptPath = resolveCodexHookScriptPath(options);
  const commands = expectedCodexHookCommands({ hookScriptPath });
  const generatedGlobalCleanup = await buildGeneratedGlobalHookCleanup({
    baseConfigPath,
    profileConfigPath: configPath,
    commands,
  });
  const plan = await uninstallConfigScriptHook({
    readOptionalFile: fileOps.readOptionalFile,
    configPath,
    hookScriptPath,
    parseDocument: parseTomlDocument,
    removeCommands: removeGeneratedCodexHookCommands,
    stringifyDocument: stringifyTomlDocument,
    missingEvents: missingCodexHookEvents,
    documentContainsCommand,
    expectedCommands: (path) => expectedCodexHookCommands({ hookScriptPath: path }),
    fileOps,
  });
  let baseBackupPath: string | undefined;
  if (generatedGlobalCleanup.changed) {
    baseBackupPath = await fileOps.backupIfPresent(baseConfigPath);
    await fileOps.writeHookConfig(baseConfigPath, generatedGlobalCleanup.after);
  }

  const result: CodexHookInstallResult = {
    provider: "codex",
    configPath,
    profileName: CODEX_STATION_PROFILE_NAME,
    profileConfigPath: configPath,
    baseConfigPath,
    hookScriptPath,
    commands: plan.commands,
    missing: plan.missing,
    changed: plan.changed || generatedGlobalCleanup.changed,
    configChanged: plan.configChanged,
    generatedGlobalChanged: generatedGlobalCleanup.changed,
    scriptChanged: plan.scriptRemoved,
    generatedGlobalCleanup,
    before: plan.before,
    after: plan.after,
    installed: false,
    scriptRemoved: plan.scriptRemoved,
  };
  assignBackupPaths(result, { profileBackupPath: plan.backupPath, baseBackupPath });
  return result;
}

export async function doctorCodexHooks(
  options: CodexHookPlanOptions & { enabled?: boolean } = {},
): Promise<CodexHookDoctorResult> {
  const plan = await planCodexHooks(options);
  const generatedGlobalInstalled = plan.generatedGlobalCleanup.stale.length > 0;
  if (options.enabled === false) {
    return {
      provider: "codex",
      configPath: plan.configPath,
      profileName: plan.profileName,
      profileConfigPath: plan.profileConfigPath,
      baseConfigPath: plan.baseConfigPath,
      hookScriptPath: plan.hookScriptPath,
      status: generatedGlobalInstalled ? "warn" : "ok",
      installed: false,
      missing: plan.missing,
      commands: plan.commands,
      generatedGlobalCleanup: plan.generatedGlobalCleanup,
      message: generatedGlobalInstalled
        ? "Codex hooks are not requested in station config, but generated global Codex hooks remain in the base config."
        : "Codex hooks are not requested in station config.",
    };
  }

  const scriptBefore = await fileOps.readOptionalFile(plan.hookScriptPath);
  const scriptInstalled = providerHookInvocationMatchesIgnoringBin(
    scriptBefore,
    expectedCodexHookScript(providerHookScriptOptions(plan.hookScriptPath, options)),
    "codex",
  );
  const installed = plan.missing.length === 0 && scriptInstalled;
  return {
    provider: "codex",
    configPath: plan.configPath,
    profileName: plan.profileName,
    profileConfigPath: plan.profileConfigPath,
    baseConfigPath: plan.baseConfigPath,
    hookScriptPath: plan.hookScriptPath,
    status: installed && !generatedGlobalInstalled ? "ok" : "warn",
    installed,
    missing: plan.missing,
    commands: plan.commands,
    generatedGlobalCleanup: plan.generatedGlobalCleanup,
    message: doctorMessage({
      installed,
      generatedGlobalInstalled,
      plan: { ...plan, scriptChanged: !scriptInstalled },
    }),
  };
}

function expectedCodexHookCommands(input: {
  hookScriptPath: string;
}): Record<CodexHookEventName, string> {
  return hookCommandsForEvents(CODEX_HOOK_EVENT_NAMES, input.hookScriptPath);
}

function expectedCodexHookScript(input: CodexHookScriptOptions): string {
  return expectedProviderHookScript({ provider: "codex", options: input });
}

function installResultFromPlan(plan: CodexHookPlan, installed: boolean): CodexHookInstallResult {
  return {
    provider: plan.provider,
    configPath: plan.configPath,
    profileName: plan.profileName,
    profileConfigPath: plan.profileConfigPath,
    baseConfigPath: plan.baseConfigPath,
    hookScriptPath: plan.hookScriptPath,
    commands: plan.commands,
    missing: plan.missing,
    changed: plan.changed,
    configChanged: plan.configChanged,
    generatedGlobalChanged: plan.generatedGlobalChanged,
    scriptChanged: plan.scriptChanged,
    generatedGlobalCleanup: plan.generatedGlobalCleanup,
    before: plan.before,
    after: plan.after,
    installed,
  };
}

async function buildGeneratedGlobalHookCleanup(input: {
  baseConfigPath: string;
  profileConfigPath: string;
  commands: Record<CodexHookEventName, string>;
}): Promise<CodexGeneratedGlobalHookCleanup> {
  if (input.baseConfigPath === input.profileConfigPath) {
    return {
      configPath: input.baseConfigPath,
      changed: false,
      stale: [],
      before: "",
      after: "",
      skipped: true,
      reason: "same-as-profile",
    };
  }

  const before = await fileOps.readOptionalFile(input.baseConfigPath);
  const document = parseTomlDocument(before);
  const stale = generatedStationHookEvents(document, input.commands);
  const afterDocument = removeGeneratedCodexHookCommands(document, input.commands);
  const after = stringifyTomlDocument(afterDocument);
  return {
    configPath: input.baseConfigPath,
    changed: before.trim() !== after.trim(),
    stale,
    before,
    after,
  };
}

function missingDescription(plan: CodexHookPlan): string {
  const missing = plan.missing.length === 0 ? "none" : plan.missing.join(", ");
  return plan.scriptChanged ? `${missing}; script is missing or stale` : missing;
}

function doctorMessage(input: {
  installed: boolean;
  generatedGlobalInstalled: boolean;
  plan: CodexHookPlan;
}): string {
  if (input.installed && input.generatedGlobalInstalled) {
    return "Codex hooks are installed in the station profile, but generated global Codex hooks remain in the base config.";
  }
  if (input.installed) {
    return "Codex hooks are installed in the station profile.";
  }

  const missing = missingDescription(input.plan);
  if (input.generatedGlobalInstalled) {
    return `Codex hooks are missing or stale in the station profile: ${missing}; generated global hooks remain in the base config.`;
  }
  return `Codex hooks are missing or stale in the station profile: ${missing}.`;
}

function assignBackupPaths(
  result: CodexHookInstallResult,
  paths: { profileBackupPath: string | undefined; baseBackupPath: string | undefined },
): void {
  const backupPaths: string[] = [];
  if (paths.profileBackupPath !== undefined) {
    result.backupPath = paths.profileBackupPath;
    result.profileBackupPath = paths.profileBackupPath;
    backupPaths.push(paths.profileBackupPath);
  }
  if (paths.baseBackupPath !== undefined) {
    result.baseBackupPath = paths.baseBackupPath;
    backupPaths.push(paths.baseBackupPath);
  }
  if (backupPaths.length > 0) {
    result.backupPaths = backupPaths;
  }
}
