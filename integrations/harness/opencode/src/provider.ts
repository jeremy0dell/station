import type { HarnessCapabilities, HarnessPermissionMode } from "@station/contracts";
import {
  type CommonHarnessProviderOptions,
  TerminalBoundHarnessProvider,
  type TerminalBoundHarnessProviderSpec,
} from "@station/harness-shared";
import { classifyOpenCodeRunStatus } from "./classify.js";
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
  env?: NodeJS.ProcessEnv;
};

type OpenCodePluginOptions = Parameters<typeof doctorOpenCodePlugin>[0];
type OpenCodePluginResult = Awaited<ReturnType<typeof doctorOpenCodePlugin>>;

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

const openCodeProviderSpec = {
  id: "opencode",
  displayName: "OpenCode",
  command: {
    envVar: "STATION_OPENCODE_BIN",
    fallback: "opencode",
  },
  baseCapabilities,
  health: {
    args: ["--version"],
    unavailable: {
      code: "HARNESS_OPENCODE_UNAVAILABLE",
      message: "OpenCode is not available.",
      hint: "Install OpenCode or configure [harness.opencode].command.",
    },
    diagnostics: () => ({
      command: "opencode --version succeeded",
    }),
    okDoctorCheck: {
      name: "opencode.command",
      okMessage: "OpenCode command is available.",
      errorMessage: "OpenCode command is unavailable.",
    },
  },
  hooks: {
    doctor: doctorOpenCodePlugin,
    buildOptions: openCodePluginOptions,
    checkName: "opencode-plugin",
    failure: {
      tag: "OpenCodePluginSetupError",
      code: "OPENCODE_PLUGIN_DIAGNOSTIC_FAILED",
      message: "OpenCode plugin diagnostics failed.",
    },
    formatCheckMessage: (result) => `${result.message} Plugin: ${result.pluginPath}.`,
  },
  buildLaunchOptions: (options, command) => {
    const launchOptions: OpenCodeLaunchOptions = { command };
    if (options.profile !== undefined) launchOptions.defaultProfile = options.profile;
    if (options.permissionMode !== undefined) {
      launchOptions.defaultPermissionMode = options.permissionMode;
    }
    if (options.approvalPolicy !== undefined) {
      launchOptions.defaultApprovalPolicy = options.approvalPolicy;
    }
    if (options.sandboxMode !== undefined) launchOptions.defaultSandboxMode = options.sandboxMode;
    if (options.configPath !== undefined) launchOptions.configPath = options.configPath;
    if (options.observerSocketPath !== undefined) {
      launchOptions.observerSocketPath = options.observerSocketPath;
    }
    if (options.stateDir !== undefined) launchOptions.stateDir = options.stateDir;
    if (options.hookSpoolDir !== undefined) launchOptions.hookSpoolDir = options.hookSpoolDir;
    return launchOptions;
  },
  buildLaunch: buildOpenCodeLaunchPlan,
  classifyRun: (run) => classifyOpenCodeRunStatus(run),
  normalizeEvent: normalizeOpenCodeRawEvent,
} satisfies TerminalBoundHarnessProviderSpec<
  OpenCodeHarnessProviderOptions,
  OpenCodeLaunchOptions,
  OpenCodePluginOptions,
  OpenCodePluginResult
>;

function openCodePluginOptions(options: OpenCodeHarnessProviderOptions): OpenCodePluginOptions {
  const pluginOptions: OpenCodePluginOptions = {
    enabled: options.installHooks === true,
    env: options.env ?? process.env,
  };
  if (options.observerSocketPath !== undefined) {
    pluginOptions.observerSocketPath = options.observerSocketPath;
  }
  if (options.stateDir !== undefined) pluginOptions.stateDir = options.stateDir;
  if (options.hookSpoolDir !== undefined) pluginOptions.hookSpoolDir = options.hookSpoolDir;
  return pluginOptions;
}

export class OpenCodeHarnessProvider extends TerminalBoundHarnessProvider<
  OpenCodeHarnessProviderOptions,
  OpenCodeLaunchOptions,
  OpenCodePluginOptions,
  OpenCodePluginResult
> {
  constructor(options: OpenCodeHarnessProviderOptions = {}) {
    super(openCodeProviderSpec, options);
  }
}
