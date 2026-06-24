import type { BuildHarnessLaunchRequest, HarnessLaunchPlan } from "@station/contracts";
import {
  type CommonProviderDataInput,
  commonProviderData,
  harnessLaunchEnv,
  terminalProviderData,
} from "@station/harness-shared";
import { CursorHarnessProviderError } from "./errors.js";

export type CursorLaunchOptions = {
  command?: string;
};

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

  const providerDataInput: CommonProviderDataInput = {
    mode,
    initialPromptProvided: request.initialPrompt !== undefined,
    ...terminalProviderData(request),
  };
  if (request.resume !== undefined) {
    providerDataInput.resume = true;
    providerDataInput.resumeTargetKind = request.resume.target.kind;
  }
  const providerData = commonProviderData(providerDataInput);
  providerData.observation = "hooks";

  return {
    provider: "cursor",
    command: options.command ?? "agent",
    args,
    cwd: request.worktree.path,
    env: harnessLaunchEnv("cursor", request),
    mode,
    displayTitle: `${request.project.label} Cursor`,
    providerData,
  };
}
