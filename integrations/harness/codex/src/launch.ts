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
import { CodexHarnessProviderError } from "./errors.js";

export type CodexLaunchOptions = {
  command?: string;
  defaultProfile?: string;
  defaultHookProfile?: string;
  defaultPermissionMode?: HarnessPermissionMode;
  defaultApprovalPolicy?: string;
  defaultSandboxMode?: string;
  noAltScreen?: boolean;
  env?: NodeJS.ProcessEnv;
};

const CODEX_YOLO_FLAG = "--dangerously-bypass-approvals-and-sandbox";

export function buildCodexLaunchPlan(
  request: BuildHarnessLaunchRequest,
  options: CodexLaunchOptions = {},
): HarnessLaunchPlan {
  const mode = request.mode ?? "interactive";
  if (request.resume !== undefined) {
    return buildCodexResumeLaunchPlan(request, options, mode);
  }
  const configuredProfile = request.profile ?? options.defaultProfile;
  const hookProfile = options.defaultHookProfile;
  const profile = hookProfile ?? configuredProfile;
  const permissionMode = request.permissionMode ?? options.defaultPermissionMode;
  const approvalPolicy = request.approvalPolicy ?? options.defaultApprovalPolicy;
  const sandboxMode = request.sandboxMode ?? options.defaultSandboxMode;
  const yolo = isYoloPermissionMode({ permissionMode, approvalPolicy, sandboxMode });
  const providerPermissionMode = yolo ? "yolo" : permissionMode;
  const args = mode === "exec" ? execArgs(request) : interactiveArgs(request);
  appendCodexOptions(args, {
    profile,
    permissionMode: providerPermissionMode,
    approvalPolicy: yolo || mode === "exec" ? undefined : approvalPolicy,
    sandboxMode: yolo ? undefined : sandboxMode,
    noAltScreen: mode === "interactive" ? options.noAltScreen : undefined,
  });
  if (request.initialPrompt !== undefined) {
    args.push(request.initialPrompt);
  }

  const providerDataInput: CommonProviderDataInput = {
    mode,
    initialPromptProvided: request.initialPrompt !== undefined,
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
  const providerData = codexProviderData(providerDataInput, {
    configuredProfile,
    hookProfile,
    noAltScreen: mode === "interactive" ? options.noAltScreen : undefined,
  });

  return {
    provider: "codex",
    command: options.command ?? "codex",
    args,
    cwd: request.worktree.path,
    env: codexLaunchEnv(request, options),
    mode,
    displayTitle: `${request.project.label} Codex`,
    providerData,
  };
}

function buildCodexResumeLaunchPlan(
  request: BuildHarnessLaunchRequest,
  options: CodexLaunchOptions,
  mode: "interactive" | "exec",
): HarnessLaunchPlan {
  // Resume must use a durable native id; adapters should not synthesize latest/continue selectors.
  if (mode === "exec") {
    throw new CodexHarnessProviderError(
      "HARNESS_CODEX_RESUME_UNSUPPORTED",
      "Codex resume is supported only for interactive launches.",
      { hint: "Start an interactive Codex resume session instead." },
    );
  }
  if (request.resume?.target.kind !== "native-session") {
    throw new CodexHarnessProviderError(
      "HARNESS_CODEX_RESUME_UNSUPPORTED",
      "Codex resume requires a native session target.",
    );
  }

  const configuredProfile = request.profile ?? options.defaultProfile;
  const hookProfile = options.defaultHookProfile;
  const profile = hookProfile ?? configuredProfile;
  const args = ["resume", "--cd", request.worktree.path];
  appendCodexOptions(args, { profile });
  args.push(request.resume.target.id);
  if (request.initialPrompt !== undefined) {
    args.push(request.initialPrompt);
  }

  const providerDataInput: CommonProviderDataInput = {
    mode,
    initialPromptProvided: request.initialPrompt !== undefined,
    resume: true,
    resumeTargetKind: request.resume.target.kind,
  };
  if (profile !== undefined) {
    providerDataInput.profile = profile;
  }
  const providerData = codexProviderData(providerDataInput, { configuredProfile, hookProfile });

  return {
    provider: "codex",
    command: options.command ?? "codex",
    args,
    cwd: request.worktree.path,
    env: codexLaunchEnv(request, options),
    mode,
    displayTitle: `${request.project.label} Codex`,
    providerData,
  };
}

function interactiveArgs(request: BuildHarnessLaunchRequest): string[] {
  return ["--cd", request.worktree.path];
}

function execArgs(request: BuildHarnessLaunchRequest): string[] {
  return ["exec", "--json", "--cd", request.worktree.path];
}

function appendCodexOptions(
  args: string[],
  options: {
    profile?: string | undefined;
    permissionMode?: HarnessPermissionMode | undefined;
    approvalPolicy?: string | undefined;
    sandboxMode?: string | undefined;
    noAltScreen?: boolean | undefined;
  },
): void {
  if (options.profile !== undefined) {
    args.push("--profile", options.profile);
  }
  if (options.permissionMode === "yolo") {
    args.push(CODEX_YOLO_FLAG);
  }
  if (options.sandboxMode !== undefined) {
    args.push("--sandbox", options.sandboxMode);
  }
  if (options.approvalPolicy !== undefined) {
    args.push("--ask-for-approval", options.approvalPolicy);
  }
  if (options.noAltScreen === true) {
    args.push("--no-alt-screen");
  }
}

function codexLaunchEnv(
  request: BuildHarnessLaunchRequest,
  options: CodexLaunchOptions,
): Record<string, string> {
  const env = harnessLaunchEnv("codex", request);
  const codexHome = options.env?.CODEX_HOME ?? process.env.CODEX_HOME;
  if (codexHome !== undefined && codexHome.length > 0) {
    env.CODEX_HOME = codexHome;
  }
  return env;
}

function codexProviderData(
  input: CommonProviderDataInput,
  options: {
    hookProfile?: string | undefined;
    configuredProfile?: string | undefined;
    noAltScreen?: boolean | undefined;
  },
): Record<string, unknown> {
  const providerData = commonProviderData(input);
  if (options.hookProfile !== undefined) providerData.hookProfile = options.hookProfile;
  if (
    options.hookProfile !== undefined &&
    options.configuredProfile !== undefined &&
    options.configuredProfile !== options.hookProfile
  ) {
    providerData.configuredProfile = options.configuredProfile;
  }
  if (options.noAltScreen === true) providerData.noAltScreen = true;
  return providerData;
}
