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
  SafeError,
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
import { normalizeCrushRawEvent } from "./events.js";
import { doctorCrushHooks } from "./hooks.js";

export type CrushHarnessProviderOptions = {
  command?: string;
  permissionMode?: HarnessPermissionMode;
  approvalPolicy?: string;
  sandboxMode?: string;
  installHooks?: boolean;
  configPath?: string;
  observerSocketPath?: string;
  stateDir?: string;
  hookSpoolDir?: string;
  autoStartFromHooks?: boolean;
  now?: () => Date | string;
  timeoutMs?: number;
  runner?: ExternalCommandRunner;
};

export type CrushLaunchOptions = {
  command?: string;
  defaultPermissionMode?: HarnessPermissionMode;
  defaultApprovalPolicy?: string;
  defaultSandboxMode?: string;
  configPath?: string;
  observerSocketPath?: string;
  stateDir?: string;
  hookSpoolDir?: string;
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
  canExposeApprovalState: true,
  supportsModifiedEnterSoftNewline: false,
};

export class CrushHarnessProvider implements HarnessProvider {
  readonly id = "crush";

  readonly #options: CrushHarnessProviderOptions;

  constructor(options: CrushHarnessProviderOptions = {}) {
    this.#options = options;
  }

  capabilities(): HarnessCapabilities {
    return capabilities;
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
        capabilities,
        diagnostics: {
          command: "crush --version succeeded",
        },
      };
    } catch (error) {
      return {
        providerId: this.id,
        providerType: "harness",
        status: "unavailable",
        lastCheckedAt: checkedAt,
        lastError: safeErrorFromUnknown(error, {
          tag: "HarnessProviderError",
          code: "HARNESS_CRUSH_UNAVAILABLE",
          message: "Crush is not available.",
          hint: "Install Crush or configure [harness.crush].command.",
          provider: this.id,
        }),
        capabilities,
      };
    }
  }

  async doctorChecks(context?: ProviderDoctorContext): Promise<ProviderDoctorCheck[]> {
    try {
      const hookOptions: Parameters<typeof doctorCrushHooks>[0] = {
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
      const hookResult = await doctorCrushHooks(hookOptions);
      return [
        {
          name: "crush-hooks",
          status: hookResult.status,
          message: `${hookResult.message} Hooks: ${hookResult.configPath}. Script: ${hookResult.hookScriptPath}.`,
        },
      ];
    } catch (cause) {
      return [
        {
          name: "crush-hooks",
          status: "error",
          message: "Crush hook diagnostics failed.",
          error: safeErrorFromUnknown(cause, {
            tag: "CrushHookSetupError",
            code: "CRUSH_HOOK_DIAGNOSTIC_FAILED",
            message: "Crush hook diagnostics failed.",
            provider: this.id,
          }),
        },
      ];
    }
  }

  async buildLaunch(request: BuildHarnessLaunchRequest): Promise<HarnessLaunchPlan> {
    const options: CrushLaunchOptions = {
      command: command(this.#options),
    };
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
    return buildCrushLaunchPlan(request, options);
  }

  async discoverRuns(context: HarnessDiscoveryContext): Promise<HarnessRunObservation[]> {
    return discoverTerminalBoundHarnessRuns(context, {
      harnessProvider: this.id,
      displayName: "Crush",
      role: "main-agent",
    });
  }

  async classifyRun(
    run: HarnessRunObservation,
    _context: HarnessClassificationContext,
  ): Promise<HarnessStatusObservation> {
    return classifyCrushRunStatus(run);
  }

  async ingestEvent(
    event: RawHarnessEvent,
    context: HarnessEventContext,
  ): Promise<HarnessEventObservation[]> {
    const result = await runRuntimeBoundary(
      {
        operation: "provider.crush.ingestEvent",
        error: {
          tag: "HarnessProviderError",
          code: "HARNESS_CRUSH_EVENT_INGEST_FAILED",
          message: "The Crush harness provider failed to ingest an event.",
          provider: this.id,
        },
      },
      async () => normalizeCrushRawEvent(event, context),
    );
    if (!result.ok) {
      throw result.error;
    }
    return result.value;
  }
}

export function buildCrushLaunchPlan(
  request: BuildHarnessLaunchRequest,
  options: CrushLaunchOptions = {},
): HarnessLaunchPlan {
  if (request.resume !== undefined) {
    throw safeError({
      tag: "HarnessProviderError",
      code: "HARNESS_CRUSH_RESUME_UNSUPPORTED",
      message: "Crush resume is not supported by the STATION Crush harness provider yet.",
      provider: "crush",
    });
  }

  const mode = request.mode ?? "interactive";
  const permissionMode = request.permissionMode ?? options.defaultPermissionMode;
  const approvalPolicy = request.approvalPolicy ?? options.defaultApprovalPolicy;
  const sandboxMode = request.sandboxMode ?? options.defaultSandboxMode;
  const yolo = isYoloPermissionMode({ permissionMode, approvalPolicy, sandboxMode });
  if (mode === "exec" && yolo) {
    throw safeError({
      tag: "HarnessProviderError",
      code: "HARNESS_CRUSH_EXEC_YOLO_UNSUPPORTED",
      message: "Crush exec mode does not support STATION yolo launches.",
      hint: "Use an interactive Crush launch for yolo mode, or run Crush exec mode without yolo.",
      provider: "crush",
    });
  }
  const providerPermissionMode = yolo ? "yolo" : permissionMode;
  const args = mode === "exec" ? execArgs(request) : [];
  if (yolo) {
    args.unshift("--yolo");
  }

  const providerDataInput: CrushProviderDataInput = {
    mode,
    initialPromptProvided: request.initialPrompt !== undefined,
  };
  if (providerPermissionMode !== undefined) {
    providerDataInput.permissionMode = providerPermissionMode;
  }
  if (options.configPath !== undefined) {
    providerDataInput.configPathProvided = true;
  }
  if (options.observerSocketPath !== undefined) {
    providerDataInput.observerSocketPathProvided = true;
  }
  if (request.terminalTarget !== undefined) {
    providerDataInput.terminalProvider = request.terminalTarget.provider;
    providerDataInput.terminalTargetId = request.terminalTarget.id;
  }

  return {
    provider: "crush",
    command: options.command ?? "crush",
    args,
    cwd: request.worktree.path,
    env: crushLaunchEnv(request, options),
    mode,
    displayTitle: `${request.project.label} Crush`,
    providerData: crushProviderData(providerDataInput),
  };
}

function execArgs(request: BuildHarnessLaunchRequest): string[] {
  if (request.initialPrompt === undefined) {
    throw safeError({
      tag: "HarnessProviderError",
      code: "HARNESS_CRUSH_EXEC_PROMPT_REQUIRED",
      message: "Crush exec mode requires an initial prompt.",
      provider: "crush",
    });
  }
  return ["run", "--quiet", request.initialPrompt];
}

function classifyCrushRunStatus(run: HarnessRunObservation): HarnessStatusObservation {
  const status: HarnessStatusObservation["status"] =
    run.state === "exited" && run.confidence === "high"
      ? {
          value: "exited",
          confidence: "high",
          reason: run.reason,
          source: "harness_process",
          updatedAt: run.observedAt,
        }
      : {
          value: "unknown",
          confidence: "low",
          reason: "Crush run has no reliable Crush status signal yet.",
          source: "harness_process",
          updatedAt: run.observedAt,
        };
  const output: HarnessStatusObservation = {
    provider: "crush",
    runId: run.id,
    status,
    observedAt: status.updatedAt,
  };
  if (run.projectId !== undefined) output.projectId = run.projectId;
  if (run.worktreeId !== undefined) output.worktreeId = run.worktreeId;
  if (run.sessionId !== undefined) output.sessionId = run.sessionId;
  if (run.providerData !== undefined) output.providerData = run.providerData;
  return output;
}

function crushLaunchEnv(
  request: BuildHarnessLaunchRequest,
  options: CrushLaunchOptions,
): Record<string, string> {
  const env: Record<string, string> = {
    STATION_PROJECT_ID: request.project.id,
    STATION_WORKTREE_ID: request.worktree.id,
    STATION_WORKTREE_PATH: request.worktree.path,
    STATION_HARNESS_PROVIDER: "crush",
  };
  if (request.sessionId !== undefined) {
    env.STATION_SESSION_ID = request.sessionId;
  }
  if (request.terminalTarget !== undefined) {
    env.STATION_TERMINAL_PROVIDER = request.terminalTarget.provider;
    env.STATION_TERMINAL_TARGET_ID = request.terminalTarget.id;
  }
  if (options.configPath !== undefined) {
    env.STATION_CONFIG_PATH = options.configPath;
  }
  if (options.observerSocketPath !== undefined) {
    env.STATION_OBSERVER_SOCKET_PATH = options.observerSocketPath;
  }
  if (options.stateDir !== undefined) {
    env.STATION_OBSERVER_STATE_DIR = options.stateDir;
  }
  if (options.hookSpoolDir !== undefined) {
    env.STATION_HOOK_SPOOL_DIR = options.hookSpoolDir;
  }
  return env;
}

function crushProviderData(input: CrushProviderDataInput): Record<string, unknown> {
  const providerData: Record<string, unknown> = {
    interactive: input.mode === "interactive",
  };
  if (input.initialPromptProvided) {
    providerData.initialPromptProvided = true;
  }
  if (input.permissionMode !== undefined) {
    providerData.permissionMode = input.permissionMode;
  }
  if (input.configPathProvided === true) {
    providerData.configPathProvided = true;
  }
  if (input.observerSocketPathProvided === true) {
    providerData.observerSocketPathProvided = true;
  }
  if (input.terminalProvider !== undefined) {
    providerData.terminalProvider = input.terminalProvider;
  }
  if (input.terminalTargetId !== undefined) {
    providerData.terminalTargetId = input.terminalTargetId;
  }
  return providerData;
}

function isYoloPermissionMode(input: {
  permissionMode?: HarnessPermissionMode | undefined;
  approvalPolicy?: string | undefined;
  sandboxMode?: string | undefined;
}): boolean {
  if (input.permissionMode !== undefined) {
    return input.permissionMode === "yolo";
  }
  return input.approvalPolicy === "never" && input.sandboxMode === "danger-full-access";
}

function command(options: CrushHarnessProviderOptions): string {
  return options.command ?? process.env.STATION_CRUSH_BIN ?? "crush";
}

function now(options: CrushHarnessProviderOptions): string {
  const value = options.now?.() ?? systemClock.now();
  return toIsoTimestamp(value instanceof Date ? value : new Date(value));
}

function safeError(error: SafeError): SafeError {
  return error;
}

type CrushProviderDataInput = {
  mode: "interactive" | "exec";
  initialPromptProvided: boolean;
  permissionMode?: HarnessPermissionMode | undefined;
  configPathProvided?: boolean | undefined;
  observerSocketPathProvided?: boolean | undefined;
  terminalProvider?: string | undefined;
  terminalTargetId?: string | undefined;
};
