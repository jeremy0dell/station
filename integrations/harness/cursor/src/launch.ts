import type { BuildHarnessLaunchRequest, HarnessLaunchPlan } from "@station/contracts";
import { CursorHarnessProviderError } from "./errors.js";

export type CursorLaunchOptions = {
  command?: string;
};

function cursorLaunchEnv(request: BuildHarnessLaunchRequest): Record<string, string> {
  const env: Record<string, string> = {
    STATION_PROJECT_ID: request.project.id,
    STATION_WORKTREE_ID: request.worktree.id,
    STATION_WORKTREE_PATH: request.worktree.path,
    STATION_HARNESS_PROVIDER: "cursor",
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

function cursorProviderData(input: {
  initialPromptProvided: boolean;
  terminalProvider?: string;
  terminalTargetId?: string;
  resume?: boolean;
  resumeTargetKind?: string;
}): Record<string, unknown> {
  const providerData: Record<string, unknown> = {
    interactive: true,
    observation: "hooks",
  };
  if (input.initialPromptProvided) {
    providerData.initialPromptProvided = true;
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

export function buildCursorLaunchPlan(
  request: BuildHarnessLaunchRequest,
  options: CursorLaunchOptions = {},
): HarnessLaunchPlan {
  const mode = request.mode ?? "interactive";
  if (mode === "exec") {
    throw new CursorHarnessProviderError(
      request.resume === undefined
        ? "HARNESS_CURSOR_EXEC_UNSUPPORTED"
        : "HARNESS_CURSOR_RESUME_UNSUPPORTED",
      request.resume === undefined
        ? "Cursor exec mode is not supported by the hook-only Cursor harness provider."
        : "Cursor resume is supported only for interactive launches.",
      {
        hint: "Use an interactive Cursor agent session; headless stream-json support is intentionally out of scope for this provider slice.",
      },
    );
  }
  if (request.resume !== undefined && request.resume.target.kind !== "native-session") {
    throw new CursorHarnessProviderError(
      "HARNESS_CURSOR_RESUME_UNSUPPORTED",
      "Cursor resume requires a native session target.",
    );
  }

  // Cursor uses the same interactive command for fresh and resumed sessions;
  // the provider-native id is the only extra selector STATION supplies.
  const args = ["--workspace", request.worktree.path];
  if (request.resume?.target.kind === "native-session") {
    args.push("--resume", request.resume.target.id);
  }
  if (request.initialPrompt !== undefined) {
    args.push(request.initialPrompt);
  }

  const providerDataInput: Parameters<typeof cursorProviderData>[0] = {
    initialPromptProvided: request.initialPrompt !== undefined,
  };
  if (request.resume !== undefined) {
    providerDataInput.resume = true;
    providerDataInput.resumeTargetKind = request.resume.target.kind;
  }
  if (request.terminalTarget !== undefined) {
    providerDataInput.terminalProvider = request.terminalTarget.provider;
    providerDataInput.terminalTargetId = request.terminalTarget.id;
  }

  return {
    provider: "cursor",
    command: options.command ?? "agent",
    args,
    cwd: request.worktree.path,
    env: cursorLaunchEnv(request),
    mode,
    displayTitle: `${request.project.label} Cursor`,
    providerData: cursorProviderData(providerDataInput),
  };
}
