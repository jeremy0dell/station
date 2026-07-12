import {
  type ExternalCommandRunner,
  gitLocalEnvironmentVariables,
  runExternalCommand,
} from "@station/runtime";

export type GitCommandContext = {
  cwd: string;
  timeoutMs: number;
  runner?: ExternalCommandRunner;
  signal?: AbortSignal;
};

export type RunGitCommandOptions = {
  maxOutputChars: number;
  errorOnNonZeroExit?: (result: Awaited<ReturnType<typeof runExternalCommand>>) => unknown;
};

export async function runGitCommand(
  command: GitCommandContext,
  args: string[],
  options: RunGitCommandOptions,
): Promise<Awaited<ReturnType<typeof runExternalCommand>>> {
  const input: Parameters<typeof runExternalCommand>[0] = {
    command: "git",
    args,
    cwd: command.cwd,
    timeoutMs: command.timeoutMs,
    maxOutputChars: options.maxOutputChars,
    unsetEnv: gitLocalEnvironmentVariables,
  };
  if (command.signal !== undefined) input.signal = command.signal;
  const result = await runExternalCommand(input, command.runner);
  if (result.exitCode !== 0 && options.errorOnNonZeroExit !== undefined) {
    throw options.errorOnNonZeroExit(result);
  }
  return result;
}

export async function runOptionalGitCommand(
  command: GitCommandContext,
  args: string[],
  options: RunGitCommandOptions,
): Promise<Awaited<ReturnType<typeof runExternalCommand>> | undefined> {
  try {
    return await runGitCommand(command, args, options);
  } catch {
    return undefined;
  }
}
