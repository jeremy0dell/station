import type { HarnessCapabilities, HarnessPermissionMode } from "@station/contracts";
import {
  type CommonHarnessProviderOptions,
  hookOptions,
  type TerminalBoundHarnessProviderSpec,
  TerminalBoundHarnessProviderWithHooksStatus,
} from "@station/harness-shared";
import { classifyCodexRunStatus } from "./classify.js";
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
};

type CodexHookOptions = Parameters<typeof doctorCodexHooks>[0];
type CodexHookResult = Awaited<ReturnType<typeof doctorCodexHooks>>;

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

const codexProviderSpec = {
  id: "codex",
  displayName: "Codex",
  command: {
    envVar: "STATION_CODEX_BIN",
    fallback: "codex",
  },
  baseCapabilities,
  health: {
    args: ["login", "status"],
    unavailable: {
      code: "HARNESS_CODEX_UNAVAILABLE",
      message: "Codex is not available or is not logged in.",
      hint: "Install Codex and run `codex login status` to verify authentication.",
    },
    diagnostics: () => ({
      auth: "codex login status succeeded",
    }),
    okDoctorCheck: {
      name: "codex.login",
      okMessage: "Codex authentication is available.",
      errorMessage: "Codex is unavailable or not authenticated.",
    },
  },
  hooks: {
    doctor: doctorCodexHooks,
    buildOptions: (options, context) => hookOptions(options, context),
    checkName: "codex-hooks",
    failure: {
      tag: "CodexHookSetupError",
      code: "CODEX_HOOK_DIAGNOSTIC_FAILED",
      message: "Codex hook diagnostics failed.",
    },
    formatCheckMessage: (result) =>
      `${result.message} Profile config: ${result.profileConfigPath}. Base config: ${result.baseConfigPath}. Script: ${result.hookScriptPath}.`,
    exposeHooksStatus: true,
  },
  buildLaunchOptions: (options, command) => {
    const launchOptions: CodexLaunchOptions = { command };
    if (options.profile !== undefined) launchOptions.defaultProfile = options.profile;
    if (options.permissionMode !== undefined) {
      launchOptions.defaultPermissionMode = options.permissionMode;
    }
    if (options.installHooks === true) launchOptions.defaultHookProfile = CODEX_STATION_PROFILE;
    if (options.approvalPolicy !== undefined) {
      launchOptions.defaultApprovalPolicy = options.approvalPolicy;
    }
    if (options.sandboxMode !== undefined) launchOptions.defaultSandboxMode = options.sandboxMode;
    if (options.noAltScreen !== undefined) launchOptions.noAltScreen = options.noAltScreen;
    return launchOptions;
  },
  buildLaunch: buildCodexLaunchPlan,
  classifyRun: (run) => classifyCodexRunStatus(run),
  normalizeEvent: normalizeCodexRawEvent,
} satisfies TerminalBoundHarnessProviderSpec<
  CodexHarnessProviderOptions,
  CodexLaunchOptions,
  CodexHookOptions,
  CodexHookResult
>;

export class CodexHarnessProvider extends TerminalBoundHarnessProviderWithHooksStatus<
  CodexHarnessProviderOptions,
  CodexLaunchOptions,
  CodexHookOptions,
  CodexHookResult
> {
  constructor(options: CodexHarnessProviderOptions = {}) {
    super(codexProviderSpec, options);
  }
}
