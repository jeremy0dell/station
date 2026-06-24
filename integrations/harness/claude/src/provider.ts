import type {
  BuildHarnessLaunchRequest,
  HarnessCapabilities,
  HarnessClassificationContext,
  HarnessDiscoveryContext,
  HarnessEventContext,
  HarnessEventObservation,
  HarnessHooksStatus,
  HarnessLaunchPlan,
  HarnessProvider,
  HarnessRunObservation,
  HarnessStatusObservation,
  ProviderDoctorCheck,
  ProviderDoctorContext,
  ProviderHealth,
  RawHarnessEvent,
} from "@station/contracts";
import { discoverTerminalBoundHarnessRuns } from "@station/contracts";
import {
  type ExternalCommandRunner,
  runExternalCommand,
  runRuntimeBoundary,
  safeErrorFromUnknown,
  systemClock,
  toIsoTimestamp,
} from "@station/runtime";
import { classifyClaudeRunStatus } from "./classify.js";
import { claudeProviderErrorFromUnknown } from "./errors.js";
import { normalizeClaudeRawEvent } from "./events.js";
import { doctorClaudeHooks, resolveClaudeSettingsArtifactPath } from "./hooks.js";
import {
  buildClaudeLaunchPlan,
  type ClaudeLaunchOptions,
  type ClaudePermissionMode,
} from "./launch.js";

export type ClaudeHarnessProviderOptions = {
  command?: string;
  profile?: string;
  permissionMode?: ClaudePermissionMode;
  approvalPolicy?: string;
  sandboxMode?: string;
  installHooks?: boolean;
  claudeSettingsPath?: string;
  claudeConfigDir?: string;
  observerSocketPath?: string;
  stateDir?: string;
  hookSpoolDir?: string;
  autoStartFromHooks?: boolean;
  resume?: boolean;
  now?: () => Date | string;
  timeoutMs?: number;
  runner?: ExternalCommandRunner;
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

function command(options: ClaudeHarnessProviderOptions): string {
  return options.command ?? process.env.STATION_CLAUDE_BIN ?? "claude";
}

function now(options: ClaudeHarnessProviderOptions): string {
  const value = options.now?.() ?? systemClock.now();
  return toIsoTimestamp(value instanceof Date ? value : new Date(value));
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
  if (options.stateDir !== undefined) {
    pathOptions.stateDir = options.stateDir;
  }
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

function capabilities(options: ClaudeHarnessProviderOptions): HarnessCapabilities {
  // Adapter support alone is not enough; resume stays invisible unless this
  // provider instance is explicitly enabled by [harness.claude].resume.
  return {
    ...baseCapabilities,
    canResume: options.resume === true,
  };
}

export class ClaudeHarnessProvider implements HarnessProvider {
  readonly id = "claude";

  readonly #options: ClaudeHarnessProviderOptions;

  constructor(options: ClaudeHarnessProviderOptions = {}) {
    this.#options = options;
  }

  capabilities(): HarnessCapabilities {
    return capabilities(this.#options);
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = now(this.#options);
    try {
      const result = await runExternalCommand(
        {
          command: command(this.#options),
          args: ["--version"],
          timeoutMs: this.#options.timeoutMs ?? 5000,
          maxOutputChars: 4096,
        },
        this.#options.runner,
      );
      return {
        providerId: this.id,
        providerType: "harness",
        status: "healthy",
        lastCheckedAt: checkedAt,
        capabilities: this.capabilities(),
        diagnostics: {
          version: result.stdout.trim(),
        },
      };
    } catch (error) {
      return {
        providerId: this.id,
        providerType: "harness",
        status: "unavailable",
        lastCheckedAt: checkedAt,
        lastError: claudeProviderErrorFromUnknown(error, {
          code: "HARNESS_CLAUDE_UNAVAILABLE",
          message: "Claude Code is not available.",
          hint: "Install Claude Code and ensure `claude --version` succeeds, or configure [harness.claude].command (env override: STATION_CLAUDE_BIN).",
        }),
        capabilities: this.capabilities(),
      };
    }
  }

  async doctorChecks(context?: ProviderDoctorContext): Promise<ProviderDoctorCheck[]> {
    const checks: ProviderDoctorCheck[] = [];
    const health = await this.health();
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
          command: command(this.#options),
          args: ["auth", "status"],
          timeoutMs: this.#options.timeoutMs ?? 5000,
          maxOutputChars: 4096,
        },
        this.#options.runner,
      );
      const loggedIn = parseLoggedIn(result.stdout);
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
      const hookOptions: Parameters<typeof doctorClaudeHooks>[0] = {
        ...hookPathOptions(this.#options),
        enabled: this.#options.installHooks === true,
      };
      if (this.#options.observerSocketPath !== undefined) {
        hookOptions.observerSocketPath = this.#options.observerSocketPath;
      }
      if (this.#options.hookSpoolDir !== undefined) {
        hookOptions.hookSpoolDir = this.#options.hookSpoolDir;
      }
      if (this.#options.autoStartFromHooks !== undefined) {
        hookOptions.autoStartFromHooks = this.#options.autoStartFromHooks;
      }
      if (context?.stationConfigPath !== undefined) {
        hookOptions.stationConfigPath = context.stationConfigPath;
      }
      const hookResult = await doctorClaudeHooks(hookOptions);
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
          provider: this.id,
        }),
      });
    }
    return checks;
  }

  async hooksStatus(context?: ProviderDoctorContext): Promise<HarnessHooksStatus> {
    const hookOptions: Parameters<typeof doctorClaudeHooks>[0] = {
      ...hookPathOptions(this.#options),
      enabled: this.#options.installHooks === true,
    };
    if (this.#options.observerSocketPath !== undefined) {
      hookOptions.observerSocketPath = this.#options.observerSocketPath;
    }
    if (this.#options.hookSpoolDir !== undefined) {
      hookOptions.hookSpoolDir = this.#options.hookSpoolDir;
    }
    if (this.#options.autoStartFromHooks !== undefined) {
      hookOptions.autoStartFromHooks = this.#options.autoStartFromHooks;
    }
    if (context?.stationConfigPath !== undefined) {
      hookOptions.stationConfigPath = context.stationConfigPath;
    }
    const hookResult = await doctorClaudeHooks(hookOptions);
    return {
      provider: this.id,
      installed: hookResult.installed,
      requested: this.#options.installHooks === true,
      missing: hookResult.missing.map((name) => String(name)),
      message: hookResult.message,
    };
  }

  async buildLaunch(request: BuildHarnessLaunchRequest): Promise<HarnessLaunchPlan> {
    const options: ClaudeLaunchOptions = {
      command: command(this.#options),
    };
    if (this.#options.profile !== undefined) {
      options.defaultProfile = this.#options.profile;
    }
    if (this.#options.permissionMode !== undefined) {
      options.defaultPermissionMode = this.#options.permissionMode;
    }
    if (this.#options.approvalPolicy !== undefined) {
      options.defaultApprovalPolicy = this.#options.approvalPolicy;
    }
    if (this.#options.sandboxMode !== undefined) {
      options.defaultSandboxMode = this.#options.sandboxMode;
    }
    if (this.#options.installHooks === true) {
      options.hookSettingsPath = resolveClaudeSettingsArtifactPath(hookPathOptions(this.#options));
    }
    return buildClaudeLaunchPlan(request, options);
  }

  async discoverRuns(context: HarnessDiscoveryContext): Promise<HarnessRunObservation[]> {
    return discoverTerminalBoundHarnessRuns(context, {
      harnessProvider: this.id,
      displayName: "Claude Code",
      role: "main-agent",
    });
  }

  async classifyRun(
    run: HarnessRunObservation,
    _context: HarnessClassificationContext,
  ): Promise<HarnessStatusObservation> {
    return classifyClaudeRunStatus(run);
  }

  async ingestEvent(
    event: RawHarnessEvent,
    context: HarnessEventContext,
  ): Promise<HarnessEventObservation[]> {
    const result = await runRuntimeBoundary(
      {
        operation: "provider.claude.ingestEvent",
        error: {
          tag: "HarnessProviderError",
          code: "HARNESS_CLAUDE_EVENT_INGEST_FAILED",
          message: "The Claude Code harness provider failed to ingest an event.",
          provider: this.id,
        },
      },
      async () => normalizeClaudeRawEvent(event, context),
    );
    if (!result.ok) {
      throw result.error;
    }
    return result.value;
  }
}
