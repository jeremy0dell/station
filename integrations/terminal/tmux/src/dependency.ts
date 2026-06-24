import type { SafeError } from "@station/contracts";
import {
  type ExternalCommandRunner,
  type ResolveExecutablePathOptions,
  resolveExecutablePath,
  runExternalCommand,
} from "@station/runtime";

export type TmuxDependencyStatus =
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

export type CheckTmuxDependencyOptions = {
  command?: string;
  timeoutMs?: number;
  runner?: ExternalCommandRunner;
  pathEnv?: string;
  access?: (path: string) => Promise<void>;
};

export const defaultTmuxCommand = "tmux";

export function tmuxInstallHint(command = defaultTmuxCommand): string {
  return [
    "Install tmux with brew install tmux.",
    `station tried ${command}.`,
    "Set terminal.tmux.command or STATION_TMUX_BIN if the binary lives elsewhere.",
  ].join(" ");
}

export async function checkTmuxDependency(
  options: CheckTmuxDependencyOptions = {},
): Promise<TmuxDependencyStatus> {
  const attemptedCommand = options.command ?? process.env.STATION_TMUX_BIN ?? defaultTmuxCommand;
  const installHint = tmuxInstallHint(attemptedCommand);
  const resolveOptions: ResolveExecutablePathOptions = {};
  if (options.pathEnv !== undefined) resolveOptions.pathEnv = options.pathEnv;
  if (options.access !== undefined) resolveOptions.access = options.access;
  const resolvedPath = await resolveExecutablePath(attemptedCommand, resolveOptions);
  const requiresResolvedPath = options.pathEnv !== undefined || options.access !== undefined;
  if (resolvedPath === undefined && requiresResolvedPath) {
    return {
      status: "unavailable",
      attemptedCommand,
      installHint,
      error: {
        tag: "ProviderUnavailableError",
        code: "TMUX_UNAVAILABLE",
        message: "tmux is not available.",
        hint: installHint,
        provider: "tmux",
      },
    };
  }
  const probeCommand = resolvedPath ?? attemptedCommand;

  try {
    const output = await runExternalCommand(
      {
        command: probeCommand,
        args: ["-V"],
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        maxOutputChars: 4096,
      },
      options.runner,
    );
    const rawVersion = `${output.stdout}${output.stderr}`.trim();
    const status: TmuxDependencyStatus = {
      status: "available",
      attemptedCommand,
      installHint,
    };
    if (resolvedPath !== undefined) status.resolvedPath = resolvedPath;
    if (rawVersion.length > 0) status.rawVersion = rawVersion;
    const version = parseTmuxVersion(rawVersion);
    if (version !== undefined) status.version = version;
    return status;
  } catch {
    const status: TmuxDependencyStatus = {
      status: "unavailable",
      attemptedCommand,
      installHint,
      error: {
        tag: "ProviderUnavailableError",
        code: "TMUX_UNAVAILABLE",
        message: "tmux is not available.",
        hint: installHint,
        provider: "tmux",
      },
    };
    return status;
  }
}

export function parseTmuxVersion(output: string): string | undefined {
  return output.match(/\btmux\s+([0-9A-Za-z][0-9A-Za-z.+-]*)\b/)?.[1];
}
