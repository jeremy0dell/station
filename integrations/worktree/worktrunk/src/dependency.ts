import type { SafeError } from "@station/contracts";
import {
  type ExternalCommandRunner,
  gitLocalEnvironmentVariables,
  type ResolveExecutablePathOptions,
  resolveExecutablePath,
  runExternalCommand,
  safeErrorFromUnknown,
} from "@station/runtime";
import { ProviderUnavailableError } from "./errors.js";

export type WorktrunkDependencyStatus =
  | {
      status: "available";
      attemptedCommand: string;
      installHint: string;
      resolvedPath?: string;
      version?: string;
      rawVersion?: string;
    }
  | {
      status: "unavailable";
      attemptedCommand: string;
      installHint: string;
      resolvedPath?: string;
      error: SafeError;
    };

export type CheckWorktrunkDependencyOptions = {
  command?: string;
  timeoutMs?: number;
  runner?: ExternalCommandRunner;
  pathEnv?: string;
  access?: (path: string) => Promise<void>;
};

export const defaultWorktrunkCommand = "wt";

export function worktrunkInstallHint(command = defaultWorktrunkCommand): string {
  return [
    "Install Worktrunk with brew install worktrunk && wt config shell install.",
    `station tried ${command}.`,
    "Set worktree.worktrunk.command or STATION_WORKTRUNK_BIN if the binary lives elsewhere.",
  ].join(" ");
}

export async function checkWorktrunkDependency(
  options: CheckWorktrunkDependencyOptions = {},
): Promise<WorktrunkDependencyStatus> {
  const attemptedCommand =
    options.command ?? process.env.STATION_WORKTRUNK_BIN ?? defaultWorktrunkCommand;
  const installHint = worktrunkInstallHint(attemptedCommand);
  const resolveOptions: ResolveExecutablePathOptions = {};
  if (options.pathEnv !== undefined) resolveOptions.pathEnv = options.pathEnv;
  if (options.access !== undefined) resolveOptions.access = options.access;
  const resolvedPath = await resolveExecutablePath(attemptedCommand, resolveOptions);
  const requiresResolvedPath = options.pathEnv !== undefined || options.access !== undefined;
  if (resolvedPath === undefined && requiresResolvedPath) {
    const error = new ProviderUnavailableError("Worktrunk is not available.", {
      hint: installHint,
      command: attemptedCommand,
      installHint,
    });
    return {
      status: "unavailable",
      attemptedCommand,
      installHint,
      error: safeErrorFromUnknown(error, {
        tag: "ProviderUnavailableError",
        code: "WORKTRUNK_UNAVAILABLE",
        message: "Worktrunk is not available.",
        hint: installHint,
        provider: "worktrunk",
      }),
    };
  }
  const probeCommand = resolvedPath ?? attemptedCommand;

  try {
    const output = await runExternalCommand(
      {
        command: probeCommand,
        args: ["--version"],
        unsetEnv: gitLocalEnvironmentVariables,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        maxOutputChars: 4096,
      },
      options.runner,
    );
    const rawVersion = `${output.stdout}${output.stderr}`.trim();
    const status: WorktrunkDependencyStatus = {
      status: "available",
      attemptedCommand,
      installHint,
    };
    if (resolvedPath !== undefined) status.resolvedPath = resolvedPath;
    if (rawVersion.length > 0) status.rawVersion = rawVersion;
    const version = parseWorktrunkVersion(rawVersion);
    if (version !== undefined) status.version = version;
    return status;
  } catch (cause) {
    const error = new ProviderUnavailableError("Worktrunk is not available.", {
      hint: installHint,
      command: attemptedCommand,
      installHint,
      cause,
    });
    const status: WorktrunkDependencyStatus = {
      status: "unavailable",
      attemptedCommand,
      installHint,
      error: safeErrorFromUnknown(error, {
        tag: "ProviderUnavailableError",
        code: "WORKTRUNK_UNAVAILABLE",
        message: "Worktrunk is not available.",
        hint: installHint,
        provider: "worktrunk",
      }),
    };
    return status;
  }
}

export function parseWorktrunkVersion(output: string): string | undefined {
  return output.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/)?.[1];
}
