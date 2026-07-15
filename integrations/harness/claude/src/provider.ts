import type {
  BuildHarnessLaunchRequest,
  HarnessCapabilities,
  HarnessHooksStatus,
  HarnessLaunchPlan,
  HarnessProvider,
  ProviderDoctorCheck,
  ProviderDoctorContext,
} from "@station/contracts";
import {
  createTerminalBoundHarnessProvider,
  harnessCommand,
  harnessHealth,
  harnessHookDoctorOptions,
  harnessHooksStatusFrom,
  type TerminalBoundHarnessProviderSpec,
} from "@station/harness-shared";
import { runExternalCommand, safeErrorFromUnknown } from "@station/runtime";
import { classifyClaudeRunStatus } from "./classify.js";
import { claudeProviderErrorFromUnknown } from "./errors.js";
import { normalizeClaudeRawEvent } from "./events.js";
import { doctorClaudeHooks, resolveClaudeSettingsArtifactPath } from "./hooks.js";
import {
  buildClaudeLaunchPlan,
  type ClaudeLaunchOptions,
  type ClaudePermissionMode,
} from "./launch.js";
import { type ClaudeHarnessReadinessProviderOptions, parseClaudeAuthStatus } from "./readiness.js";

export type ClaudeHarnessProviderOptions = ClaudeHarnessReadinessProviderOptions & {
  profile?: string;
  permissionMode?: ClaudePermissionMode;
  approvalPolicy?: string;
  sandboxMode?: string;
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

const claudeSpec: TerminalBoundHarnessProviderSpec<ClaudeHarnessProviderOptions> = {
  id: "claude",
  displayName: "Claude Code",
  commandEnvVar: "STATION_CLAUDE_BIN",
  commandFallback: "claude",
  baseCapabilities,
  // Adapter support alone is not enough; resume stays invisible unless explicitly enabled
  // by [harness.claude].resume.
  resumeFromOptions: (options) => options.resume === true,
  health: {
    args: ["--version"],
    diagnostics: (result) => ({ version: result.stdout.trim() }),
    unavailableError: (error) =>
      claudeProviderErrorFromUnknown(error, {
        code: "HARNESS_CLAUDE_UNAVAILABLE",
        message: "Claude Code is not available.",
        hint: "Install Claude Code and ensure `claude --version` succeeds, or configure [harness.claude].command (env override: STATION_CLAUDE_BIN).",
      }),
  },
  buildLaunch,
  classifyRun: (run) => classifyClaudeRunStatus(run),
  ingestEvent: {
    operation: "provider.claude.ingestEvent",
    errorCode: "HARNESS_CLAUDE_EVENT_INGEST_FAILED",
    errorMessage: "The Claude Code harness provider failed to ingest an event.",
    normalize: (event, context) => normalizeClaudeRawEvent(event, context),
  },
  doctorChecks,
  hooksStatus,
};

function command(options: ClaudeHarnessProviderOptions): string {
  return harnessCommand(options, "STATION_CLAUDE_BIN", "claude");
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
  if (options.hookScriptPath !== undefined) {
    pathOptions.hookScriptPath = options.hookScriptPath;
  }
  if (options.stateDir !== undefined) {
    pathOptions.stateDir = options.stateDir;
  }
  if (options.env !== undefined) {
    pathOptions.env = options.env;
  }
  if (options.homeDir !== undefined) {
    pathOptions.homeDir = options.homeDir;
  }
  return pathOptions;
}

function claudeHookDoctorOptions(
  options: ClaudeHarnessProviderOptions,
  context?: ProviderDoctorContext,
): Parameters<typeof doctorClaudeHooks>[0] {
  return { ...harnessHookDoctorOptions(options, context), ...hookPathOptions(options) };
}

function buildLaunch(
  options: ClaudeHarnessProviderOptions,
  request: BuildHarnessLaunchRequest,
): HarnessLaunchPlan {
  const launchOptions: ClaudeLaunchOptions = { command: command(options) };
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
  if (options.installHooks === true) {
    launchOptions.hookSettingsPath = resolveClaudeSettingsArtifactPath(hookPathOptions(options));
  }
  return buildClaudeLaunchPlan(request, launchOptions);
}

async function doctorChecks(
  options: ClaudeHarnessProviderOptions,
  context?: ProviderDoctorContext,
): Promise<ProviderDoctorCheck[]> {
  const checks: ProviderDoctorCheck[] = [];
  const health = await harnessHealth(claudeSpec, options);
  if (health.status === "healthy") {
    checks.push({
      name: "claude.version",
      status: "ok",
      message: "Claude Code command is available.",
    });
  } else {
    const check: ProviderDoctorCheck = {
      name: "claude.version",
      status: "error",
      message: "Claude Code is unavailable.",
    };
    if (health.lastError !== undefined) {
      check.error = health.lastError;
    }
    checks.push(check);
    return checks;
  }

  // `claude --version` succeeds while logged out, so launchability needs a separate auth probe.
  try {
    const result = await runExternalCommand(
      {
        command: command(options),
        args: ["auth", "status"],
        timeoutMs: options.timeoutMs ?? 5000,
        maxOutputChars: 4096,
        allowedExitCodes: [0, 1],
      },
      options.runner,
    );
    const loggedIn = parseClaudeAuthStatus(result.stdout);
    if (loggedIn === true) {
      checks.push({
        name: "claude.auth",
        status: "ok",
        message: "Claude Code authentication is available.",
      });
    } else {
      checks.push({
        name: "claude.auth",
        status: "warn",
        message:
          "Claude Code does not report an authenticated login. Sessions will stall at a login screen; run `claude` once to log in.",
      });
    }
  } catch (cause) {
    checks.push({
      name: "claude.auth",
      status: "warn",
      message: "Claude Code authentication status could not be determined.",
      error: claudeProviderErrorFromUnknown(cause, {
        code: "HARNESS_CLAUDE_UNAVAILABLE",
        message: "`claude auth status` failed.",
      }),
    });
  }

  try {
    const hookResult = await doctorClaudeHooks(claudeHookDoctorOptions(options, context));
    checks.push({
      name: "claude-hooks",
      status: hookResult.status,
      message: `${hookResult.message} Settings artifact: ${hookResult.settingsPath}. User settings: ${hookResult.userSettingsPath}. Script: ${hookResult.hookScriptPath}.`,
    });
  } catch (cause) {
    checks.push({
      name: "claude-hooks",
      status: "error",
      message: "Claude hook diagnostics failed.",
      error: safeErrorFromUnknown(cause, {
        tag: "ClaudeHookSetupError",
        code: "CLAUDE_HOOK_DIAGNOSTIC_FAILED",
        message: "Claude hook diagnostics failed.",
        provider: "claude",
      }),
    });
  }
  return checks;
}

async function hooksStatus(
  options: ClaudeHarnessProviderOptions,
  context?: ProviderDoctorContext,
): Promise<HarnessHooksStatus> {
  const hookResult = await doctorClaudeHooks(claudeHookDoctorOptions(options, context));
  return harnessHooksStatusFrom("claude", options.installHooks === true, hookResult);
}

export function createClaudeHarnessProvider(
  options: ClaudeHarnessProviderOptions = {},
): HarnessProvider {
  return createTerminalBoundHarnessProvider(claudeSpec, options);
}
