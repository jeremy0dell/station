import type {
  BuildHarnessLaunchRequest,
  HarnessCapabilities,
  HarnessLaunchPlan,
  HarnessPermissionMode,
  HarnessProvider,
  HarnessRunObservation,
  HarnessStatusObservation,
  ProviderDoctorCheck,
  ProviderDoctorContext,
  SafeError,
} from "@station/contracts";
import {
  type CommonHarnessProviderOptions,
  createTerminalBoundHarnessProvider,
  harnessCommand,
  harnessHookDoctorOptions,
  type TerminalBoundHarnessProviderSpec,
} from "@station/harness-shared";
import { safeErrorFromUnknown } from "@station/runtime";
import { crushProviderErrorFromUnknown } from "./errors.js";
import { normalizeCrushRawEvent } from "./events.js";
import { doctorCrushHooks } from "./hooks.js";

export type CrushHarnessProviderOptions = CommonHarnessProviderOptions & {
  permissionMode?: HarnessPermissionMode;
  approvalPolicy?: string;
  sandboxMode?: string;
  installHooks?: boolean;
  configPath?: string;
  observerSocketPath?: string;
  stateDir?: string;
  hookSpoolDir?: string;
  autoStartFromHooks?: boolean;
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

const crushSpec: TerminalBoundHarnessProviderSpec<CrushHarnessProviderOptions> = {
  id: "crush",
  displayName: "Crush",
  commandEnvVar: "STATION_CRUSH_BIN",
  commandFallback: "crush",
  baseCapabilities,
  // No resume option exists for Crush, so the uniform toggle safely resolves canResume to false.
  health: {
    args: ["--version"],
    diagnostics: () => ({ command: "crush --version succeeded" }),
    unavailableError: (error) =>
      crushProviderErrorFromUnknown(error, {
        code: "HARNESS_CRUSH_UNAVAILABLE",
        message: "Crush is not available.",
        hint: "Install Crush or configure [harness.crush].command.",
      }),
  },
  buildLaunch,
  classifyRun: (run) => classifyCrushRunStatus(run),
  ingestEvent: {
    operation: "provider.crush.ingestEvent",
    errorCode: "HARNESS_CRUSH_EVENT_INGEST_FAILED",
    errorMessage: "The Crush harness provider failed to ingest an event.",
    normalize: (event, context) => normalizeCrushRawEvent(event, context),
  },
  doctorChecks,
};

function command(options: CrushHarnessProviderOptions): string {
  return harnessCommand(options, "STATION_CRUSH_BIN", "crush");
}

function buildLaunch(
  options: CrushHarnessProviderOptions,
  request: BuildHarnessLaunchRequest,
): HarnessLaunchPlan {
  const launchOptions: CrushLaunchOptions = { command: command(options) };
  if (options.permissionMode !== undefined) {
    launchOptions.defaultPermissionMode = options.permissionMode;
  }
  if (options.approvalPolicy !== undefined) {
    launchOptions.defaultApprovalPolicy = options.approvalPolicy;
  }
  if (options.sandboxMode !== undefined) {
    launchOptions.defaultSandboxMode = options.sandboxMode;
  }
  if (options.configPath !== undefined) {
    launchOptions.configPath = options.configPath;
  }
  if (options.observerSocketPath !== undefined) {
    launchOptions.observerSocketPath = options.observerSocketPath;
  }
  if (options.stateDir !== undefined) {
    launchOptions.stateDir = options.stateDir;
  }
  if (options.hookSpoolDir !== undefined) {
    launchOptions.hookSpoolDir = options.hookSpoolDir;
  }
  return buildCrushLaunchPlan(request, launchOptions);
}

async function doctorChecks(
  options: CrushHarnessProviderOptions,
  context?: ProviderDoctorContext,
): Promise<ProviderDoctorCheck[]> {
  try {
    const hookOptions = harnessHookDoctorOptions(options, context);
    if (hookOptions.stationConfigPath === undefined && options.configPath !== undefined) {
      hookOptions.stationConfigPath = options.configPath;
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
          provider: "crush",
        }),
      },
    ];
  }
}

export function createCrushHarnessProvider(
  options: CrushHarnessProviderOptions = {},
): HarnessProvider {
  return createTerminalBoundHarnessProvider(crushSpec, options);
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
