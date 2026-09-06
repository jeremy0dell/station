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
  harnessCommandResolver,
  harnessHealth,
  healthDoctorCheck,
  hookDoctorCheck,
  type TerminalBoundHarnessCommandDefinition,
  type TerminalBoundHarnessProviderSpec,
} from "@station/harness-shared";
import { openCodeProviderErrorFromUnknown } from "./errors.js";
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
  canReceivePrompt: false,
  canResume: false,
  canStop: false,
  canRunNonInteractive: true,
  canExposeApprovalState: true,
  supportsModifiedEnterSoftNewline: false,
};

export const openCodeHarnessCommandDefinition = {
  id: "opencode",
  displayName: "OpenCode",
  commandEnvVar: "STATION_OPENCODE_BIN",
  commandFallback: "opencode",
} as const satisfies TerminalBoundHarnessCommandDefinition;

const openCodeSpec: TerminalBoundHarnessProviderSpec<OpenCodeHarnessProviderOptions> = {
  ...openCodeHarnessCommandDefinition,
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
  unknownStatusReason: "OpenCode run has no reliable OpenCode status signal yet.",
  doctorChecks,
  hooksStatus,
};

const command = harnessCommandResolver(openCodeHarnessCommandDefinition);

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
  checks.push(
    healthDoctorCheck(health, {
      name: "opencode.command",
      ok: "OpenCode command is available.",
      error: "OpenCode command is unavailable.",
    }),
  );

  checks.push(
    await hookDoctorCheck({
      name: "opencode-plugin",
      run: () => doctorOpenCodePlugin(openCodePluginDoctorOptions(options, context)),
      describe: (result) => `${result.message} Plugin: ${result.pluginPath}.`,
      failure: {
        tag: "OpenCodePluginSetupError",
        code: "OPENCODE_PLUGIN_DIAGNOSTIC_FAILED",
        message: "OpenCode plugin diagnostics failed.",
        provider: "opencode",
      },
    }),
  );
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
    if (requesterRuntime.artifactOwner !== undefined) {
      pluginOptions.artifactOwner = requesterRuntime.artifactOwner;
    }
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
    if (options.artifactOwner !== undefined) {
      pluginOptions.artifactOwner = options.artifactOwner;
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
  const status: HarnessHooksStatus = {
    provider: "opencode",
    requested,
    installed,
    missing: installed ? [] : [pluginResult.pluginPath],
    message: pluginResult.message,
  };
  if (pluginResult.ownership !== undefined) status.ownership = pluginResult.ownership;
  return status;
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
