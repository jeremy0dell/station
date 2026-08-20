// Installs/uninstalls the STATION hook into Codex's hook config.
// Upstream hook contract: https://developers.openai.com/codex/hooks
// STATION ingress flow: docs/harness-ingress.md. Generated command + payload must match the ingress parser.
import type {
  ProviderHookArtifactOwner,
  ProviderHookArtifactOwnership,
  SafeError,
} from "@station/contracts";
import {
  commandLine,
  createHookSetupFileOps,
  expectedProviderHookScript,
  hookCommandsForEvents,
  installConfigScriptHook,
  type ProviderHookScriptOptions,
  planConfigScriptHook,
  providerHookScriptOptions,
  publicSafeErrorFromUnknown,
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
  CODEX_OBSOLETE_HOOK_EVENT_NAMES,
  CODEX_STATION_PROFILE_NAME,
  type CodexForwardedEventType,
  type CodexGeneratedHookEventName,
  type CodexObsoleteHookEventName,
} from "./hooks/hookConstants.js";
import { CodexHookSetupError } from "./hooks/hookErrors.js";
import {
  resolveCodexBaseConfigPath,
  resolveCodexConfigPath,
  resolveCodexHookScriptPath,
} from "./hooks/hookPaths.js";

export type { CodexForwardedEventType } from "./hooks/hookConstants.js";
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
  artifactOwner?: ProviderHookArtifactOwner;
  takeover?: boolean;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

export type CodexGeneratedGlobalHookCleanup = {
  configPath: string;
  changed: boolean;
  stale: CodexGeneratedHookEventName[];
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
  commands: Record<CodexForwardedEventType, string>;
  missing: CodexForwardedEventType[];
  changed: boolean;
  configChanged: boolean;
  generatedGlobalChanged: boolean;
  scriptChanged: boolean;
  generatedGlobalCleanup: CodexGeneratedGlobalHookCleanup;
  before: string;
  after: string;
  ownership?: ProviderHookArtifactOwnership;
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
  missing: CodexForwardedEventType[];
  commands: Record<CodexForwardedEventType, string>;
  generatedGlobalCleanup: CodexGeneratedGlobalHookCleanup;
  message: string;
  ownership?: ProviderHookArtifactOwnership;
};

type CodexHookVerifiedRepairResult = CodexHookInstallResult & {
  status: "ok";
  verified: true;
  doctor: CodexHookDoctorResult;
  message: string;
};

type CodexHookUnverifiedRepairResult = CodexHookInstallResult & {
  status: "warn";
  verified: false;
  doctor: CodexHookDoctorResult;
  message: string;
};

type CodexHookVerificationErrorResult = CodexHookInstallResult & {
  status: "warn";
  verified: false;
  error: SafeError;
  message: string;
};

export type CodexHookRepairResult =
  | CodexHookVerifiedRepairResult
  | CodexHookUnverifiedRepairResult
  | CodexHookVerificationErrorResult;

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
    provider: "codex",
    ...(options.artifactOwner === undefined ? {} : { artifactOwner: options.artifactOwner }),
  });

  const result: CodexHookPlan = {
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
  if (plan.ownership !== undefined) result.ownership = plan.ownership;
  return result;
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
    provider: "codex",
    ...(options.artifactOwner === undefined ? {} : { artifactOwner: options.artifactOwner }),
    ...(options.takeover === undefined ? {} : { takeover: options.takeover }),
  });
  let baseBackupPath: string | undefined;
  if (plan.generatedGlobalCleanup.changed) {
    baseBackupPath = await fileOps.backupIfPresent(plan.baseConfigPath);
    await fileOps.writeHookConfig(plan.baseConfigPath, plan.generatedGlobalCleanup.after);
  }

  const result = installResultFromPlan(plan, true);
  if (options.artifactOwner !== undefined) {
    result.ownership = {
      status: "same-owner",
      requested: options.artifactOwner,
      currentLauncher: options.artifactOwner.launcher,
    };
  }
  assignBackupPaths(result, { profileBackupPath, baseBackupPath });
  return result;
}

export async function verifyCodexHookInstall(
  installResult: CodexHookInstallResult,
  options: CodexHookPlanOptions,
  enabled: boolean,
): Promise<CodexHookRepairResult> {
  const doctorOptions: CodexHookPlanOptions & { enabled: boolean } = {
    ...options,
    codexConfigPath: installResult.profileConfigPath,
    hookScriptPath: installResult.hookScriptPath,
    enabled,
  };
  const repairCommand = codexHookRemediationCommand(options, installResult, "install");
  const uninstallCommand = codexHookRemediationCommand(options, installResult, "uninstall");
  const doctorCommand = codexHookDoctorCommand(options, installResult);

  try {
    const doctor = await doctorCodexHooks(doctorOptions);
    if (doctor.status === "ok" && doctor.installed) {
      return {
        ...installResult,
        status: "ok",
        verified: true,
        doctor,
        message:
          "Codex hook writes completed and provider doctor verified the installed artifacts.",
      };
    }
    return {
      ...installResult,
      status: "warn",
      verified: false,
      doctor,
      message: codexHookVerificationFollowUp({
        detail: doctor.message,
        doctorCommand,
        repairCommand,
        uninstallCommand,
        enabled,
        ...(options.stationConfigPath === undefined
          ? {}
          : { stationConfigPath: options.stationConfigPath }),
      }),
    };
  } catch (cause) {
    const error = publicSafeErrorFromUnknown(cause, {
      tag: "CodexHookSetupError",
      code: "CODEX_HOOK_VERIFICATION_FAILED",
      message: "Codex hook provider doctor could not verify the completed writes.",
      provider: "codex",
    });
    return {
      ...installResult,
      status: "warn",
      verified: false,
      error,
      message: codexHookVerificationFollowUp({
        detail: error.message,
        doctorCommand,
        repairCommand,
        uninstallCommand,
        enabled,
        ...(options.stationConfigPath === undefined
          ? {}
          : { stationConfigPath: options.stationConfigPath }),
      }),
    };
  }
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
    provider: "codex",
    ...(options.artifactOwner === undefined ? {} : { artifactOwner: options.artifactOwner }),
    ...(options.takeover === undefined ? {} : { takeover: options.takeover }),
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
  const obsoleteEvents = obsoleteGeneratedHookEvents(plan);
  const obsoleteGeneratedInstalled = obsoleteEvents.length > 0;
  const obsoleteRemediation = codexHookRemediationCommand(
    options,
    plan,
    options.enabled === false ? "uninstall" : "install",
  );
  if (options.enabled === false) {
    const message = generatedGlobalInstalled
      ? "Codex hooks are not requested in station config, but generated global Codex hooks remain in the base config."
      : "Codex hooks are not requested in station config.";
    return {
      provider: "codex",
      configPath: plan.configPath,
      profileName: plan.profileName,
      profileConfigPath: plan.profileConfigPath,
      baseConfigPath: plan.baseConfigPath,
      hookScriptPath: plan.hookScriptPath,
      status: generatedGlobalInstalled || obsoleteGeneratedInstalled ? "warn" : "ok",
      installed: false,
      missing: plan.missing,
      commands: plan.commands,
      generatedGlobalCleanup: plan.generatedGlobalCleanup,
      message: withObsoleteHookRemediation(message, obsoleteEvents, obsoleteRemediation),
      ...(plan.ownership === undefined ? {} : { ownership: plan.ownership }),
    };
  }

  const installed = plan.missing.length === 0 && !plan.scriptChanged;
  const ownershipConflict =
    plan.ownership?.status === "different-owner" || plan.ownership?.status === "unknown-owner";
  const result: CodexHookDoctorResult = {
    provider: "codex",
    configPath: plan.configPath,
    profileName: plan.profileName,
    profileConfigPath: plan.profileConfigPath,
    baseConfigPath: plan.baseConfigPath,
    hookScriptPath: plan.hookScriptPath,
    status:
      installed && !generatedGlobalInstalled && !obsoleteGeneratedInstalled && !ownershipConflict
        ? "ok"
        : "warn",
    installed: installed && !ownershipConflict,
    missing: plan.missing,
    commands: plan.commands,
    generatedGlobalCleanup: plan.generatedGlobalCleanup,
    message: ownershipConflict
      ? `Codex hook artifact ownership conflicts with this Station runtime; run \`stn hooks install codex --yes --takeover\` only to transfer it.`
      : doctorMessage({
          installed,
          generatedGlobalInstalled,
          obsoleteEvents,
          obsoleteRemediation,
          plan,
        }),
  };
  if (plan.ownership !== undefined) result.ownership = plan.ownership;
  return result;
}

function expectedCodexHookCommands(input: {
  hookScriptPath: string;
}): Record<CodexForwardedEventType, string> {
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
    ...(plan.ownership === undefined ? {} : { ownership: plan.ownership }),
  };
}

async function buildGeneratedGlobalHookCleanup(input: {
  baseConfigPath: string;
  profileConfigPath: string;
  commands: Record<CodexForwardedEventType, string>;
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
  obsoleteEvents: CodexObsoleteHookEventName[];
  obsoleteRemediation: string;
  plan: CodexHookPlan;
}): string {
  if (input.installed && input.generatedGlobalInstalled) {
    return withObsoleteHookRemediation(
      "Codex hooks are installed in the station profile, but generated global Codex hooks remain in the base config.",
      input.obsoleteEvents,
      input.obsoleteRemediation,
    );
  }
  if (input.installed) {
    return withObsoleteHookRemediation(
      "Codex hooks are installed in the station profile.",
      input.obsoleteEvents,
      input.obsoleteRemediation,
    );
  }

  const missing = missingDescription(input.plan);
  if (input.generatedGlobalInstalled) {
    return withObsoleteHookRemediation(
      `Codex hooks are missing or stale in the station profile: ${missing}; generated global hooks remain in the base config.`,
      input.obsoleteEvents,
      input.obsoleteRemediation,
    );
  }
  return withObsoleteHookRemediation(
    `Codex hooks are missing or stale in the station profile: ${missing}.`,
    input.obsoleteEvents,
    input.obsoleteRemediation,
  );
}

function obsoleteGeneratedHookEvents(plan: CodexHookPlan): CodexObsoleteHookEventName[] {
  const profileEvents = generatedStationHookEvents(parseTomlDocument(plan.before), plan.commands);
  const generatedEvents = new Set([...profileEvents, ...plan.generatedGlobalCleanup.stale]);
  return CODEX_OBSOLETE_HOOK_EVENT_NAMES.filter((eventName) => generatedEvents.has(eventName));
}

function withObsoleteHookRemediation(
  message: string,
  obsoleteEvents: readonly CodexObsoleteHookEventName[],
  remediation: string,
): string {
  if (obsoleteEvents.length === 0) {
    return message;
  }
  return `${message} Obsolete generated Codex hook events remain: ${obsoleteEvents.join(", ")}. Run \`${remediation}\` to remove them.`;
}

function codexHookRemediationCommand(
  options: CodexHookPlanOptions,
  plan: CodexHookPlan,
  action: "install" | "uninstall",
): string {
  const args = ["stn"];
  if (options.stationConfigPath !== undefined) {
    args.push("--config", options.stationConfigPath);
  }
  args.push(
    "hooks",
    action,
    "codex",
    "--yes",
    "--codex-config",
    plan.profileConfigPath,
    "--hook-script",
    plan.hookScriptPath,
  );
  if (options.hookBin !== undefined) {
    args.push("--hook-bin", options.hookBin);
  }
  return commandLine(args);
}

function codexHookDoctorCommand(
  options: CodexHookPlanOptions,
  installResult: CodexHookInstallResult,
): string {
  const args = ["stn"];
  if (options.stationConfigPath !== undefined) {
    args.push("--config", options.stationConfigPath);
  }
  args.push(
    "hooks",
    "doctor",
    "codex",
    "--codex-config",
    installResult.profileConfigPath,
    "--hook-script",
    installResult.hookScriptPath,
  );
  if (options.hookBin !== undefined) {
    args.push("--hook-bin", options.hookBin);
  }
  return commandLine(args);
}

function codexHookVerificationFollowUp(input: {
  detail: string;
  doctorCommand: string;
  repairCommand: string;
  uninstallCommand: string;
  enabled: boolean;
  stationConfigPath?: string;
}): string {
  const prefix = `Codex hook writes completed, but provider verification requires manual follow-up. ${input.detail}`;
  if (!input.enabled) {
    const configLocation =
      input.stationConfigPath === undefined
        ? "the Station config used by this command"
        : JSON.stringify(input.stationConfigPath);
    return `${prefix} To keep these artifacts, set \`install_hooks = true\` under \`[harness.codex]\` in ${configLocation}, then run \`${input.repairCommand}\`. To remove them instead, run \`${input.uninstallCommand}\`. Run \`${input.doctorCommand}\` after choosing to check the same resolved artifacts before treating the repair as successful.`;
  }
  return `${prefix} Correct invalid configuration or ownership first if either is reported, then run \`${input.repairCommand}\` to repair the same resolved artifacts. Run \`${input.doctorCommand}\` afterward before treating the repair as successful.`;
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
