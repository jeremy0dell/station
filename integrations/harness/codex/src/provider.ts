import type {
  BuildHarnessLaunchRequest,
  HarnessCapabilities,
  HarnessClassificationContext,
  HarnessDiscoveryContext,
  HarnessEventContext,
  HarnessEventObservation,
  HarnessHooksStatus,
  HarnessLaunchPlan,
  HarnessPermissionMode,
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
import { classifyCodexRunStatus } from "./classify.js";
import { codexProviderErrorFromUnknown } from "./errors.js";
import { normalizeCodexRawEvent } from "./events.js";
import { doctorCodexHooks } from "./hooks.js";
import { buildCodexLaunchPlan, type CodexLaunchOptions } from "./launch.js";

const CODEX_STATION_PROFILE = "station";

export type CodexHarnessProviderOptions = {
  command?: string;
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
  supportsModifiedEnterSoftNewline: true,
};

export class CodexHarnessProvider implements HarnessProvider {
  readonly id = "codex";

  readonly #options: CodexHarnessProviderOptions;

  constructor(options: CodexHarnessProviderOptions = {}) {
    this.#options = options;
  }

  capabilities(): HarnessCapabilities {
    return capabilities(this.#options);
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = now(this.#options);
    try {
      await runExternalCommand(
        {
          command: command(this.#options),
          args: ["login", "status"],
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
          auth: "codex login status succeeded",
        },
      };
    } catch (error) {
      return {
        providerId: this.id,
        providerType: "harness",
        status: "unavailable",
        lastCheckedAt: checkedAt,
        lastError: codexProviderErrorFromUnknown(error, {
          code: "HARNESS_CODEX_UNAVAILABLE",
          message: "Codex is not available or is not logged in.",
          hint: "Install Codex and run `codex login status` to verify authentication.",
        }),
        capabilities: this.capabilities(),
      };
    }
  }

  async doctorChecks(context?: ProviderDoctorContext): Promise<ProviderDoctorCheck[]> {
    const health = await this.health();
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
      const hookOptions: Parameters<typeof doctorCodexHooks>[0] = {
        enabled: this.#options.installHooks === true,
      };
      if (this.#options.stateDir !== undefined) {
        hookOptions.stateDir = this.#options.stateDir;
      }
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
      const hookResult = await doctorCodexHooks(hookOptions);
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
          provider: this.id,
        }),
      });
    }
    return checks;
  }

  async hooksStatus(context?: ProviderDoctorContext): Promise<HarnessHooksStatus> {
    const hookOptions: Parameters<typeof doctorCodexHooks>[0] = {
      enabled: this.#options.installHooks === true,
    };
    if (this.#options.stateDir !== undefined) {
      hookOptions.stateDir = this.#options.stateDir;
    }
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
    const hookResult = await doctorCodexHooks(hookOptions);
    return {
      provider: this.id,
      installed: hookResult.installed,
      requested: this.#options.installHooks === true,
      missing: hookResult.missing.map((name) => String(name)),
      message: hookResult.message,
    };
  }

  async buildLaunch(request: BuildHarnessLaunchRequest): Promise<HarnessLaunchPlan> {
    const options: CodexLaunchOptions = {
      command: command(this.#options),
    };
    if (this.#options.profile !== undefined) {
      options.defaultProfile = this.#options.profile;
    }
    if (this.#options.permissionMode !== undefined) {
      options.defaultPermissionMode = this.#options.permissionMode;
    }
    if (this.#options.installHooks === true) {
      options.defaultHookProfile = CODEX_STATION_PROFILE;
    }
    if (this.#options.approvalPolicy !== undefined) {
      options.defaultApprovalPolicy = this.#options.approvalPolicy;
    }
    if (this.#options.sandboxMode !== undefined) {
      options.defaultSandboxMode = this.#options.sandboxMode;
    }
    if (this.#options.noAltScreen !== undefined) {
      options.noAltScreen = this.#options.noAltScreen;
    }
    return buildCodexLaunchPlan(request, options);
  }

  async discoverRuns(context: HarnessDiscoveryContext): Promise<HarnessRunObservation[]> {
    return discoverTerminalBoundHarnessRuns(context, {
      harnessProvider: this.id,
      displayName: "Codex",
      role: "main-agent",
    });
  }

  async classifyRun(
    run: HarnessRunObservation,
    _context: HarnessClassificationContext,
  ): Promise<HarnessStatusObservation> {
    return classifyCodexRunStatus(run);
  }

  async ingestEvent(
    event: RawHarnessEvent,
    context: HarnessEventContext,
  ): Promise<HarnessEventObservation[]> {
    const result = await runRuntimeBoundary(
      {
        operation: "provider.codex.ingestEvent",
        error: {
          tag: "HarnessProviderError",
          code: "HARNESS_CODEX_EVENT_INGEST_FAILED",
          message: "The Codex harness provider failed to ingest an event.",
          provider: this.id,
        },
      },
      async () => normalizeCodexRawEvent(event, context),
    );
    if (!result.ok) {
      throw result.error;
    }
    return result.value;
  }
}

function command(options: CodexHarnessProviderOptions): string {
  return options.command ?? process.env.STATION_CODEX_BIN ?? "codex";
}

function now(options: CodexHarnessProviderOptions): string {
  const value = options.now?.() ?? systemClock.now();
  return toIsoTimestamp(value instanceof Date ? value : new Date(value));
}

function capabilities(options: CodexHarnessProviderOptions): HarnessCapabilities {
  // Adapter support alone is not enough; resume stays invisible unless this
  // provider instance is explicitly enabled by [harness.codex].resume.
  return {
    ...baseCapabilities,
    canResume: options.resume === true,
  };
}
