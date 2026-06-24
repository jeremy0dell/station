import type {
  BuildHarnessLaunchRequest,
  HarnessCapabilities,
  HarnessClassificationContext,
  HarnessDiscoveryContext,
  HarnessEventContext,
  HarnessEventObservation,
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
import { classifyCursorRunStatus } from "./classify.js";
import { cursorProviderErrorFromUnknown } from "./errors.js";
import { normalizeCursorRawEvent } from "./events.js";
import { doctorCursorHooks } from "./hooks.js";
import { buildCursorLaunchPlan, type CursorLaunchOptions } from "./launch.js";

export type CursorHarnessProviderOptions = {
  command?: string;
  installHooks?: boolean;
  configPath?: string;
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
  canRunNonInteractive: false,
  canExposeApprovalState: false,
  supportsModifiedEnterSoftNewline: false,
};

function command(options: CursorHarnessProviderOptions): string {
  return options.command ?? process.env.STATION_CURSOR_AGENT_BIN ?? "agent";
}

function capabilities(options: CursorHarnessProviderOptions): HarnessCapabilities {
  // Adapter support alone is not enough; resume stays invisible unless this
  // provider instance is explicitly enabled by [harness.cursor].resume.
  return {
    ...baseCapabilities,
    canResume: options.resume === true,
  };
}

export class CursorHarnessProvider implements HarnessProvider {
  readonly id = "cursor";

  readonly #options: CursorHarnessProviderOptions;

  constructor(options: CursorHarnessProviderOptions = {}) {
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
          command: "agent --version succeeded",
          observation: "hooks",
        },
      };
    } catch (error) {
      return {
        providerId: this.id,
        providerType: "harness",
        status: "unavailable",
        lastCheckedAt: checkedAt,
        lastError: cursorProviderErrorFromUnknown(error, {
          code: "HARNESS_CURSOR_UNAVAILABLE",
          message: "Cursor Agent is not available.",
          hint: "Install Cursor Agent or configure [harness.cursor].command.",
        }),
        capabilities: this.capabilities(),
      };
    }
  }

  async doctorChecks(context?: ProviderDoctorContext): Promise<ProviderDoctorCheck[]> {
    try {
      const hookOptions: Parameters<typeof doctorCursorHooks>[0] = {
        enabled: this.#options.installHooks === true,
      };
      if (this.#options.observerSocketPath !== undefined) {
        hookOptions.observerSocketPath = this.#options.observerSocketPath;
      }
      if (this.#options.stateDir !== undefined) {
        hookOptions.stateDir = this.#options.stateDir;
      }
      if (this.#options.hookSpoolDir !== undefined) {
        hookOptions.hookSpoolDir = this.#options.hookSpoolDir;
      }
      if (this.#options.autoStartFromHooks !== undefined) {
        hookOptions.autoStartFromHooks = this.#options.autoStartFromHooks;
      }
      if (context?.stationConfigPath !== undefined) {
        hookOptions.stationConfigPath = context.stationConfigPath;
      } else if (this.#options.configPath !== undefined) {
        hookOptions.stationConfigPath = this.#options.configPath;
      }
      const hookResult = await doctorCursorHooks(hookOptions);
      return [
        {
          name: "cursor-hooks",
          status: hookResult.status,
          message: `${hookResult.message} Hooks: ${hookResult.hooksPath}. Script: ${hookResult.hookScriptPath}.`,
        },
      ];
    } catch (cause) {
      return [
        {
          name: "cursor-hooks",
          status: "error",
          message: "Cursor hook diagnostics failed.",
          error: safeErrorFromUnknown(cause, {
            tag: "CursorHookSetupError",
            code: "CURSOR_HOOK_DIAGNOSTIC_FAILED",
            message: "Cursor hook diagnostics failed.",
            provider: this.id,
          }),
        },
      ];
    }
  }

  async buildLaunch(request: BuildHarnessLaunchRequest): Promise<HarnessLaunchPlan> {
    const options: CursorLaunchOptions = {
      command: command(this.#options),
    };
    return buildCursorLaunchPlan(request, options);
  }

  async discoverRuns(context: HarnessDiscoveryContext): Promise<HarnessRunObservation[]> {
    return discoverTerminalBoundHarnessRuns(context, {
      harnessProvider: this.id,
      displayName: "Cursor",
      role: "main-agent",
    });
  }

  async classifyRun(
    run: HarnessRunObservation,
    _context: HarnessClassificationContext,
  ): Promise<HarnessStatusObservation> {
    return classifyCursorRunStatus(run);
  }

  async ingestEvent(
    event: RawHarnessEvent,
    context: HarnessEventContext,
  ): Promise<HarnessEventObservation[]> {
    const result = await runRuntimeBoundary(
      {
        operation: "provider.cursor.ingestEvent",
        error: {
          tag: "HarnessProviderError",
          code: "HARNESS_CURSOR_EVENT_INGEST_FAILED",
          message: "The Cursor harness provider failed to ingest an event.",
          provider: this.id,
        },
      },
      async () => normalizeCursorRawEvent(event, context),
    );
    if (!result.ok) {
      throw result.error;
    }
    return result.value;
  }
}
