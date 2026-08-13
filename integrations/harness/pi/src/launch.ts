import { fileURLToPath } from "node:url";
import type { BuildHarnessLaunchRequest, HarnessLaunchPlan } from "@station/contracts";
import {
  type CommonLaunchEnvOptions,
  type CommonProviderDataInput,
  commonProviderData,
  harnessLaunchEnv,
  terminalProviderData,
} from "@station/harness-shared";
import { PiHarnessProviderError } from "./errors.js";

export type PiLaunchOptions = Pick<
  CommonLaunchEnvOptions,
  "configPath" | "observerSocketPath" | "stateDir" | "hookSpoolDir" | "hookBin"
> & {
  command?: string;
  extensionPath?: string;
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

  const extensionPath =
    options.extensionPath ?? fileURLToPath(new URL("../dist/piExtension.js", import.meta.url));
  const args = ["--extension", extensionPath];
  if (request.resume !== undefined) {
    // Pi can recover from its session file, so provider normalization chooses
    // that target before falling back to a native session id.
    args.push(
      "--session",
      request.resume.target.kind === "session-file"
        ? request.resume.target.path
        : request.resume.target.id,
    );
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
