// Installs/uninstalls the STATION hook into Codex's hook config.
// Upstream hook contract: https://developers.openai.com/codex/hooks
// STATION ingress flow: docs/harness-ingress.md. Generated command + payload must match the ingress parser.
import { isAbsolute, resolve } from "node:path";
import type {
  ProviderHookArtifactOwner,
  ProviderHookArtifactOwnership,
  ProviderHookHealth,
  ProviderHookReconciliationResult,
  SafeError,
} from "@station/contracts";
import { ProviderHookHealthSchema } from "@station/contracts";
import {
  classifyProviderHookArtifactOwnership,
  commandLine,
  createHookSetupFileOps,
  expectedProviderHookScript,
  hookCommandsForEvents,
  installConfigScriptHook,
  normalizeCancellationError,
  ProviderHookArtifactOwnershipError,
  type ProviderHookScriptOptions,
  planConfigScriptHook,
  providerHookScriptOptions,
  publicSafeErrorFromUnknown,
  uninstallConfigScriptHook,
} from "@station/runtime";
import {
  documentContainsCommand,
  generatedStationHookCommands,
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
import { withCodexHookMutationLock } from "./hooks/hookMutationLock.js";
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
  signal?: AbortSignal;
  timeoutMs?: number;
  beginMutation?: () => void;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

export type CodexHookReconciliationOptions = Omit<CodexHookPlanOptions, "takeover"> & {
  enabled: boolean;
};

type CodexHookOperationBoundary = {
  signal?: AbortSignal;
  deadlineMs?: number;
  mutationStarted: boolean;
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
  return planCodexHooksWithinBoundary(options, createCodexHookOperationBoundary(options));
}

async function planCodexHooksWithinBoundary(
  options: CodexHookPlanOptions,
  boundary: CodexHookOperationBoundary,
): Promise<CodexHookPlan> {
  assertCodexHookOperationCanContinue(boundary);
  const configPath = resolveCodexConfigPath(options);
  const baseConfigPath = resolveCodexBaseConfigPath(options);
  const hookScriptPath = resolveCodexHookScriptPath(options);
  const readSignal = codexHookReadSignal(boundary);
  const script = expectedCodexHookScript(providerHookScriptOptions(hookScriptPath, options));
  const commands = expectedCodexHookCommands({ hookScriptPath });
  const generatedGlobalCleanup = await buildGeneratedGlobalHookCleanup(
    {
      baseConfigPath,
      profileConfigPath: configPath,
      commands,
    },
    boundary,
  );
  assertCodexHookOperationCanContinue(boundary);
  const plan = await planConfigScriptHook({
    readOptionalFile: fileOps.readOptionalFile,
    inspectOptionalFile: fileOps.inspectOptionalFile,
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
    ...(readSignal === undefined ? {} : { signal: readSignal }),
  });
  assertCodexHookOperationCanContinue(boundary);

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
  const ownership = await classifyCodexHookPlanOwnership(
    {
      requestedScriptPath: hookScriptPath,
      profileSource: plan.before,
      baseSource: generatedGlobalCleanup.before,
      ownScriptOwnership: plan.ownership,
      options,
    },
    boundary,
  );
  if (ownership !== undefined) result.ownership = ownership;
  assertCodexHookOperationCanContinue(boundary);
  return result;
}

export async function installCodexHooks(
  options: CodexHookPlanOptions = {},
): Promise<CodexHookInstallResult> {
  const boundary = createCodexHookOperationBoundary(options);
  return withCodexHookMutationLock(
    codexHookMutationPaths(options),
    () => installCodexHooksUnlocked(options, boundary),
    hookMutationWaitContext(boundary),
  );
}

async function installCodexHooksUnlocked(
  options: CodexHookPlanOptions,
  boundary: CodexHookOperationBoundary,
  onMutationCommitted?: () => void,
): Promise<CodexHookInstallResult> {
  const plan = await planCodexHooksWithinBoundary(options, boundary);
  assertCodexHookPlanOwnership(plan, options, "install");
  const readSignal = codexHookReadSignal(boundary);
  const beginMutation = once(() => {
    assertCodexHookOperationCanContinue(boundary);
    options.beginMutation?.();
    assertCodexHookOperationCanContinue(boundary);
    boundary.mutationStarted = true;
  });
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
    beginMutation,
    ...(onMutationCommitted === undefined ? {} : { onMutationCommitted }),
    ...(readSignal === undefined ? {} : { signal: readSignal }),
  });
  let baseBackupPath: string | undefined;
  if (plan.generatedGlobalCleanup.changed) {
    beginMutation();
    baseBackupPath = await fileOps.backupIfPresent(plan.baseConfigPath);
    await fileOps.writeHookConfig(plan.baseConfigPath, plan.generatedGlobalCleanup.after);
    onMutationCommitted?.();
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

/** Runs the #645 install writer and provider doctor under one provider-owned lock. */
export async function repairCodexHooks(
  options: CodexHookPlanOptions,
  enabled: boolean,
): Promise<CodexHookRepairResult> {
  return runCodexHookRepair(options, enabled, createCodexHookOperationBoundary(options));
}

/** Maps Codex-native doctor evidence onto the provider-neutral read-only contract. */
export async function inspectCodexHookHealth(
  options: CodexHookReconciliationOptions,
): Promise<ProviderHookHealth> {
  if (!options.enabled) {
    return ProviderHookHealthSchema.parse({
      provider: "codex",
      status: "configured-disabled",
      followUp: { action: "enable-hooks" },
    });
  }
  const boundary = createCodexHookOperationBoundary(options);
  try {
    return codexHealthFromDoctor(await doctorCodexHooksWithinBoundary(options, boundary));
  } catch (cause) {
    rethrowCodexHookBoundaryInterruption(cause, boundary.signal);
    return ProviderHookHealthSchema.parse({
      provider: "codex",
      status: "inspection-failed",
      error: publicSafeErrorFromUnknown(cause, {
        tag: "CodexHookSetupError",
        code: "CODEX_HOOK_INSPECTION_FAILED",
        message: "Codex hook inspection failed.",
        provider: "codex",
      }),
      followUp: { action: "run-doctor" },
    });
  }
}

/** Reconciles Codex hooks without takeover and returns no provider-native paths or payloads. */
export async function reconcileCodexHooks(
  options: CodexHookReconciliationOptions,
): Promise<ProviderHookReconciliationResult> {
  if (!options.enabled) {
    return {
      provider: "codex",
      status: "configured-disabled",
      changed: false,
      verified: false,
      followUp: { action: "enable-hooks" },
    } satisfies ProviderHookReconciliationResult;
  }
  if (options.artifactOwner === undefined) {
    return reconciliationFailure(
      "inspection-failed",
      false,
      new CodexHookSetupError(
        "CODEX_HOOK_RECONCILIATION_OWNER_REQUIRED",
        "Codex hook reconciliation requires verified Station artifact ownership.",
      ),
    );
  }

  const reconciliationOptions = codexAutomaticReconciliationPlanOptions(options);
  const boundary = createCodexHookOperationBoundary(reconciliationOptions);
  let plan: CodexHookPlan;
  try {
    plan = await planCodexHooksWithinBoundary(reconciliationOptions, boundary);
  } catch (cause) {
    rethrowCodexHookBoundaryInterruption(cause, boundary.signal);
    return reconciliationFailure("inspection-failed", false, cause);
  }
  if (isOwnershipConflict(plan.ownership)) {
    return { ...ownershipConflictReconciliation };
  }

  let changed = false;
  try {
    const repaired = await runCodexHookRepair(reconciliationOptions, true, boundary, () => {
      changed = true;
    });
    if (repaired.verified) {
      return repaired.changed
        ? { provider: "codex", status: "repaired", changed: true, verified: true }
        : { provider: "codex", status: "healthy", changed: false, verified: true };
    }
    const failure = "error" in repaired ? repaired.error : undefined;
    return reconciliationFailure(
      "post-write-doctor-failed",
      repaired.changed,
      failure ?? new Error("Codex hook doctor did not verify the completed reconciliation."),
    );
  } catch (cause) {
    rethrowCodexHookBoundaryInterruption(cause, boundary.signal);
    if (isOwnershipConflictError(cause)) {
      return { ...ownershipConflictReconciliation };
    }
    return reconciliationFailure("write-failed", changed, cause);
  }
}

function codexAutomaticReconciliationPlanOptions(
  options: CodexHookReconciliationOptions,
): CodexHookPlanOptions {
  // Automatic reconciliation never gains takeover authority from an untyped runtime caller.
  const planOptions = { ...options } as CodexHookPlanOptions & { enabled?: boolean };
  delete planOptions.enabled;
  delete planOptions.takeover;
  return planOptions;
}

async function runCodexHookRepair(
  options: CodexHookPlanOptions,
  enabled: boolean,
  boundary: CodexHookOperationBoundary,
  onMutationCommitted?: () => void,
): Promise<CodexHookRepairResult> {
  return withCodexHookMutationLock(
    codexHookMutationPaths(options),
    async () => {
      const installed = await installCodexHooksUnlocked(options, boundary, onMutationCommitted);
      return verifyCodexHookInstallWithinBoundary(installed, options, enabled, boundary);
    },
    hookMutationWaitContext(boundary),
  );
}

export async function verifyCodexHookInstall(
  installResult: CodexHookInstallResult,
  options: CodexHookPlanOptions,
  enabled: boolean,
): Promise<CodexHookRepairResult> {
  return verifyCodexHookInstallWithinBoundary(
    installResult,
    options,
    enabled,
    createCodexHookOperationBoundary(options),
  );
}

async function verifyCodexHookInstallWithinBoundary(
  installResult: CodexHookInstallResult,
  options: CodexHookPlanOptions,
  enabled: boolean,
  boundary: CodexHookOperationBoundary,
): Promise<CodexHookRepairResult> {
  if (installResult.changed) {
    boundary.mutationStarted = true;
  }
  const doctorOptions: CodexHookPlanOptions & { enabled: boolean } = {
    ...options,
    codexConfigPath: installResult.profileConfigPath,
    hookScriptPath: installResult.hookScriptPath,
    enabled,
  };
  if (installResult.changed) {
    // A durable commit must finish verification even if its caller's budget expires.
    delete doctorOptions.signal;
    delete doctorOptions.timeoutMs;
    delete doctorOptions.beginMutation;
  }
  const repairCommand = codexHookRemediationCommand(options, installResult, "install");
  const uninstallCommand = codexHookRemediationCommand(options, installResult, "uninstall");
  const doctorCommand = codexHookDoctorCommand(options, installResult);

  try {
    const doctor = await doctorCodexHooksWithinBoundary(doctorOptions, boundary);
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
    rethrowCodexHookBoundaryInterruption(cause, boundary.signal);
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
  const boundary = createCodexHookOperationBoundary(options);
  return withCodexHookMutationLock(
    codexHookMutationPaths(options),
    () => uninstallCodexHooksUnlocked(options, boundary),
    hookMutationWaitContext(boundary),
  );
}

async function uninstallCodexHooksUnlocked(
  options: CodexHookPlanOptions,
  boundary: CodexHookOperationBoundary,
): Promise<CodexHookInstallResult> {
  const ownershipPlan = await planCodexHooksWithinBoundary(options, boundary);
  assertCodexHookPlanOwnership(ownershipPlan, options, "uninstall");
  const configPath = resolveCodexConfigPath(options);
  const baseConfigPath = resolveCodexBaseConfigPath(options);
  const hookScriptPath = resolveCodexHookScriptPath(options);
  const readSignal = codexHookReadSignal(boundary);
  const commands = expectedCodexHookCommands({ hookScriptPath });
  const generatedGlobalCleanup = await buildGeneratedGlobalHookCleanup(
    {
      baseConfigPath,
      profileConfigPath: configPath,
      commands,
    },
    boundary,
  );
  assertCodexHookOperationCanContinue(boundary);
  const beginMutation = once(() => {
    assertCodexHookOperationCanContinue(boundary);
    options.beginMutation?.();
    assertCodexHookOperationCanContinue(boundary);
    boundary.mutationStarted = true;
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
    beginMutation,
    ...(readSignal === undefined ? {} : { signal: readSignal }),
  });
  let baseBackupPath: string | undefined;
  if (generatedGlobalCleanup.changed) {
    beginMutation();
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
  return doctorCodexHooksWithinBoundary(options, createCodexHookOperationBoundary(options));
}

async function doctorCodexHooksWithinBoundary(
  options: CodexHookPlanOptions & { enabled?: boolean },
  boundary: CodexHookOperationBoundary,
): Promise<CodexHookDoctorResult> {
  const plan = await planCodexHooksWithinBoundary(options, boundary);
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
      ? `Codex hook artifact ownership conflicts with this Station runtime; run \`${codexHookTakeoverCommand(options, plan)}\` only to transfer it.`
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

async function buildGeneratedGlobalHookCleanup(
  input: {
    baseConfigPath: string;
    profileConfigPath: string;
    commands: Record<CodexForwardedEventType, string>;
  },
  boundary: CodexHookOperationBoundary,
): Promise<CodexGeneratedGlobalHookCleanup> {
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

  const before = await fileOps.readOptionalFile(
    input.baseConfigPath,
    codexHookReadOptions(boundary),
  );
  assertCodexHookOperationCanContinue(boundary);
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

function codexHookTakeoverCommand(options: CodexHookPlanOptions, plan: CodexHookPlan): string {
  const args = ["stn"];
  if (options.stationConfigPath !== undefined) {
    args.push("--config", options.stationConfigPath);
  }
  args.push(
    "hooks",
    "install",
    "codex",
    "--yes",
    "--takeover",
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

function codexHookMutationPaths(options: CodexHookPlanOptions): string[] {
  return [
    resolveCodexConfigPath(options),
    resolveCodexBaseConfigPath(options),
    resolveCodexHookScriptPath(options),
  ];
}

async function classifyCodexHookPlanOwnership(
  input: {
    requestedScriptPath: string;
    profileSource: string;
    baseSource: string;
    ownScriptOwnership: ProviderHookArtifactOwnership | undefined;
    options: CodexHookPlanOptions;
  },
  boundary: CodexHookOperationBoundary,
): Promise<ProviderHookArtifactOwnership | undefined> {
  const requested = input.options.artifactOwner;
  if (requested === undefined) return input.ownScriptOwnership;

  const referencedScripts = new Set([
    ...generatedStationHookCommands(parseTomlDocument(input.profileSource)),
    ...generatedStationHookCommands(parseTomlDocument(input.baseSource)),
  ]);
  const ownerships: ProviderHookArtifactOwnership[] = [];
  if (input.ownScriptOwnership !== undefined) ownerships.push(input.ownScriptOwnership);

  for (const scriptPath of referencedScripts) {
    if (!isAbsolute(scriptPath)) {
      ownerships.push({ status: "unknown-owner", requested });
      continue;
    }
    if (resolve(scriptPath) === resolve(input.requestedScriptPath)) continue;
    const contents = await fileOps.readOptionalFile(scriptPath, codexHookReadOptions(boundary));
    assertCodexHookOperationCanContinue(boundary);
    const ownership = classifyProviderHookArtifactOwnership({ contents, requested });
    ownerships.push(
      ownership.status === "absent" ? { status: "unknown-owner", requested } : ownership,
    );
  }

  return strongestCodexHookOwnership(ownerships, requested);
}

function strongestCodexHookOwnership(
  ownerships: readonly ProviderHookArtifactOwnership[],
  requested: ProviderHookArtifactOwner,
): ProviderHookArtifactOwnership {
  return (
    ownerships.find((ownership) => ownership.status === "different-owner") ??
    ownerships.find((ownership) => ownership.status === "unknown-owner") ??
    ownerships.find((ownership) => ownership.status === "same-owner") ?? {
      status: "absent",
      requested,
    }
  );
}

function assertCodexHookPlanOwnership(
  plan: CodexHookPlan,
  options: CodexHookPlanOptions,
  action: "install" | "uninstall",
): void {
  if (options.takeover === true || !isOwnershipConflict(plan.ownership)) return;
  throw new ProviderHookArtifactOwnershipError({
    provider: "codex",
    action,
    artifactPath: plan.profileConfigPath,
    ownership: plan.ownership,
  });
}

function hookMutationWaitContext(boundary: CodexHookOperationBoundary): {
  signal?: AbortSignal;
  deadlineMs?: number;
} {
  const context: { signal?: AbortSignal; deadlineMs?: number } = {};
  if (boundary.signal !== undefined) context.signal = boundary.signal;
  if (boundary.deadlineMs !== undefined) context.deadlineMs = boundary.deadlineMs;
  return context;
}

function codexHookReadSignal(boundary: CodexHookOperationBoundary): AbortSignal | undefined {
  return boundary.mutationStarted ? undefined : boundary.signal;
}

function codexHookReadOptions(
  boundary: CodexHookOperationBoundary,
): { signal: AbortSignal } | undefined {
  const signal = codexHookReadSignal(boundary);
  return signal === undefined ? undefined : { signal };
}

function createCodexHookOperationBoundary(
  options: CodexHookPlanOptions,
): CodexHookOperationBoundary {
  const boundary: CodexHookOperationBoundary = { mutationStarted: false };
  if (options.signal !== undefined) boundary.signal = options.signal;
  if (options.timeoutMs !== undefined) {
    boundary.deadlineMs = performance.now() + Math.max(0, options.timeoutMs);
  }
  return boundary;
}

function assertCodexHookOperationCanContinue(boundary: CodexHookOperationBoundary): void {
  if (boundary.mutationStarted) return;
  if (boundary.signal?.aborted) {
    throw (
      boundary.signal.reason ??
      new CodexHookSetupError(
        "CODEX_HOOK_RECONCILIATION_CANCELLED",
        "Codex hook reconciliation was cancelled before mutation.",
      )
    );
  }
  if (boundary.deadlineMs !== undefined && performance.now() >= boundary.deadlineMs) {
    throw new CodexHookSetupError(
      "CODEX_HOOK_RECONCILIATION_TIMEOUT",
      "Codex hook reconciliation exceeded its deadline before mutation.",
    );
  }
}

function rethrowCodexHookBoundaryInterruption(
  cause: unknown,
  signal: AbortSignal | undefined,
): void {
  const cancellation = normalizeCancellationError(cause);
  if (
    cancellation !== undefined ||
    (cause instanceof CodexHookSetupError &&
      (cause.code === "CODEX_HOOK_RECONCILIATION_CANCELLED" ||
        cause.code === "CODEX_HOOK_RECONCILIATION_TIMEOUT")) ||
    (signal?.aborted === true && cause === signal.reason)
  ) {
    throw cancellation !== undefined && signal?.aborted ? (signal.reason ?? cause) : cause;
  }
}

function once(effect: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    effect();
  };
}

function codexHealthFromDoctor(doctor: CodexHookDoctorResult): ProviderHookHealth {
  if (isOwnershipConflict(doctor.ownership)) {
    return ProviderHookHealthSchema.parse({
      provider: "codex",
      status: "ownership-conflict",
      ownership: doctor.ownership.status,
      followUp: { action: "run-explicit-takeover" },
    });
  }
  if (doctor.status === "ok" && doctor.installed) {
    return ProviderHookHealthSchema.parse({ provider: "codex", status: "healthy" });
  }
  return ProviderHookHealthSchema.parse({
    provider: "codex",
    status: "needs-repair",
    reason:
      doctor.ownership?.status === "same-owner" || doctor.installed ? "owned-drift" : "missing",
  });
}

function reconciliationFailure(
  status: "inspection-failed" | "write-failed" | "post-write-doctor-failed",
  changed: boolean,
  cause: unknown,
): ProviderHookReconciliationResult {
  const fallbackByStatus = {
    "inspection-failed": {
      code: "CODEX_HOOK_INSPECTION_FAILED",
      message: "Codex hook inspection failed.",
    },
    "write-failed": {
      code: "CODEX_HOOK_WRITE_FAILED",
      message: "Codex hook reconciliation could not complete its writes.",
    },
    "post-write-doctor-failed": {
      code: "CODEX_HOOK_POST_WRITE_DOCTOR_FAILED",
      message: "Codex hook writes were not verified by provider doctor.",
    },
  } as const;
  const fallback = fallbackByStatus[status];
  const error = publicSafeErrorFromUnknown(cause, {
    tag: "CodexHookSetupError",
    code: fallback.code,
    message: fallback.message,
    provider: "codex",
  });
  const base = { provider: "codex", verified: false, error } satisfies {
    provider: "codex";
    verified: false;
    error: SafeError;
  };
  switch (status) {
    case "inspection-failed":
      return { ...base, status, changed: false, followUp: { action: "run-doctor" } };
    case "write-failed":
      return { ...base, status, changed, followUp: { action: "retry" } };
    case "post-write-doctor-failed":
      return { ...base, status, changed, followUp: { action: "run-doctor" } };
  }
}

const ownershipConflictReconciliation = {
  provider: "codex",
  status: "ownership-conflict",
  changed: false,
  verified: false,
  followUp: { action: "run-explicit-takeover" },
} satisfies ProviderHookReconciliationResult;

function isOwnershipConflict(
  ownership: ProviderHookArtifactOwnership | undefined,
): ownership is Extract<
  ProviderHookArtifactOwnership,
  { status: "different-owner" | "unknown-owner" }
> {
  return ownership?.status === "different-owner" || ownership?.status === "unknown-owner";
}

function isOwnershipConflictError(cause: unknown): boolean {
  return cause instanceof ProviderHookArtifactOwnershipError;
}
