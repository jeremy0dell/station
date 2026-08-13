import type {
  BuildHarnessLaunchRequest,
  HarnessCapabilities,
  HarnessClassificationContext,
  HarnessDiscoveryContext,
  HarnessLaunchPlan,
  HarnessProvider,
  HarnessRunObservation,
  HarnessStatusObservation,
  ProviderHealth,
} from "@station/contracts";
import { type RuntimeClock, toIsoTimestamp } from "@station/runtime";
import { buildScriptedAgentLaunchPlan } from "./launch.js";
import { discoverScriptedRuns } from "./stateStore.js";
import { classifyScriptedRunStatus } from "./statusPolicy.js";

export type ScriptedAgentHarnessProviderOptions = {
  stateDir: string;
  runnerPath?: string;
  nodeCommand?: string;
  scenarioPath?: string;
  runId?: string;
  sessionId?: string;
  now?: () => Date | string;
  timeoutMs?: number;
};

const capabilities: HarnessCapabilities = {
  canLaunch: true,
  canDiscoverRuns: true,
  canEmitEvents: true,
  canClassifyStatus: true,
  canReceivePrompt: false,
  canResume: false,
  canStop: false,
  canRunNonInteractive: true,
  canExposeApprovalState: false,
  supportsModifiedEnterSoftNewline: false,
};

export class ScriptedAgentHarnessProvider implements HarnessProvider {
  readonly id = "scripted";

  readonly #options: ScriptedAgentHarnessProviderOptions;
  readonly #clock: RuntimeClock;

  constructor(options: ScriptedAgentHarnessProviderOptions) {
    this.#options = options;
    this.#clock = {
      now: () => {
        const value = options.now?.() ?? new Date();
        return value instanceof Date ? value : new Date(value);
      },
    };
  }

  capabilities(): HarnessCapabilities {
    return capabilities;
  }

  async health(): Promise<ProviderHealth> {
    return {
      providerId: this.id,
      providerType: "harness",
      status: "healthy",
      lastCheckedAt: toIsoTimestamp(this.#clock.now()),
      capabilities,
    };
  }

  async buildLaunch(request: BuildHarnessLaunchRequest): Promise<HarnessLaunchPlan> {
    return buildScriptedAgentLaunchPlan(request, {
      stateDir: this.#options.stateDir,
      ...(this.#options.runnerPath === undefined ? {} : { runnerPath: this.#options.runnerPath }),
      ...(this.#options.nodeCommand === undefined
        ? {}
        : { nodeCommand: this.#options.nodeCommand }),
      ...(this.#options.scenarioPath === undefined
        ? {}
        : { scenarioPath: this.#options.scenarioPath }),
      ...(this.#options.runId === undefined ? {} : { runId: this.#options.runId }),
      ...(this.#options.sessionId === undefined ? {} : { sessionId: this.#options.sessionId }),
    });
  }

  async discoverRuns(_context: HarnessDiscoveryContext): Promise<HarnessRunObservation[]> {
    return discoverScriptedRuns({
      stateDir: this.#options.stateDir,
      clock: this.#clock,
      ...(this.#options.timeoutMs === undefined ? {} : { timeoutMs: this.#options.timeoutMs }),
    });
  }

  async classifyRun(
    run: HarnessRunObservation,
    _context: HarnessClassificationContext,
  ): Promise<HarnessStatusObservation> {
    return classifyScriptedRunStatus(run, {
      now: toIsoTimestamp(this.#clock.now()),
    });
  }
}
