import type {
  BuildHarnessLaunchRequest,
  HarnessLaunchPlan,
  HarnessPermissionMode,
} from "@station/contracts";
import { OpenCodeHarnessProviderError } from "./errors.js";

export type OpenCodeLaunchOptions = {
  command?: string;
  defaultProfile?: string;
  defaultPermissionMode?: HarnessPermissionMode;
  defaultApprovalPolicy?: string;
  defaultSandboxMode?: string;
  configPath?: string;
  observerSocketPath?: string;
  stateDir?: string;
  hookSpoolDir?: string;
};

export function buildOpenCodeLaunchPlan(
  request: BuildHarnessLaunchRequest,
  options: OpenCodeLaunchOptions = {},
): HarnessLaunchPlan {
  const mode = request.mode ?? "interactive";
  if (request.resume !== undefined) {
    return buildOpenCodeResumeLaunchPlan(request, options, mode);
  }
  const profile = request.profile ?? options.defaultProfile;
  const permissionMode = request.permissionMode ?? options.defaultPermissionMode;
  const approvalPolicy = request.approvalPolicy ?? options.defaultApprovalPolicy;
  const sandboxMode = request.sandboxMode ?? options.defaultSandboxMode;
  const yolo = isYoloPermissionMode({ permissionMode, approvalPolicy, sandboxMode });
  const providerPermissionMode = yolo ? "yolo" : permissionMode;
  const args = mode === "exec" ? execArgs(request) : interactiveArgs(request);
  appendOpenCodeOptions(args, {
    mode,
    profile,
    yolo,
    initialPrompt: request.initialPrompt,
  });

  const providerDataInput: OpenCodeProviderDataInput = {
    mode,
    initialPromptProvided: request.initialPrompt !== undefined,
  };
  if (profile !== undefined) {
    providerDataInput.profile = profile;
  }
  if (providerPermissionMode !== undefined) {
    providerDataInput.permissionMode = providerPermissionMode;
  }
  if (!yolo && approvalPolicy !== undefined) {
    providerDataInput.approvalPolicy = approvalPolicy;
  }
  if (!yolo && sandboxMode !== undefined) {
    providerDataInput.sandboxMode = sandboxMode;
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
    provider: "opencode",
    command: options.command ?? "opencode",
    args,
    cwd: request.worktree.path,
    env: openCodeLaunchEnv(request, options),
    mode,
    displayTitle: `${request.project.label} OpenCode`,
    providerData: openCodeProviderData(providerDataInput),
  };
}

function buildOpenCodeResumeLaunchPlan(
  request: BuildHarnessLaunchRequest,
  options: OpenCodeLaunchOptions,
  mode: "interactive" | "exec",
): HarnessLaunchPlan {
  // OpenCode accepts a native session id for interactive resume; exec fidelity
  // is intentionally not assumed until a provider-specific test proves it.
  if (mode === "exec") {
    throw new OpenCodeHarnessProviderError(
      "HARNESS_OPENCODE_RESUME_UNSUPPORTED",
      "OpenCode resume is supported only for interactive launches.",
      { hint: "Start an interactive OpenCode resume session instead." },
    );
  }
  if (request.resume?.target.kind !== "native-session") {
    throw new OpenCodeHarnessProviderError(
      "HARNESS_OPENCODE_RESUME_UNSUPPORTED",
      "OpenCode resume requires a native session target.",
    );
  }

  const args = ["--session", request.resume.target.id];
  if (request.initialPrompt !== undefined) {
    args.push("--prompt", request.initialPrompt);
  }

  return {
    provider: "opencode",
    command: options.command ?? "opencode",
    args,
    cwd: request.worktree.path,
    env: openCodeLaunchEnv(request, options),
    mode,
    displayTitle: `${request.project.label} OpenCode`,
    providerData: openCodeProviderData({
      mode,
      initialPromptProvided: request.initialPrompt !== undefined,
      resume: true,
      resumeTargetKind: request.resume.target.kind,
    }),
  };
}

function interactiveArgs(_request: BuildHarnessLaunchRequest): string[] {
  return [];
}

function execArgs(_request: BuildHarnessLaunchRequest): string[] {
  return ["run", "--format", "json"];
}

function appendOpenCodeOptions(
  args: string[],
  options: {
    mode: "interactive" | "exec";
    profile?: string | undefined;
    yolo: boolean;
    initialPrompt?: string | undefined;
  },
): void {
  if (options.profile !== undefined) {
    args.push("--agent", options.profile);
  }
  if (options.mode === "exec" && options.yolo) {
    args.push("--dangerously-skip-permissions");
  }
  if (options.initialPrompt !== undefined) {
    if (options.mode === "interactive") {
      args.push("--prompt", options.initialPrompt);
    } else {
      args.push(options.initialPrompt);
    }
  }
}

function openCodeLaunchEnv(
  request: BuildHarnessLaunchRequest,
  options: OpenCodeLaunchOptions,
): Record<string, string> {
  const env: Record<string, string> = {
    STATION_PROJECT_ID: request.project.id,
    STATION_WORKTREE_ID: request.worktree.id,
    STATION_WORKTREE_PATH: request.worktree.path,
    STATION_HARNESS_PROVIDER: "opencode",
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

type OpenCodeProviderDataInput = {
  mode: "interactive" | "exec";
  profile?: string | undefined;
  permissionMode?: HarnessPermissionMode | undefined;
  approvalPolicy?: string | undefined;
  sandboxMode?: string | undefined;
  initialPromptProvided: boolean;
  configPathProvided?: boolean | undefined;
  observerSocketPathProvided?: boolean | undefined;
  terminalProvider?: string | undefined;
  terminalTargetId?: string | undefined;
  resume?: boolean | undefined;
  resumeTargetKind?: string | undefined;
};

function openCodeProviderData(input: OpenCodeProviderDataInput): Record<string, unknown> {
  const providerData: Record<string, unknown> = {
    interactive: input.mode === "interactive",
  };
  if (input.initialPromptProvided) {
    providerData.initialPromptProvided = true;
  }
  if (input.profile !== undefined) {
    providerData.profile = input.profile;
  }
  if (input.permissionMode !== undefined) {
    providerData.permissionMode = input.permissionMode;
  }
  if (input.approvalPolicy !== undefined) {
    providerData.approvalPolicy = input.approvalPolicy;
  }
  if (input.sandboxMode !== undefined) {
    providerData.sandboxMode = input.sandboxMode;
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
  if (input.resume === true) {
    providerData.resume = true;
  }
  if (input.resumeTargetKind !== undefined) {
    providerData.resumeTargetKind = input.resumeTargetKind;
  }
  return providerData;
}
