import type {
  BuildHarnessLaunchRequest,
  HarnessPermissionMode,
  ProviderId,
} from "@station/contracts";

export type CommonLaunchEnvOptions = {
  configPath?: string | undefined;
  observerSocketPath?: string | undefined;
  stateDir?: string | undefined;
  hookSpoolDir?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
  carryEnv?: readonly LaunchEnvCarry[] | undefined;
};

export type LaunchEnvCarry = {
  from: string;
  to?: string | undefined;
};

export type CommonProviderDataInput = {
  mode: "interactive" | "exec";
  initialPromptProvided: boolean;
  profile?: string | undefined;
  permissionMode?: string | undefined;
  approvalPolicy?: string | undefined;
  sandboxMode?: string | undefined;
  configPathProvided?: boolean | undefined;
  observerSocketPathProvided?: boolean | undefined;
  terminalProvider?: string | undefined;
  terminalTargetId?: string | undefined;
  resume?: boolean | undefined;
  resumeTargetKind?: string | undefined;
};

export function harnessLaunchEnv(
  provider: ProviderId,
  request: BuildHarnessLaunchRequest,
  options: CommonLaunchEnvOptions = {},
): Record<string, string> {
  const env: Record<string, string> = {
    STATION_PROJECT_ID: request.project.id,
    STATION_WORKTREE_ID: request.worktree.id,
    STATION_WORKTREE_PATH: request.worktree.path,
    STATION_HARNESS_PROVIDER: provider,
  };
  if (request.sessionId !== undefined) env.STATION_SESSION_ID = request.sessionId;
  if (request.terminalTarget !== undefined) {
    env.STATION_TERMINAL_PROVIDER = request.terminalTarget.provider;
    env.STATION_TERMINAL_TARGET_ID = request.terminalTarget.id;
  }
  if (options.configPath !== undefined) env.STATION_CONFIG_PATH = options.configPath;
  if (options.observerSocketPath !== undefined) {
    env.STATION_OBSERVER_SOCKET_PATH = options.observerSocketPath;
  }
  if (options.stateDir !== undefined) env.STATION_OBSERVER_STATE_DIR = options.stateDir;
  if (options.hookSpoolDir !== undefined) env.STATION_HOOK_SPOOL_DIR = options.hookSpoolDir;
  for (const carry of options.carryEnv ?? []) {
    carryLaunchEnv(env, carry, options.env);
  }
  return env;
}

function carryLaunchEnv(
  env: Record<string, string>,
  carry: LaunchEnvCarry,
  source?: Record<string, string | undefined>,
): void {
  const value = source?.[carry.from] ?? process.env[carry.from];
  if (value !== undefined && value.length > 0) {
    env[carry.to ?? carry.from] = value;
  }
}

export function commonProviderData(input: CommonProviderDataInput): Record<string, unknown> {
  const providerData: Record<string, unknown> = {
    interactive: input.mode === "interactive",
  };
  assignDefined(
    providerData,
    "initialPromptProvided",
    input.initialPromptProvided ? true : undefined,
  );
  assignDefined(providerData, "profile", input.profile);
  assignDefined(providerData, "permissionMode", input.permissionMode);
  assignDefined(providerData, "approvalPolicy", input.approvalPolicy);
  assignDefined(providerData, "sandboxMode", input.sandboxMode);
  assignDefined(
    providerData,
    "configPathProvided",
    input.configPathProvided === true ? true : undefined,
  );
  assignDefined(
    providerData,
    "observerSocketPathProvided",
    input.observerSocketPathProvided === true ? true : undefined,
  );
  assignDefined(providerData, "terminalProvider", input.terminalProvider);
  assignDefined(providerData, "terminalTargetId", input.terminalTargetId);
  assignDefined(providerData, "resume", input.resume === true ? true : undefined);
  assignDefined(providerData, "resumeTargetKind", input.resumeTargetKind);
  return providerData;
}

export function terminalProviderData(
  request: BuildHarnessLaunchRequest,
): Pick<CommonProviderDataInput, "terminalProvider" | "terminalTargetId"> {
  const output: Pick<CommonProviderDataInput, "terminalProvider" | "terminalTargetId"> = {};
  if (request.terminalTarget !== undefined) {
    output.terminalProvider = request.terminalTarget.provider;
    output.terminalTargetId = request.terminalTarget.id;
  }
  return output;
}

export function isYoloPermissionMode(input: {
  permissionMode?: HarnessPermissionMode | "auto" | undefined;
  approvalPolicy?: string | undefined;
  sandboxMode?: string | undefined;
}): boolean {
  if (input.permissionMode !== undefined) {
    return input.permissionMode === "yolo";
  }
  return input.approvalPolicy === "never" && input.sandboxMode === "danger-full-access";
}

export function assignDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
