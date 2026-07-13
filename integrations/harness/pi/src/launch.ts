import { fileURLToPath } from "node:url";
import type { BuildHarnessLaunchRequest, HarnessLaunchPlan } from "@station/contracts";
import {
  type CommonProviderDataInput,
  commonProviderData,
  harnessLaunchEnv,
  terminalProviderData,
} from "@station/harness-shared";
import { PiHarnessProviderError } from "./errors.js";

export type PiLaunchOptions = {
  command?: string;
  extensionPath?: string;
  configPath?: string;
  observerSocketPath?: string;
  stateDir?: string;
  hookSpoolDir?: string;
};

export function buildPiLaunchPlan(
  request: BuildHarnessLaunchRequest,
  options: PiLaunchOptions = {},
): HarnessLaunchPlan {
  const mode = request.mode ?? "interactive";
  if (mode === "exec") {
    throw new PiHarnessProviderError(
      request.resume === undefined
        ? "HARNESS_PI_EXEC_UNSUPPORTED"
        : "HARNESS_PI_RESUME_UNSUPPORTED",
      request.resume === undefined
        ? "Pi exec mode is not supported by the interactive v1 harness provider."
        : "Pi resume is supported only for interactive launches.",
      {
        hint: "Use an interactive Pi session; JSON/RPC control is not implemented for Pi JSON/RPC mode yet.",
      },
    );
  }

  const extensionPath = resolvePiExtensionPath(options);
  const args = ["--extension", extensionPath];
  if (request.resume !== undefined) {
    // Pi can recover from its session file, so provider normalization chooses
    // that target before falling back to a native session id.
    args.push("--session", resumeTargetValue(request));
  }
  if (request.initialPrompt !== undefined) {
    args.push(request.initialPrompt);
  }

  const providerDataInput: CommonProviderDataInput = {
    mode,
    initialPromptProvided: request.initialPrompt !== undefined,
    configPathProvided: options.configPath !== undefined,
    observerSocketPathProvided: options.observerSocketPath !== undefined,
    ...terminalProviderData(request),
  };
  if (request.resume !== undefined) {
    providerDataInput.resume = true;
    providerDataInput.resumeTargetKind = request.resume.target.kind;
  }
  const providerData = commonProviderData(providerDataInput);
  providerData.extensionPath = extensionPath;

  return {
    provider: "pi",
    command: options.command ?? "pi",
    args,
    cwd: request.worktree.path,
    env: harnessLaunchEnv("pi", request, options),
    mode,
    displayTitle: `${request.project.label} Pi`,
    providerData,
  };
}

export function resolvePiExtensionPath(
  options: Pick<PiLaunchOptions, "extensionPath"> = {},
): string {
  return options.extensionPath ?? fileURLToPath(new URL("../dist/piExtension.js", import.meta.url));
}

function resumeTargetValue(request: BuildHarnessLaunchRequest): string {
  const resume = request.resume;
  if (resume === undefined) {
    throw new PiHarnessProviderError(
      "HARNESS_PI_RESUME_UNSUPPORTED",
      "Pi resume requires a recovery target.",
    );
  }
  return resume.target.kind === "session-file" ? resume.target.path : resume.target.id;
}
