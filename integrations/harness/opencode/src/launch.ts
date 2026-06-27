import type {
  BuildHarnessLaunchRequest,
  HarnessLaunchPlan,
  HarnessPermissionMode,
} from "@station/contracts";
import {
  type CommonProviderDataInput,
  commonProviderData,
  harnessLaunchEnv,
  isYoloPermissionMode,
  terminalProviderData,
} from "@station/harness-shared";
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
  env?: NodeJS.ProcessEnv;
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

  const providerDataInput: CommonProviderDataInput = {
    mode,
    initialPromptProvided: request.initialPrompt !== undefined,
    configPathProvided: options.configPath !== undefined,
    observerSocketPathProvided: options.observerSocketPath !== undefined,
    ...terminalProviderData(request),
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

  return {
    provider: "opencode",
    command: options.command ?? "opencode",
    args,
    cwd: request.worktree.path,
    env: openCodeLaunchEnv(request, options),
    mode,
    displayTitle: `${request.project.label} OpenCode`,
    providerData: commonProviderData(providerDataInput),
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
    providerData: commonProviderData({
      mode,
      initialPromptProvided: request.initialPrompt !== undefined,
      resume: true,
      resumeTargetKind: request.resume.target.kind,
    }),
  };
}

function openCodeLaunchEnv(
  request: BuildHarnessLaunchRequest,
  options: OpenCodeLaunchOptions,
): Record<string, string> {
  const env = harnessLaunchEnv("opencode", request, options);
  const opencodeConfigDir = options.env?.OPENCODE_CONFIG_DIR ?? process.env.OPENCODE_CONFIG_DIR;
  if (opencodeConfigDir !== undefined && opencodeConfigDir.length > 0) {
    env.OPENCODE_CONFIG_DIR = opencodeConfigDir;
  }
  return env;
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
