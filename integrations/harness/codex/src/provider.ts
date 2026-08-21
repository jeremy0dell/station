import type {
  BuildHarnessLaunchRequest,
  HarnessCapabilities,
  HarnessHooksStatus,
  HarnessLaunchPlan,
  HarnessPermissionMode,
  HarnessProvider,
  ProviderDoctorCheck,
  ProviderDoctorContext,
  ProviderHookHealth,
  ProviderHookReconciliationResult,
} from "@station/contracts";
import {
  type CommonHarnessProviderOptions,
  createTerminalBoundHarnessProvider,
  harnessCommand,
  harnessHealth,
  harnessHookDoctorOptions,
  harnessHooksStatusFrom,
  type TerminalBoundHarnessCommandDefinition,
  type TerminalBoundHarnessProviderSpec,
} from "@station/harness-shared";
import { safeErrorFromUnknown } from "@station/runtime";
import { codexProviderErrorFromUnknown } from "./errors.js";
import { acceptsCodexPersistedEvent } from "./events.js";
import { doctorCodexHooks, inspectCodexHookHealth, reconcileCodexHooks } from "./hooks.js";
import { buildCodexLaunchPlan, type CodexLaunchOptions } from "./launch.js";

const CODEX_STATION_PROFILE = "station";

export type CodexHarnessProviderOptions = CommonHarnessProviderOptions & {
  profile?: string;
  permissionMode?: HarnessPermissionMode;
  approvalPolicy?: string;
  sandboxMode?: string;
  noAltScreen?: boolean;
  installHooks?: boolean;
  observerSocketPath?: string;
  stateDir?: string;
  hookSpoolDir?: string;
  autoStartFromHooks?: boolean;
  resume?: boolean;
};

const baseCapabilities: HarnessCapabilities = {
  canLaunch: true,
  canDiscoverRuns: true,
  canEmitEvents: true,
  canReceivePrompt: false,
  canResume: false,
  canStop: false,
  canRunNonInteractive: true,
  canExposeApprovalState: true,
  supportsModifiedEnterSoftNewline: true,
};

export const codexHarnessCommandDefinition = {
  id: "codex",
  displayName: "Codex",
  commandEnvVar: "STATION_CODEX_BIN",
  commandFallback: "codex",
} as const satisfies TerminalBoundHarnessCommandDefinition;

const codexSpec: TerminalBoundHarnessProviderSpec<CodexHarnessProviderOptions> = {
  ...codexHarnessCommandDefinition,
  baseCapabilities,
  // Adapter support alone is not enough; resume stays invisible unless explicitly enabled
  // by [harness.codex].resume.
  resumeFromOptions: (options) => options.resume === true,
  health: {
    args: ["login", "status"],
    diagnostics: () => ({ auth: "codex login status succeeded" }),
    unavailableError: (error) =>
      codexProviderErrorFromUnknown(error, {
        code: "HARNESS_CODEX_UNAVAILABLE",
        message: "Codex is not available or is not logged in.",
        hint: "Install Codex and run `codex login status` to verify authentication.",
      }),
  },
  buildLaunch,
  unknownStatusReason: "Codex run has no reliable Codex status signal yet.",
  acceptsPersistedEvent: acceptsCodexPersistedEvent,
  doctorChecks,
  hooksStatus,
  hookHealth,
  reconcileHooks: reconcileHooksForProvider,
  version: { latestPackage: "@openai/codex" },
};

function command(options: CodexHarnessProviderOptions): string {
  return harnessCommand(
    options,
    codexHarnessCommandDefinition.commandEnvVar,
    codexHarnessCommandDefinition.commandFallback,
  );
}

function buildLaunch(
  options: CodexHarnessProviderOptions,
  request: BuildHarnessLaunchRequest,
): HarnessLaunchPlan {
  const launchOptions: CodexLaunchOptions = { command: command(options) };
  if (options.profile !== undefined) {
    launchOptions.defaultProfile = options.profile;
  }
  if (options.permissionMode !== undefined) {
    launchOptions.defaultPermissionMode = options.permissionMode;
  }
  if (options.installHooks === true) {
    launchOptions.defaultHookProfile = CODEX_STATION_PROFILE;
  }
  if (options.approvalPolicy !== undefined) {
    launchOptions.defaultApprovalPolicy = options.approvalPolicy;
  }
  if (options.sandboxMode !== undefined) {
    launchOptions.defaultSandboxMode = options.sandboxMode;
  }
  if (options.noAltScreen !== undefined) {
    launchOptions.noAltScreen = options.noAltScreen;
  }
  if (options.observerSocketPath !== undefined) {
    launchOptions.observerSocketPath = options.observerSocketPath;
  }
  if (options.stateDir !== undefined) {
    launchOptions.stateDir = options.stateDir;
  }
  if (options.hookSpoolDir !== undefined) {
    launchOptions.hookSpoolDir = options.hookSpoolDir;
  }
  return buildCodexLaunchPlan(request, launchOptions);
}

async function doctorChecks(
  options: CodexHarnessProviderOptions,
  context?: ProviderDoctorContext,
): Promise<ProviderDoctorCheck[]> {
  const health = await harnessHealth(codexSpec, options);
  const checks: ProviderDoctorCheck[] = [];
  if (health.status === "healthy") {
    checks.push({
      name: "codex.login",
      status: "ok",
      message: "Codex authentication is available.",
    });
  } else {
    const check: ProviderDoctorCheck = {
      name: "codex.login",
      status: "error",
      message: "Codex is unavailable or not authenticated.",
    };
    if (health.lastError !== undefined) {
      check.error = health.lastError;
    }
    checks.push(check);
  }

  try {
    const hookResult = await doctorCodexHooks(harnessHookDoctorOptions(options, context));
    checks.push({
      name: "codex-hooks",
      status: hookResult.status,
      message: `${hookResult.message} Profile config: ${hookResult.profileConfigPath}. Base config: ${hookResult.baseConfigPath}. Script: ${hookResult.hookScriptPath}.`,
    });
  } catch (cause) {
    checks.push({
      name: "codex-hooks",
      status: "error",
      message: "Codex hook diagnostics failed.",
      error: safeErrorFromUnknown(cause, {
        tag: "CodexHookSetupError",
        code: "CODEX_HOOK_DIAGNOSTIC_FAILED",
        message: "Codex hook diagnostics failed.",
        provider: "codex",
      }),
    });
  }
  return checks;
}

async function hooksStatus(
  options: CodexHarnessProviderOptions,
  context?: ProviderDoctorContext,
): Promise<HarnessHooksStatus> {
  const hookResult = await doctorCodexHooks(harnessHookDoctorOptions(options, context));
  return harnessHooksStatusFrom("codex", options.installHooks === true, hookResult);
}

async function hookHealth(
  options: CodexHarnessProviderOptions,
  context?: ProviderDoctorContext,
): Promise<ProviderHookHealth> {
  return inspectCodexHookHealth(harnessHookDoctorOptions(options, context));
}

async function reconcileHooksForProvider(
  options: CodexHarnessProviderOptions,
  context?: ProviderDoctorContext,
): Promise<ProviderHookReconciliationResult> {
  return reconcileCodexHooks(harnessHookDoctorOptions(options, context));
}

/**
 * ADAPTER
 *
 * Supplies Codex launch, discovery, hook normalization, and compatibility admission through the harness port.
 */
export function createCodexHarnessProvider(
  options: CodexHarnessProviderOptions = {},
): HarnessProvider {
  return createTerminalBoundHarnessProvider(codexSpec, options);
}
