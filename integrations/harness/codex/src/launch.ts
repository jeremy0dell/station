import type {
  BuildHarnessLaunchRequest,
  HarnessLaunchPlan,
  HarnessPermissionMode,
} from "@station/contracts";
import { CodexHarnessProviderError } from "./errors.js";

export type CodexLaunchOptions = {
  command?: string;
  defaultProfile?: string;
  defaultHookProfile?: string;
  defaultPermissionMode?: HarnessPermissionMode;
  defaultApprovalPolicy?: string;
  defaultSandboxMode?: string;
  noAltScreen?: boolean;
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

  const env = codexLaunchEnv(request);
  const providerDataInput: CodexProviderDataInput = {
    mode,
    initialPromptProvided: request.initialPrompt !== undefined,
  };
  if (profile !== undefined) {
    providerDataInput.profile = profile;
  }
  if (hookProfile !== undefined) {
    providerDataInput.hookProfile = hookProfile;
  }
  if (
    hookProfile !== undefined &&
    configuredProfile !== undefined &&
    configuredProfile !== hookProfile
  ) {
    providerDataInput.configuredProfile = configuredProfile;
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
  if (mode === "interactive" && options.noAltScreen !== undefined) {
    providerDataInput.noAltScreen = options.noAltScreen;
  }
  if (request.terminalTarget !== undefined) {
    providerDataInput.terminalProvider = request.terminalTarget.provider;
    providerDataInput.terminalTargetId = request.terminalTarget.id;
  }
  const providerData = codexProviderData(providerDataInput);

  return {
    provider: "codex",
    command: options.command ?? "codex",
    args,
    cwd: request.worktree.path,
    env,
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

  const providerDataInput: CodexProviderDataInput = {
    mode,
    initialPromptProvided: request.initialPrompt !== undefined,
    resume: true,
    resumeTargetKind: request.resume.target.kind,
  };
  if (profile !== undefined) {
    providerDataInput.profile = profile;
  }
  if (hookProfile !== undefined) {
    providerDataInput.hookProfile = hookProfile;
  }
  if (
    hookProfile !== undefined &&
    configuredProfile !== undefined &&
    configuredProfile !== hookProfile
  ) {
    providerDataInput.configuredProfile = configuredProfile;
  }

  return {
    provider: "codex",
    command: options.command ?? "codex",
    args,
    cwd: request.worktree.path,
    env: codexLaunchEnv(request),
    mode,
    displayTitle: `${request.project.label} Codex`,
    providerData: codexProviderData(providerDataInput),
  };
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

function codexLaunchEnv(request: BuildHarnessLaunchRequest): Record<string, string> {
  const env: Record<string, string> = {
    STATION_PROJECT_ID: request.project.id,
    STATION_WORKTREE_ID: request.worktree.id,
    STATION_WORKTREE_PATH: request.worktree.path,
    STATION_HARNESS_PROVIDER: "codex",
  };
  if (request.sessionId !== undefined) {
    env.STATION_SESSION_ID = request.sessionId;
  }
  if (request.terminalTarget !== undefined) {
    env.STATION_TERMINAL_PROVIDER = request.terminalTarget.provider;
    env.STATION_TERMINAL_TARGET_ID = request.terminalTarget.id;
  }
  return env;
}

type CodexProviderDataInput = {
  mode: "interactive" | "exec";
  profile?: string | undefined;
  hookProfile?: string | undefined;
  configuredProfile?: string | undefined;
  permissionMode?: HarnessPermissionMode | undefined;
  approvalPolicy?: string | undefined;
  sandboxMode?: string | undefined;
  noAltScreen?: boolean | undefined;
  initialPromptProvided: boolean;
  terminalProvider?: string | undefined;
  terminalTargetId?: string | undefined;
  resume?: boolean | undefined;
  resumeTargetKind?: string | undefined;
};

function codexProviderData(input: CodexProviderDataInput): Record<string, unknown> {
  const providerData: Record<string, unknown> = {
    interactive: input.mode === "interactive",
  };
  if (input.initialPromptProvided) {
    providerData.initialPromptProvided = true;
  }
  if (input.profile !== undefined) {
    providerData.profile = input.profile;
  }
  if (input.hookProfile !== undefined) {
    providerData.hookProfile = input.hookProfile;
  }
  if (input.configuredProfile !== undefined) {
    providerData.configuredProfile = input.configuredProfile;
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
  if (input.noAltScreen === true) {
    providerData.noAltScreen = true;
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
