import type { HarnessCapabilities } from "@station/contracts";
import {
  type CommonHarnessProviderOptions,
  hookOptions,
  type TerminalBoundHarnessProviderSpec,
  TerminalBoundHarnessProviderWithHooksStatus,
} from "@station/harness-shared";
import { runExternalCommand } from "@station/runtime";
import { classifyClaudeRunStatus } from "./classify.js";
import { ClaudeHarnessProviderError } from "./errors.js";
import { normalizeClaudeRawEvent } from "./events.js";
import { doctorClaudeHooks, resolveClaudeSettingsArtifactPath } from "./hooks.js";
import {
  buildClaudeLaunchPlan,
  type ClaudeLaunchOptions,
  type ClaudePermissionMode,
} from "./launch.js";

export type ClaudeHarnessProviderOptions = CommonHarnessProviderOptions & {
  profile?: string;
  permissionMode?: ClaudePermissionMode;
  approvalPolicy?: string;
  sandboxMode?: string;
  claudeSettingsPath?: string;
  claudeConfigDir?: string;
};

type ClaudeHookOptions = Parameters<typeof doctorClaudeHooks>[0];
type ClaudeHookResult = Awaited<ReturnType<typeof doctorClaudeHooks>>;

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

const claudeProviderSpec = {
  id: "claude",
  displayName: "Claude Code",
  command: {
    envVar: "STATION_CLAUDE_BIN",
    fallback: "claude",
  },
  baseCapabilities,
  health: {
    args: ["--version"],
    unavailable: {
      code: "HARNESS_CLAUDE_UNAVAILABLE",
      message: "Claude Code is not available.",
      hint: "Install Claude Code and ensure `claude --version` succeeds, or configure [harness.claude].command (env override: STATION_CLAUDE_BIN).",
    },
    diagnostics: (result) => ({
      version: result.stdout.trim(),
    }),
    okDoctorCheck: {
      name: "claude.version",
      okMessage: "Claude Code command is available.",
      errorMessage: "Claude Code is unavailable.",
      stopOnFailure: true,
    },
  },
  hooks: {
    doctor: doctorClaudeHooks,
    buildOptions: claudeHookOptions,
    checkName: "claude-hooks",
    failure: {
      tag: "ClaudeHookSetupError",
      code: "CLAUDE_HOOK_DIAGNOSTIC_FAILED",
      message: "Claude hook diagnostics failed.",
    },
    formatCheckMessage: (result) =>
      `${result.message} Settings artifact: ${result.settingsPath}. User settings: ${result.userSettingsPath}. Script: ${result.hookScriptPath}.`,
    exposeHooksStatus: true,
  },
  extraDoctorChecks: async (options, provider) => {
    try {
      const result = await runExternalCommand(
        {
          command: provider.command(),
          args: ["auth", "status"],
          timeoutMs: options.timeoutMs ?? 5000,
          maxOutputChars: 4096,
        },
        options.runner,
      );
      const loggedIn = parseLoggedIn(result.stdout);
      if (loggedIn === true) {
        return [
          {
            name: "claude.auth",
            status: "ok",
            message: "Claude Code authentication is available.",
          },
        ];
      }
      return [
        {
          name: "claude.auth",
          status: "warn",
          message:
            "Claude Code does not report an authenticated login. Sessions will stall at a login screen; run `claude` once to log in.",
        },
      ];
    } catch (cause) {
      return [
        {
          name: "claude.auth",
          status: "warn",
          message: "Claude Code authentication status could not be determined.",
          error: new ClaudeHarnessProviderError(
            "HARNESS_CLAUDE_UNAVAILABLE",
            "`claude auth status` failed.",
            { cause },
          ),
        },
      ];
    }
  },
  buildLaunchOptions: (options, command) => {
    const launchOptions: ClaudeLaunchOptions = { command };
    if (options.profile !== undefined) launchOptions.defaultProfile = options.profile;
    if (options.permissionMode !== undefined) {
      launchOptions.defaultPermissionMode = options.permissionMode;
    }
    if (options.approvalPolicy !== undefined) {
      launchOptions.defaultApprovalPolicy = options.approvalPolicy;
    }
    if (options.sandboxMode !== undefined) launchOptions.defaultSandboxMode = options.sandboxMode;
    if (options.installHooks === true) {
      launchOptions.hookSettingsPath = resolveClaudeSettingsArtifactPath(hookPathOptions(options));
    }
    return launchOptions;
  },
  buildLaunch: buildClaudeLaunchPlan,
  classifyRun: (run) => classifyClaudeRunStatus(run),
  normalizeEvent: normalizeClaudeRawEvent,
} satisfies TerminalBoundHarnessProviderSpec<
  ClaudeHarnessProviderOptions,
  ClaudeLaunchOptions,
  ClaudeHookOptions,
  ClaudeHookResult
>;

function claudeHookOptions(
  options: ClaudeHarnessProviderOptions,
  context?: Parameters<typeof hookOptions>[1],
): ClaudeHookOptions {
  return {
    ...hookPathOptions(options),
    ...hookOptions(options, context),
  };
}

function hookPathOptions(
  options: ClaudeHarnessProviderOptions,
): Parameters<typeof resolveClaudeSettingsArtifactPath>[0] {
  const pathOptions: Parameters<typeof resolveClaudeSettingsArtifactPath>[0] = {};
  if (options.claudeSettingsPath !== undefined) {
    pathOptions.claudeSettingsPath = options.claudeSettingsPath;
  }
  if (options.claudeConfigDir !== undefined) {
    pathOptions.claudeConfigDir = options.claudeConfigDir;
  }
  if (options.stateDir !== undefined) pathOptions.stateDir = options.stateDir;
  return pathOptions;
}

function parseLoggedIn(stdout: string): boolean | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed === "object" && parsed !== null && "loggedIn" in parsed) {
      const loggedIn = (parsed as { loggedIn: unknown }).loggedIn;
      return typeof loggedIn === "boolean" ? loggedIn : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export class ClaudeHarnessProvider extends TerminalBoundHarnessProviderWithHooksStatus<
  ClaudeHarnessProviderOptions,
  ClaudeLaunchOptions,
  ClaudeHookOptions,
  ClaudeHookResult
> {
  constructor(options: ClaudeHarnessProviderOptions = {}) {
    super(claudeProviderSpec, options);
  }
}
