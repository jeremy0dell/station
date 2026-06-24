import type {
  BuildHarnessLaunchRequest,
  HarnessCapabilities,
  HarnessLaunchPlan,
  HarnessPermissionMode,
  HarnessRunObservation,
  HarnessStatusObservation,
  SafeError,
} from "@station/contracts";
import {
  type CommonHarnessProviderOptions,
  type CommonProviderDataInput,
  commonProviderData,
  harnessLaunchEnv,
  hookOptions,
  isYoloPermissionMode,
  TerminalBoundHarnessProvider,
  type TerminalBoundHarnessProviderSpec,
  terminalProviderData,
} from "@station/harness-shared";
import { normalizeCrushRawEvent } from "./events.js";
import { doctorCrushHooks } from "./hooks.js";

export type CrushHarnessProviderOptions = Omit<CommonHarnessProviderOptions, "resume"> & {
  permissionMode?: HarnessPermissionMode;
  approvalPolicy?: string;
  sandboxMode?: string;
  configPath?: string;
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

type CrushHookOptions = Parameters<typeof doctorCrushHooks>[0];
type CrushHookResult = Awaited<ReturnType<typeof doctorCrushHooks>>;

const crushProviderSpec = {
  id: "crush",
  displayName: "Crush",
  command: {
    envVar: "STATION_CRUSH_BIN",
    fallback: "crush",
  },
  baseCapabilities: capabilities,
  health: {
    args: ["--version"],
    unavailable: {
      code: "HARNESS_CRUSH_UNAVAILABLE",
      message: "Crush is not available.",
      hint: "Install Crush or configure [harness.crush].command.",
    },
    diagnostics: () => ({
      command: "crush --version succeeded",
    }),
  },
  hooks: {
    doctor: doctorCrushHooks,
    buildOptions: (options, context) => hookOptions(options, context),
    checkName: "crush-hooks",
    failure: {
      tag: "CrushHookSetupError",
      code: "CRUSH_HOOK_DIAGNOSTIC_FAILED",
      message: "Crush hook diagnostics failed.",
    },
    formatCheckMessage: (result) =>
      `${result.message} Hooks: ${result.configPath}. Script: ${result.hookScriptPath}.`,
  },
  buildLaunchOptions: (options, command) => {
    const launchOptions: CrushLaunchOptions = { command };
    if (options.permissionMode !== undefined) {
      launchOptions.defaultPermissionMode = options.permissionMode;
    }
    if (options.approvalPolicy !== undefined) {
      launchOptions.defaultApprovalPolicy = options.approvalPolicy;
    }
    if (options.sandboxMode !== undefined) launchOptions.defaultSandboxMode = options.sandboxMode;
    if (options.configPath !== undefined) launchOptions.configPath = options.configPath;
    if (options.observerSocketPath !== undefined) {
      launchOptions.observerSocketPath = options.observerSocketPath;
    }
    if (options.stateDir !== undefined) launchOptions.stateDir = options.stateDir;
    if (options.hookSpoolDir !== undefined) launchOptions.hookSpoolDir = options.hookSpoolDir;
    return launchOptions;
  },
  buildLaunch: buildCrushLaunchPlan,
  classifyRun: (run) => classifyCrushRunStatus(run),
  normalizeEvent: normalizeCrushRawEvent,
} satisfies TerminalBoundHarnessProviderSpec<
  CrushHarnessProviderOptions,
  CrushLaunchOptions,
  CrushHookOptions,
  CrushHookResult
>;

export class CrushHarnessProvider extends TerminalBoundHarnessProvider<
  CrushHarnessProviderOptions,
  CrushLaunchOptions,
  CrushHookOptions,
  CrushHookResult
> {
  constructor(options: CrushHarnessProviderOptions = {}) {
    super(crushProviderSpec, options);
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

  const providerDataInput: CommonProviderDataInput = {
    mode,
    initialPromptProvided: request.initialPrompt !== undefined,
    ...terminalProviderData(request),
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

  return {
    provider: "crush",
    command: options.command ?? "crush",
    args,
    cwd: request.worktree.path,
    env: harnessLaunchEnv("crush", request, options),
    mode,
    displayTitle: `${request.project.label} Crush`,
    providerData: commonProviderData(providerDataInput),
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

function safeError(error: SafeError): SafeError {
  return error;
}
