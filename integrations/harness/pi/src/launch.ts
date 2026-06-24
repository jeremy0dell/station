import { fileURLToPath } from "node:url";
import type { BuildHarnessLaunchRequest, HarnessLaunchPlan } from "@station/contracts";
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

  const extensionPath = options.extensionPath ?? defaultPiExtensionPath();
  const args = ["--extension", extensionPath];
  if (request.resume !== undefined) {
    // Pi can recover from its session file, so provider normalization chooses
    // that target before falling back to a native session id.
    args.push("--session", resumeTargetValue(request));
  }
  if (request.initialPrompt !== undefined) {
    args.push(request.initialPrompt);
  }

  const providerDataInput: PiLaunchProviderDataInput = {
    extensionPath,
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
  if (options.configPath !== undefined) {
    providerDataInput.configPathProvided = true;
  }
  if (options.observerSocketPath !== undefined) {
    providerDataInput.observerSocketPathProvided = true;
  }

  return {
    provider: "pi",
    command: options.command ?? "pi",
    args,
    cwd: request.worktree.path,
    env: piLaunchEnv(request, options),
    mode,
    displayTitle: `${request.project.label} Pi`,
    providerData: piProviderData(providerDataInput),
  };
}

function defaultPiExtensionPath(): string {
  return fileURLToPath(new URL("../dist/piExtension.js", import.meta.url));
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

function piLaunchEnv(
  request: BuildHarnessLaunchRequest,
  options: PiLaunchOptions,
): Record<string, string> {
  const env: Record<string, string> = {
    STATION_PROJECT_ID: request.project.id,
    STATION_WORKTREE_ID: request.worktree.id,
    STATION_WORKTREE_PATH: request.worktree.path,
    STATION_HARNESS_PROVIDER: "pi",
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

type PiLaunchProviderDataInput = {
  extensionPath: string;
  initialPromptProvided: boolean;
  configPathProvided?: boolean | undefined;
  observerSocketPathProvided?: boolean | undefined;
  terminalProvider?: string | undefined;
  terminalTargetId?: string | undefined;
  resume?: boolean | undefined;
  resumeTargetKind?: string | undefined;
};

function piProviderData(input: PiLaunchProviderDataInput): Record<string, unknown> {
  const providerData: Record<string, unknown> = {
    interactive: true,
    extensionPath: input.extensionPath,
  };
  if (input.initialPromptProvided) {
    providerData.initialPromptProvided = true;
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
