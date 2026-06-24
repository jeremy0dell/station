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
  ProviderHealth,
  RawHarnessEvent,
} from "@station/contracts";
import { discoverTerminalBoundHarnessRuns } from "@station/contracts";
import {
  type ExternalCommandRunner,
  runExternalCommand,
  runRuntimeBoundary,
  systemClock,
  toIsoTimestamp,
} from "@station/runtime";
import { classifyPiRunStatus } from "./classify.js";
import { piProviderErrorFromUnknown } from "./errors.js";
import { normalizePiRawEvent } from "./event/mapping.js";
import { buildPiLaunchPlan } from "./launch.js";

export type PiHarnessProviderOptions = {
  command?: string;
  extensionPath?: string;
  configPath?: string;
  observerSocketPath?: string;
  stateDir?: string;
  hookSpoolDir?: string;
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

export class PiHarnessProvider implements HarnessProvider {
  readonly id = "pi";

  readonly #options: PiHarnessProviderOptions;

  constructor(options: PiHarnessProviderOptions = {}) {
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
          command: "pi --version succeeded",
        },
      };
    } catch (error) {
      return {
        providerId: this.id,
        providerType: "harness",
        status: "unavailable",
        lastCheckedAt: checkedAt,
        lastError: piProviderErrorFromUnknown(error, {
          code: "HARNESS_PI_UNAVAILABLE",
          message: "Pi is not available.",
          hint: "Install Pi or configure [harness.pi].command.",
        }),
        capabilities: this.capabilities(),
      };
    }
  }

  async buildLaunch(request: BuildHarnessLaunchRequest): Promise<HarnessLaunchPlan> {
    const options: Parameters<typeof buildPiLaunchPlan>[1] = {
      command: command(this.#options),
    };
    if (this.#options.extensionPath !== undefined) {
      options.extensionPath = this.#options.extensionPath;
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
    return buildPiLaunchPlan(request, options);
  }

  async discoverRuns(context: HarnessDiscoveryContext): Promise<HarnessRunObservation[]> {
    return discoverTerminalBoundHarnessRuns(context, {
      harnessProvider: this.id,
      displayName: "Pi",
      role: "main-agent",
    });
  }

  async classifyRun(
    run: HarnessRunObservation,
    _context: HarnessClassificationContext,
  ): Promise<HarnessStatusObservation> {
    return classifyPiRunStatus(run);
  }

  async ingestEvent(
    event: RawHarnessEvent,
    context: HarnessEventContext,
  ): Promise<HarnessEventObservation[]> {
    const result = await runRuntimeBoundary(
      {
        operation: "provider.pi.ingestEvent",
        error: {
          tag: "HarnessProviderError",
          code: "HARNESS_PI_EVENT_INGEST_FAILED",
          message: "The Pi harness provider failed to ingest an event.",
          provider: this.id,
        },
      },
      async () => normalizePiRawEvent(event, context),
    );
    if (!result.ok) {
      throw result.error;
    }
    return result.value;
  }
}

function command(options: PiHarnessProviderOptions): string {
  return options.command ?? process.env.STATION_PI_BIN ?? "pi";
}

function now(options: PiHarnessProviderOptions): string {
  const value = options.now?.() ?? systemClock.now();
  return toIsoTimestamp(value instanceof Date ? value : new Date(value));
}

function capabilities(options: PiHarnessProviderOptions): HarnessCapabilities {
  // Adapter support alone is not enough; resume stays invisible unless this
  // provider instance is explicitly enabled by [harness.pi].resume.
  return {
    ...baseCapabilities,
    canResume: options.resume === true,
  };
}
