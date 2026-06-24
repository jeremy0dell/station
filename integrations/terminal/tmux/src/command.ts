import type { SafeError } from "@station/contracts";
import {
  type ExternalCommandResult,
  type ExternalCommandRunner,
  type RuntimeClock,
  runExternalCommand,
  runRuntimeBoundaryWithRetryAndTimeout,
} from "@station/runtime";

export type TmuxCommandInput = {
  command: string;
  runner?: ExternalCommandRunner;
  timeoutMs?: number;
  clock?: RuntimeClock;
};

export type TmuxCommandOptions = {
  args: string[];
  operation: string;
  fallback: SafeError;
  timeoutError?: SafeError;
  retries?: number;
  delayMs?: number;
  maxOutputChars?: number;
  shouldRetry?: (error: SafeError) => boolean;
};

export async function runTmuxCommand(
  input: TmuxCommandInput,
  options: TmuxCommandOptions,
): Promise<ExternalCommandResult> {
  const retry: { retries: number; delayMs?: number; shouldRetry?: (error: SafeError) => boolean } =
    {
      retries: options.retries ?? 0,
    };
  if (options.delayMs !== undefined) retry.delayMs = options.delayMs;
  if (options.shouldRetry !== undefined) retry.shouldRetry = options.shouldRetry;

  const boundaryOptions: Parameters<typeof runRuntimeBoundaryWithRetryAndTimeout>[0] = {
    operation: options.operation,
    timeoutMs: input.timeoutMs ?? 5000,
    error: options.fallback,
    timeoutError:
      options.timeoutError ??
      ({
        tag: "TerminalProviderError",
        code: "TERMINAL_TMUX_TIMEOUT",
        message: "tmux command timed out.",
        provider: "tmux",
      } satisfies SafeError),
    retry,
  };
  if (input.clock !== undefined) boundaryOptions.clock = input.clock;

  const result = await runRuntimeBoundaryWithRetryAndTimeout(boundaryOptions, ({ signal }) =>
    runExternalCommand(
      {
        command: input.command,
        args: options.args,
        signal,
        maxOutputChars: options.maxOutputChars ?? 4096,
      },
      input.runner,
    ),
  );

  if (!result.ok) {
    throw result.error;
  }
  return result.value as ExternalCommandResult;
}

export async function tryRunTmuxCommand(
  input: TmuxCommandInput,
  options: TmuxCommandOptions,
): Promise<ExternalCommandResult | undefined> {
  try {
    return await runTmuxCommand(input, options);
  } catch {
    return undefined;
  }
}
