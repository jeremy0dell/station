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

const CLAUDE_YOLO_FLAG = "--dangerously-skip-permissions";
const CLAUDE_PERMISSION_MODE_FLAG = "--permission-mode";

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

  const providerDataInput: CommonProviderDataInput = {
    mode,
    initialPromptProvided: request.initialPrompt !== undefined,
    resume: true,
    resumeTargetKind: request.resume.target.kind,
  };
  const providerData = commonProviderData(providerDataInput);
  if (options.hookSettingsPath !== undefined) {
    providerData.settingsInjected = true;
  }

  return {
    provider: "claude",
    command: options.command ?? "claude",
    args,
    cwd: request.worktree.path,
    env: harnessLaunchEnv("claude", request),
    mode,
    displayTitle: `${request.project.label} Claude`,
    providerData,
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
  const providerData = commonProviderData(providerDataInput);
  if (options.hookSettingsPath !== undefined) providerData.settingsInjected = true;

  return {
    provider: "claude",
    command: options.command ?? "claude",
    args,
    cwd: request.worktree.path,
    env: harnessLaunchEnv("claude", request),
    mode,
    displayTitle: `${request.project.label} Claude`,
    providerData,
  };
}
