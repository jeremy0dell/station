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
  type TerminalBoundHarnessProviderSpec,
} from "@station/harness-shared";
import { safeErrorFromUnknown } from "@station/runtime";
import { classifyOpenCodeRunStatus } from "./classify.js";
import { openCodeProviderErrorFromUnknown } from "./errors.js";
import { normalizeOpenCodeRawEvent } from "./events.js";
import { buildOpenCodeLaunchPlan, type OpenCodeLaunchOptions } from "./launch.js";
import { doctorOpenCodePlugin } from "./pluginInstall.js";

export type OpenCodeHarnessProviderOptions = CommonHarnessProviderOptions & {
  profile?: string;
  permissionMode?: HarnessPermissionMode;
  approvalPolicy?: string;
  sandboxMode?: string;
  installHooks?: boolean;
  configPath?: string;
  observerSocketPath?: string;
  stateDir?: string;
  hookSpoolDir?: string;
  env?: NodeJS.ProcessEnv;
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
  supportsModifiedEnterSoftNewline: false,
};

const openCodeSpec: TerminalBoundHarnessProviderSpec<OpenCodeHarnessProviderOptions> = {
  id: "opencode",
  displayName: "OpenCode",
  commandEnvVar: "STATION_OPENCODE_BIN",
  commandFallback: "opencode",
  baseCapabilities,
  // Adapter support alone is not enough; resume stays invisible unless explicitly enabled
  // by [harness.opencode].resume.
  resumeFromOptions: (options) => options.resume === true,
  health: {
    args: ["--version"],
    diagnostics: () => ({ command: "opencode --version succeeded" }),
    unavailableError: (error) =>
      openCodeProviderErrorFromUnknown(error, {
        code: "HARNESS_OPENCODE_UNAVAILABLE",
        message: "OpenCode is not available.",
        hint: "Install OpenCode or configure [harness.opencode].command.",
      }),
  },
  buildLaunch,
  classifyRun: (run) => classifyOpenCodeRunStatus(run),
  ingestEvent: {
    operation: "provider.opencode.ingestEvent",
    errorCode: "HARNESS_OPENCODE_EVENT_INGEST_FAILED",
    errorMessage: "The OpenCode harness provider failed to ingest an event.",
    normalize: (event, context) => normalizeOpenCodeRawEvent(event, context),
  },
  doctorChecks,
  hooksStatus,
};

function command(options: OpenCodeHarnessProviderOptions): string {
  return harnessCommand(options, "STATION_OPENCODE_BIN", "opencode");
}

function buildLaunch(
  options: OpenCodeHarnessProviderOptions,
  request: BuildHarnessLaunchRequest,
): HarnessLaunchPlan {
  const launchOptions: OpenCodeLaunchOptions = { command: command(options) };
  if (options.profile !== undefined) {
    launchOptions.defaultProfile = options.profile;
  }
  if (options.permissionMode !== undefined) {
    launchOptions.defaultPermissionMode = options.permissionMode;
  }
  if (options.approvalPolicy !== undefined) {
    launchOptions.defaultApprovalPolicy = options.approvalPolicy;
  }
  if (options.sandboxMode !== undefined) {
    launchOptions.defaultSandboxMode = options.sandboxMode;
  }
  if (options.configPath !== undefined) {
    launchOptions.configPath = options.configPath;
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
  if (options.env !== undefined) {
    launchOptions.env = options.env;
  }
  return buildOpenCodeLaunchPlan(request, launchOptions);
}

async function doctorChecks(
  options: OpenCodeHarnessProviderOptions,
  context?: ProviderDoctorContext,
): Promise<ProviderDoctorCheck[]> {
  const checks: ProviderDoctorCheck[] = [];
  const health = await harnessHealth(openCodeSpec, options);
  if (health.status === "healthy") {
    checks.push({
      name: "opencode.command",
      status: "ok",
      message: "OpenCode command is available.",
    });
  } else {
    const check: ProviderDoctorCheck = {
      name: "opencode.command",
      status: "error",
      message: "OpenCode command is unavailable.",
    };
    if (health.lastError !== undefined) {
      check.error = health.lastError;
    }
    checks.push(check);
  }

  try {
    const pluginResult = await doctorOpenCodePlugin(openCodePluginDoctorOptions(options, context));
    checks.push({
      name: "opencode-plugin",
      status: pluginResult.status,
      message: `${pluginResult.message} Plugin: ${pluginResult.pluginPath}.`,
    });
  } catch (cause) {
    checks.push({
      name: "opencode-plugin",
      status: "error",
      message: "OpenCode plugin diagnostics failed.",
      error: safeErrorFromUnknown(cause, {
        tag: "OpenCodePluginSetupError",
        code: "OPENCODE_PLUGIN_DIAGNOSTIC_FAILED",
        message: "OpenCode plugin diagnostics failed.",
        provider: "opencode",
      }),
    });
  }
  return checks;
}

function openCodePluginDoctorOptions(
  options: OpenCodeHarnessProviderOptions,
  context?: ProviderDoctorContext,
): Parameters<typeof doctorOpenCodePlugin>[0] {
  const pluginOptions: Parameters<typeof doctorOpenCodePlugin>[0] = {
    enabled: options.installHooks === true,
    env: options.env ?? process.env,
  };
  const requesterRuntime = context?.providerHookRuntime;
  if (requesterRuntime !== undefined) {
    pluginOptions.observerSocketPath = requesterRuntime.observerSocketPath;
    pluginOptions.stateDir = requesterRuntime.stateDir;
    pluginOptions.hookSpoolDir = requesterRuntime.hookSpoolDir;
  } else {
    if (options.observerSocketPath !== undefined) {
      pluginOptions.observerSocketPath = options.observerSocketPath;
    }
    if (options.stateDir !== undefined) {
      pluginOptions.stateDir = options.stateDir;
    }
    if (options.hookSpoolDir !== undefined) {
      pluginOptions.hookSpoolDir = options.hookSpoolDir;
    }
  }
  return pluginOptions;
}

async function hooksStatus(
  options: OpenCodeHarnessProviderOptions,
  context?: ProviderDoctorContext,
): Promise<HarnessHooksStatus> {
  const pluginResult = await doctorOpenCodePlugin(openCodePluginDoctorOptions(options, context));
  const requested = options.installHooks === true;
  const installed = requested && pluginResult.installed && !pluginResult.changed;
  return {
    provider: "opencode",
    requested,
    installed,
    missing: installed ? [] : [pluginResult.pluginPath],
    message: pluginResult.message,
  };
}

/**
 * ADAPTER
 *
 * Supplies OpenCode launch, discovery, plugin-installation status, diagnostics, and event
 * normalization through the harness port.
 */
export function createOpenCodeHarnessProvider(
  options: OpenCodeHarnessProviderOptions = {},
): HarnessProvider {
  return createTerminalBoundHarnessProvider(openCodeSpec, options);
}
