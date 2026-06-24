import type {
  BuildHarnessLaunchRequest,
  HarnessLaunchPlan,
  HarnessPermissionMode,
} from "@station/contracts";
import { ClaudeHarnessProviderError } from "./errors.js";

export type ClaudePermissionMode = HarnessPermissionMode | "auto";

export type ClaudeLaunchOptions = {
  command?: string;
  defaultProfile?: string;
  defaultPermissionMode?: ClaudePermissionMode;
  defaultApprovalPolicy?: string;
  defaultSandboxMode?: string;
  hookSettingsPath?: string;
};

type ClaudeProviderDataInput = {
  mode: "interactive" | "exec";
  initialPromptProvided: boolean;
  profile?: string | undefined;
  permissionMode?: ClaudePermissionMode | undefined;
  settingsInjected?: boolean | undefined;
  terminalProvider?: string | undefined;
  terminalTargetId?: string | undefined;
  resume?: boolean | undefined;
  resumeTargetKind?: string | undefined;
};

const CLAUDE_YOLO_FLAG = "--dangerously-skip-permissions";
const CLAUDE_PERMISSION_MODE_FLAG = "--permission-mode";

function isYoloPermissionMode(input: {
  permissionMode?: ClaudePermissionMode | undefined;
  approvalPolicy?: string | undefined;
  sandboxMode?: string | undefined;
}): boolean {
  if (input.permissionMode !== undefined) {
    return input.permissionMode === "yolo";
  }
  return input.approvalPolicy === "never" && input.sandboxMode === "danger-full-access";
}

function claudeLaunchEnv(request: BuildHarnessLaunchRequest): Record<string, string> {
  const env: Record<string, string> = {
    STATION_PROJECT_ID: request.project.id,
    STATION_WORKTREE_ID: request.worktree.id,
    STATION_WORKTREE_PATH: request.worktree.path,
    STATION_HARNESS_PROVIDER: "claude",
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

function claudeProviderData(input: ClaudeProviderDataInput): Record<string, unknown> {
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
  if (input.settingsInjected === true) {
    providerData.settingsInjected = true;
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

function buildClaudeResumeLaunchPlan(
  request: BuildHarnessLaunchRequest,
  options: ClaudeLaunchOptions,
  mode: "interactive" | "exec",
): HarnessLaunchPlan {
  // Claude resumes by native session id only; there is no safe file target or
  // "latest" selector in the observer-owned recovery path.
  if (mode === "exec") {
    throw new ClaudeHarnessProviderError(
      "HARNESS_CLAUDE_RESUME_UNSUPPORTED",
      "Claude resume is supported only for interactive launches.",
      { hint: "Start an interactive Claude resume session instead." },
    );
  }
  if (request.resume?.target.kind !== "native-session") {
    throw new ClaudeHarnessProviderError(
      "HARNESS_CLAUDE_RESUME_UNSUPPORTED",
      "Claude resume requires a native session target.",
    );
  }

  // Resume intentionally does not re-apply STATION permission config (auto/yolo); the
  // resumed Claude session keeps its own persisted permission handling.
  const args = ["--resume", request.resume.target.id];
  if (options.hookSettingsPath !== undefined) {
    args.push("--settings", options.hookSettingsPath);
  }
  if (request.initialPrompt !== undefined) {
    args.push(request.initialPrompt);
  }

  const providerDataInput: ClaudeProviderDataInput = {
    mode,
    initialPromptProvided: request.initialPrompt !== undefined,
    resume: true,
    resumeTargetKind: request.resume.target.kind,
  };
  if (options.hookSettingsPath !== undefined) {
    providerDataInput.settingsInjected = true;
  }

  return {
    provider: "claude",
    command: options.command ?? "claude",
    args,
    cwd: request.worktree.path,
    env: claudeLaunchEnv(request),
    mode,
    displayTitle: `${request.project.label} Claude`,
    providerData: claudeProviderData(providerDataInput),
  };
}

export function buildClaudeLaunchPlan(
  request: BuildHarnessLaunchRequest,
  options: ClaudeLaunchOptions = {},
): HarnessLaunchPlan {
  const mode = request.mode ?? "interactive";
  if (request.resume !== undefined) {
    return buildClaudeResumeLaunchPlan(request, options, mode);
  }
  const profile = request.profile ?? options.defaultProfile;
  const permissionMode = request.permissionMode ?? options.defaultPermissionMode;
  const approvalPolicy = request.approvalPolicy ?? options.defaultApprovalPolicy;
  const sandboxMode = request.sandboxMode ?? options.defaultSandboxMode;
  const yolo = isYoloPermissionMode({ permissionMode, approvalPolicy, sandboxMode });
  const providerPermissionMode = yolo ? "yolo" : permissionMode;

  // Claude Code has no --cd flag; the worktree is selected via the launch plan cwd.
  const args: string[] =
    mode === "exec" ? ["-p", "--output-format", "stream-json", "--verbose"] : [];
  if (profile !== undefined) {
    args.push("--agent", profile);
  }
  if (yolo) {
    args.push(CLAUDE_YOLO_FLAG);
  } else if (permissionMode === "auto") {
    // Honor explicitly-configured auto in every launch mode (interactive and exec),
    // mirroring the yolo branch above; it is intentionally not gated to interactive.
    args.push(CLAUDE_PERMISSION_MODE_FLAG, "auto");
  }
  if (options.hookSettingsPath !== undefined) {
    args.push("--settings", options.hookSettingsPath);
  }
  if (request.initialPrompt !== undefined) {
    args.push(request.initialPrompt);
  }

  const providerDataInput: ClaudeProviderDataInput = {
    mode,
    initialPromptProvided: request.initialPrompt !== undefined,
  };
  if (profile !== undefined) {
    providerDataInput.profile = profile;
  }
  if (providerPermissionMode !== undefined) {
    providerDataInput.permissionMode = providerPermissionMode;
  }
  if (options.hookSettingsPath !== undefined) {
    providerDataInput.settingsInjected = true;
  }
  if (request.terminalTarget !== undefined) {
    providerDataInput.terminalProvider = request.terminalTarget.provider;
    providerDataInput.terminalTargetId = request.terminalTarget.id;
  }

  return {
    provider: "claude",
    command: options.command ?? "claude",
    args,
    cwd: request.worktree.path,
    env: claudeLaunchEnv(request),
    mode,
    displayTitle: `${request.project.label} Claude`,
    providerData: claudeProviderData(providerDataInput),
  };
}
