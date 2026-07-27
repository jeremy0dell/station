// Installs/uninstalls the STATION hook into Claude Code's settings.json hooks.
// Upstream hook contract: https://code.claude.com/docs/en/hooks-guide
// STATION ingress flow: docs/harness-ingress.md. Generated command + payload must match the ingress parser.
import type { ProviderHookArtifactOwner, ProviderHookArtifactOwnership } from "@station/contracts";
import {
  assertProviderHookArtifactOwnership,
  classifyProviderHookArtifactOwnership,
  createHookSetupFileOps,
  expectedProviderHookScript,
  installConfigScriptHook,
  type ProviderHookScriptOptions,
  providerHookScriptLauncher,
  providerHookScriptOptions,
} from "@station/runtime";
import { CLAUDE_HOOK_EVENT_NAMES, type ClaudeHookEventName } from "./hooks/hookConstants.js";
import { ClaudeHookSetupError } from "./hooks/hookErrors.js";
import {
  resolveClaudeHookScriptPath,
  resolveClaudeSettingsArtifactPath,
  resolveClaudeUserSettingsPath,
} from "./hooks/hookPaths.js";
import {
  type ClaudeSettingsDocument,
  expectedClaudeHookSettings,
  generatedClaudeHookEvents,
  missingClaudeHookEvents,
  parseClaudeSettingsDocument,
  removeGeneratedClaudeHookEntries,
  settingsDocumentContainsCommand,
  stringifyClaudeSettings,
} from "./hooks/hookSettings.js";

export type { ClaudeHookEventName } from "./hooks/hookConstants.js";
export { resolveClaudeSettingsArtifactPath } from "./hooks/hookPaths.js";
export { expectedClaudeHookScript };

export type ClaudeHookPlanOptions = {
  claudeSettingsPath?: string;
  claudeConfigDir?: string;
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

export type ClaudeUserSettingsCleanup = {
  settingsPath: string;
  changed: boolean;
  stale: string[];
  before: string;
  after: string;
};

export type ClaudeHookPlan = {
  provider: "claude";
  settingsPath: string;
  userSettingsPath: string;
  hookScriptPath: string;
  events: readonly ClaudeHookEventName[];
  missing: ClaudeHookEventName[];
  changed: boolean;
  settingsChanged: boolean;
  scriptChanged: boolean;
  artifactInvalid: boolean;
  userSettingsCleanup: ClaudeUserSettingsCleanup;
  before: string;
  after: string;
  ownership?: ProviderHookArtifactOwnership;
};

export type ClaudeHookInstallResult = ClaudeHookPlan & {
  installed: boolean;
  backupPath?: string;
  userSettingsBackupPath?: string;
  backupPaths?: string[];
  scriptRemoved?: boolean;
  settingsRemoved?: boolean;
};

export type ClaudeHookDoctorResult = {
  provider: "claude";
  settingsPath: string;
  userSettingsPath: string;
  hookScriptPath: string;
  status: "ok" | "warn";
  installed: boolean;
  missing: ClaudeHookEventName[];
  artifactInvalid: boolean;
  userSettingsCleanup: ClaudeUserSettingsCleanup;
  message: string;
  ownership?: ProviderHookArtifactOwnership;
};

export type ClaudeHookScriptOptions = ProviderHookScriptOptions & {
  hookScriptPath: string;
};

const fileOps = createHookSetupFileOps(({ operation, cause }) => {
  if (operation === "read" || operation === "metadata") {
    return new ClaudeHookSetupError(
      "CLAUDE_HOOK_CONFIG_UNREADABLE",
      operation === "read"
        ? "Claude hook config could not be read."
        : "Claude hook config metadata could not be read.",
      { cause },
    );
  }
  return new ClaudeHookSetupError(
    "CLAUDE_HOOK_WRITE_FAILED",
    operation === "remove"
      ? "Claude hook file could not be removed."
      : operation === "writeScript"
        ? "Claude hook script could not be written."
        : operation === "backup"
          ? "Claude hook config backup could not be written."
          : "Claude hook config could not be written.",
    { cause },
  );
});

function parseArtifactDocument(contents: string): {
  document: ClaudeSettingsDocument;
  invalid: boolean;
} {
  try {
    return { document: parseClaudeSettingsDocument(contents), invalid: false };
  } catch {
    // Claude Code silently ignores settings files that fail validation in print
    // mode; an unparseable artifact must surface as drift, not a hard error.
    return { document: {}, invalid: true };
  }
}

async function buildUserSettingsCleanup(userSettingsPath: string): Promise<{
  cleanup: ClaudeUserSettingsCleanup;
  document: ClaudeSettingsDocument;
}> {
  const before = await fileOps.readOptionalFile(userSettingsPath);
  const { document } = parseArtifactDocument(before);
  const stale = generatedClaudeHookEvents(document);
  const afterDocument = removeGeneratedClaudeHookEntries(document);
  const after = before.trim().length === 0 ? "" : stringifyClaudeSettings(afterDocument);
  return {
    cleanup: {
      settingsPath: userSettingsPath,
      changed: stale.length > 0,
      stale,
      before,
      after,
    },
    document: afterDocument,
  };
}

function installResultFromPlan(plan: ClaudeHookPlan, installed: boolean): ClaudeHookInstallResult {
  return {
    provider: plan.provider,
    settingsPath: plan.settingsPath,
    userSettingsPath: plan.userSettingsPath,
    hookScriptPath: plan.hookScriptPath,
    events: plan.events,
    missing: plan.missing,
    changed: plan.changed,
    settingsChanged: plan.settingsChanged,
    scriptChanged: plan.scriptChanged,
    artifactInvalid: plan.artifactInvalid,
    userSettingsCleanup: plan.userSettingsCleanup,
    before: plan.before,
    after: plan.after,
    installed,
    ...(plan.ownership === undefined ? {} : { ownership: plan.ownership }),
  };
}

function doctorMessage(input: {
  installed: boolean;
  artifactInvalid: boolean;
  staleUserEntries: boolean;
  missing: ClaudeHookEventName[];
  scriptChanged: boolean;
}): string {
  if (input.artifactInvalid) {
    return "The station Claude settings artifact is invalid JSON; Claude Code silently ignores invalid settings files, so hooks would not fire. Re-run `stn hooks install claude --yes`.";
  }
  if (input.installed && input.staleUserEntries) {
    return "Claude hooks are installed in the station settings artifact, but generated station hooks remain in the user Claude settings.";
  }
  if (input.installed) {
    return "Claude hooks are installed in the station settings artifact.";
  }
  const missing = input.missing.length === 0 ? "none" : input.missing.join(", ");
  const description = input.scriptChanged ? `${missing}; script is missing or stale` : missing;
  if (input.staleUserEntries) {
    return `Claude hooks are missing or stale in the station settings artifact: ${description}; generated station hooks remain in the user Claude settings.`;
  }
  return `Claude hooks are missing or stale in the station settings artifact: ${description}.`;
}

function expectedClaudeHookScript(input: ClaudeHookScriptOptions): string {
  return expectedProviderHookScript({
    provider: "claude",
    options: input,
    ignoreFailure: true,
    redirectStderr: true,
  });
}

export async function planClaudeHooks(
  options: ClaudeHookPlanOptions = {},
): Promise<ClaudeHookPlan> {
  const settingsPath = resolveClaudeSettingsArtifactPath(options);
  const userSettingsPath = resolveClaudeUserSettingsPath(options);
  const hookScriptPath = resolveClaudeHookScriptPath(options);
  const before = await fileOps.readOptionalFile(settingsPath);
  const { document, invalid } = parseArtifactDocument(before);
  const after = stringifyClaudeSettings(expectedClaudeHookSettings({ hookScriptPath }));
  const script = expectedClaudeHookScript(providerHookScriptOptions(hookScriptPath, options));
  const scriptBefore = await fileOps.readOptionalFile(hookScriptPath);
  const settingsChanged = before.trim() !== after.trim();
  const scriptChanged = scriptBefore !== script;
  const legacyLauncher = providerHookScriptLauncher(scriptBefore, "claude");
  const ownership =
    options.artifactOwner === undefined
      ? undefined
      : classifyProviderHookArtifactOwnership({
          contents: scriptBefore,
          requested: options.artifactOwner,
          ...(legacyLauncher === undefined ? {} : { legacyLauncher }),
        });
  const { cleanup } = await buildUserSettingsCleanup(userSettingsPath);

  const result: ClaudeHookPlan = {
    provider: "claude",
    settingsPath,
    userSettingsPath,
    hookScriptPath,
    events: CLAUDE_HOOK_EVENT_NAMES,
    missing: missingClaudeHookEvents(document, hookScriptPath),
    changed: settingsChanged || scriptChanged || cleanup.changed,
    settingsChanged,
    scriptChanged,
    artifactInvalid: invalid,
    userSettingsCleanup: cleanup,
    before,
    after,
  };
  if (ownership !== undefined) result.ownership = ownership;
  return result;
}

export async function installClaudeHooks(
  options: ClaudeHookPlanOptions = {},
): Promise<ClaudeHookInstallResult> {
  const plan = await planClaudeHooks(options);
  const backupPath = await installConfigScriptHook({
    configPath: plan.settingsPath,
    hookScriptPath: plan.hookScriptPath,
    after: plan.after,
    expectedScript: expectedClaudeHookScript(
      providerHookScriptOptions(plan.hookScriptPath, options),
    ),
    configChanged: plan.settingsChanged,
    scriptChanged: plan.scriptChanged,
    fileOps,
    provider: "claude",
    ...(options.artifactOwner === undefined ? {} : { artifactOwner: options.artifactOwner }),
    ...(options.takeover === undefined ? {} : { takeover: options.takeover }),
  });
  let userSettingsBackupPath: string | undefined;

  if (plan.userSettingsCleanup.changed) {
    userSettingsBackupPath = await fileOps.backupIfPresent(plan.userSettingsPath);
    await fileOps.writeHookConfig(plan.userSettingsPath, plan.userSettingsCleanup.after);
  }

  const result = installResultFromPlan({ ...plan, missing: [], artifactInvalid: false }, true);
  if (options.artifactOwner !== undefined) {
    result.ownership = {
      status: "same-owner",
      requested: options.artifactOwner,
      currentLauncher: options.artifactOwner.launcher,
    };
  }
  const backupPaths: string[] = [];
  if (backupPath !== undefined) {
    result.backupPath = backupPath;
    backupPaths.push(backupPath);
  }
  if (userSettingsBackupPath !== undefined) {
    result.userSettingsBackupPath = userSettingsBackupPath;
    backupPaths.push(userSettingsBackupPath);
  }
  if (backupPaths.length > 0) {
    result.backupPaths = backupPaths;
  }
  return result;
}

export async function uninstallClaudeHooks(
  options: ClaudeHookPlanOptions = {},
): Promise<ClaudeHookInstallResult> {
  const settingsPath = resolveClaudeSettingsArtifactPath(options);
  const userSettingsPath = resolveClaudeUserSettingsPath(options);
  const hookScriptPath = resolveClaudeHookScriptPath(options);
  const before = await fileOps.readOptionalFile(settingsPath);
  const currentScript = await fileOps.readOptionalFile(hookScriptPath);
  const legacyLauncher = providerHookScriptLauncher(currentScript, "claude");
  assertProviderHookArtifactOwnership({
    provider: "claude",
    action: "uninstall",
    artifactPath: hookScriptPath,
    contents: currentScript,
    ...(options.artifactOwner === undefined ? {} : { requested: options.artifactOwner }),
    ...(legacyLauncher === undefined ? {} : { legacyLauncher }),
    ...(options.takeover === undefined ? {} : { takeover: options.takeover }),
  });
  const { cleanup, document: cleanedUserDocument } =
    await buildUserSettingsCleanup(userSettingsPath);
  let userSettingsBackupPath: string | undefined;

  const settingsRemoved = await fileOps.removeHookFileIfPresent(settingsPath);
  if (cleanup.changed) {
    userSettingsBackupPath = await fileOps.backupIfPresent(userSettingsPath);
    await fileOps.writeHookConfig(userSettingsPath, cleanup.after);
  }
  const scriptStillNeeded = settingsDocumentContainsCommand(cleanedUserDocument, hookScriptPath);
  const scriptRemoved = scriptStillNeeded
    ? false
    : await fileOps.removeHookFileIfPresent(hookScriptPath);

  const result: ClaudeHookInstallResult = {
    provider: "claude",
    settingsPath,
    userSettingsPath,
    hookScriptPath,
    events: CLAUDE_HOOK_EVENT_NAMES,
    missing: [...CLAUDE_HOOK_EVENT_NAMES],
    changed: settingsRemoved || cleanup.changed || scriptRemoved,
    settingsChanged: settingsRemoved,
    scriptChanged: scriptRemoved,
    artifactInvalid: false,
    userSettingsCleanup: cleanup,
    before,
    after: "",
    installed: false,
    scriptRemoved,
    settingsRemoved,
  };
  if (userSettingsBackupPath !== undefined) {
    result.userSettingsBackupPath = userSettingsBackupPath;
    result.backupPaths = [userSettingsBackupPath];
  }
  return result;
}

export async function doctorClaudeHooks(
  options: ClaudeHookPlanOptions & { enabled?: boolean } = {},
): Promise<ClaudeHookDoctorResult> {
  const plan = await planClaudeHooks(options);
  const staleUserEntries = plan.userSettingsCleanup.stale.length > 0;
  if (options.enabled === false) {
    return {
      provider: "claude",
      settingsPath: plan.settingsPath,
      userSettingsPath: plan.userSettingsPath,
      hookScriptPath: plan.hookScriptPath,
      status: staleUserEntries ? "warn" : "ok",
      installed: false,
      missing: plan.missing,
      artifactInvalid: plan.artifactInvalid,
      userSettingsCleanup: plan.userSettingsCleanup,
      message: staleUserEntries
        ? "Claude hooks are not requested in station config, but generated station hooks remain in the user Claude settings."
        : "Claude hooks are not requested in station config.",
      ...(plan.ownership === undefined ? {} : { ownership: plan.ownership }),
    };
  }

  const installed = !plan.settingsChanged && !plan.scriptChanged && !plan.artifactInvalid;
  const ownershipConflict =
    plan.ownership?.status === "different-owner" || plan.ownership?.status === "legacy-unknown";
  const result: ClaudeHookDoctorResult = {
    provider: "claude",
    settingsPath: plan.settingsPath,
    userSettingsPath: plan.userSettingsPath,
    hookScriptPath: plan.hookScriptPath,
    status: installed && !staleUserEntries && !ownershipConflict ? "ok" : "warn",
    installed: installed && !ownershipConflict,
    missing: plan.missing,
    artifactInvalid: plan.artifactInvalid,
    userSettingsCleanup: plan.userSettingsCleanup,
    message: ownershipConflict
      ? "Claude hook artifact ownership conflicts with this Station runtime; run `stn hooks install claude --yes --takeover` only to transfer it."
      : doctorMessage({
          installed,
          artifactInvalid: plan.artifactInvalid,
          staleUserEntries,
          missing: plan.missing,
          scriptChanged: plan.scriptChanged,
        }),
  };
  if (plan.ownership !== undefined) result.ownership = plan.ownership;
  return result;
}
