import type {
  BuildHarnessLaunchRequest,
  HarnessCapabilities,
  HarnessHooksStatus,
  HarnessLaunchPlan,
  HarnessPermissionMode,
  HarnessProvider,
  ProviderDoctorCheck,
  ProviderDoctorContext,
} from "@station/contracts";
import {
  type CommonHarnessProviderOptions,
  createTerminalBoundHarnessProvider,
  harnessCommand,
  harnessHealth,
  harnessHookDoctorOptions,
  harnessHooksStatusFrom,
  type TerminalBoundHarnessProviderSpec,
} from "@station/harness-shared";
import { safeErrorFromUnknown } from "@station/runtime";
import { classifyCodexRunStatus } from "./classify.js";
import { codexProviderErrorFromUnknown } from "./errors.js";
import { normalizeCodexRawEvent } from "./events.js";
import { doctorCodexHooks } from "./hooks.js";
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
  canClassifyStatus: true,
  canReceivePrompt: false,
  canResume: false,
  canStop: false,
  canRunNonInteractive: true,
  canExposeApprovalState: true,
  supportsModifiedEnterSoftNewline: true,
};

const codexSpec: TerminalBoundHarnessProviderSpec<CodexHarnessProviderOptions> = {
  id: "codex",
  displayName: "Codex",
  commandEnvVar: "STATION_CODEX_BIN",
  commandFallback: "codex",
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
  classifyRun: (run) => classifyCodexRunStatus(run),
  ingestEvent: {
    operation: "provider.codex.ingestEvent",
    errorCode: "HARNESS_CODEX_EVENT_INGEST_FAILED",
    errorMessage: "The Codex harness provider failed to ingest an event.",
    normalize: (event, context) => normalizeCodexRawEvent(event, context),
  },
  doctorChecks,
  hooksStatus,
};

function command(options: CodexHarnessProviderOptions): string {
  return harnessCommand(options, "STATION_CODEX_BIN", "codex");
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

export function createCodexHarnessProvider(
  options: CodexHarnessProviderOptions = {},
): HarnessProvider {
  return createTerminalBoundHarnessProvider(codexSpec, options);
}
