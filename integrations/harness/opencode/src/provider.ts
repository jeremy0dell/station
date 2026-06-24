import type {
  BuildHarnessLaunchRequest,
  HarnessCapabilities,
  HarnessClassificationContext,
  HarnessDiscoveryContext,
  HarnessEventContext,
  HarnessEventObservation,
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
import { classifyOpenCodeRunStatus } from "./classify.js";
import { openCodeProviderErrorFromUnknown } from "./errors.js";
import { normalizeOpenCodeRawEvent } from "./events.js";
import { buildOpenCodeLaunchPlan, type OpenCodeLaunchOptions } from "./launch.js";
import { doctorOpenCodePlugin } from "./pluginInstall.js";

export type OpenCodeHarnessProviderOptions = {
  command?: string;
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

export class OpenCodeHarnessProvider implements HarnessProvider {
  readonly id = "opencode";

  readonly #options: OpenCodeHarnessProviderOptions;

  constructor(options: OpenCodeHarnessProviderOptions = {}) {
    this.#options = options;
  }

  capabilities(): HarnessCapabilities {
    return capabilities(this.#options);
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = toIsoTimestamp(this.#options.now?.() ?? systemClock.now());
    try {
      await runExternalCommand(
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
          command: "opencode --version succeeded",
        },
      };
    } catch (error) {
      return {
        providerId: this.id,
        providerType: "harness",
        status: "unavailable",
        lastCheckedAt: checkedAt,
        lastError: openCodeProviderErrorFromUnknown(error, {
          code: "HARNESS_OPENCODE_UNAVAILABLE",
          message: "OpenCode is not available.",
          hint: "Install OpenCode or configure [harness.opencode].command.",
        }),
        capabilities: this.capabilities(),
      };
    }
  }

  async doctorChecks(_context?: ProviderDoctorContext): Promise<ProviderDoctorCheck[]> {
    const checks: ProviderDoctorCheck[] = [];
    const health = await this.health();
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
      const pluginOptions: Parameters<typeof doctorOpenCodePlugin>[0] = {
        enabled: this.#options.installHooks === true,
        env: this.#options.env ?? process.env,
      };
      if (this.#options.observerSocketPath !== undefined) {
        pluginOptions.observerSocketPath = this.#options.observerSocketPath;
      }
      if (this.#options.stateDir !== undefined) {
        pluginOptions.stateDir = this.#options.stateDir;
      }
      if (this.#options.hookSpoolDir !== undefined) {
        pluginOptions.hookSpoolDir = this.#options.hookSpoolDir;
      }
      const pluginResult = await doctorOpenCodePlugin(pluginOptions);
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
          provider: this.id,
        }),
      });
    }
    return checks;
  }

  async buildLaunch(request: BuildHarnessLaunchRequest): Promise<HarnessLaunchPlan> {
    const options: OpenCodeLaunchOptions = {
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
    if (this.#options.configPath !== undefined) {
      options.configPath = this.#options.configPath;
    }
    if (this.#options.observerSocketPath !== undefined) {
      options.observerSocketPath = this.#options.observerSocketPath;
    }
    if (this.#options.stateDir !== undefined) {
      options.stateDir = this.#options.stateDir;
    }
    if (this.#options.hookSpoolDir !== undefined) {
      options.hookSpoolDir = this.#options.hookSpoolDir;
    }
    return buildOpenCodeLaunchPlan(request, options);
  }

  async discoverRuns(context: HarnessDiscoveryContext): Promise<HarnessRunObservation[]> {
    return discoverTerminalBoundHarnessRuns(context, {
      harnessProvider: this.id,
      displayName: "OpenCode",
      role: "main-agent",
    });
  }

  async classifyRun(
    run: HarnessRunObservation,
    _context: HarnessClassificationContext,
  ): Promise<HarnessStatusObservation> {
    return classifyOpenCodeRunStatus(run);
  }

  async ingestEvent(
    event: RawHarnessEvent,
    context: HarnessEventContext,
  ): Promise<HarnessEventObservation[]> {
    const result = await runRuntimeBoundary(
      {
        operation: "provider.opencode.ingestEvent",
        error: {
          tag: "HarnessProviderError",
          code: "HARNESS_OPENCODE_EVENT_INGEST_FAILED",
          message: "The OpenCode harness provider failed to ingest an event.",
          provider: this.id,
        },
      },
      async () => normalizeOpenCodeRawEvent(event, context),
    );
    if (!result.ok) {
      throw result.error;
    }
    return result.value;
  }
}

function command(options: OpenCodeHarnessProviderOptions): string {
  return options.command ?? process.env.STATION_OPENCODE_BIN ?? "opencode";
}

function capabilities(options: OpenCodeHarnessProviderOptions): HarnessCapabilities {
  // Adapter support alone is not enough; resume stays invisible unless this
  // provider instance is explicitly enabled by [harness.opencode].resume.
  return {
    ...baseCapabilities,
    canResume: options.resume === true,
  };
}
