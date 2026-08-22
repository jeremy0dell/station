import type { SafeError } from "@station/contracts";
import {
  type ExternalCommandResult,
  type ExternalCommandRunner,
  externalCommandDiagnosticFromSafeError,
  type RuntimeClock,
  type RuntimeSafeError,
  runExternalCommand,
  runRuntimeBoundaryWithRetryAndTimeout,
} from "@station/runtime";
import { tmuxProviderErrorFromUnknown } from "./errors.js";
import type { PlacementCommandRunner } from "./placement/types.js";
import type { TmuxWorkbenchConfig } from "./topology.js";

export type TmuxCommandInput = {
  command: string;
  /** Fixed provider endpoint. Popup callers omit this to stay on the invoking server. */
  socketPath?: string;
  /** Popup callers may intentionally inherit the invoking tmux server from TMUX. */
  inheritTmuxEnvironment?: boolean;
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

export function createPlacementCommandRunner(input: {
  command: string;
  config: TmuxWorkbenchConfig;
  timeoutMs: number;
  runner?: ExternalCommandRunner;
  clock: RuntimeClock;
}): PlacementCommandRunner {
  return async (args, operation) => {
    const commandInput: TmuxCommandInput = {
      command: input.command,
      timeoutMs: input.timeoutMs,
      clock: input.clock,
    };
    if (input.config.workbenchSocketPath !== undefined) {
      commandInput.socketPath = input.config.workbenchSocketPath;
    }
    if (input.runner !== undefined) commandInput.runner = input.runner;
    try {
      return await runTmuxCommand(commandInput, {
        args,
        operation: `provider.tmux.placement.${operation}`,
        fallback: {
          tag: "TerminalProviderError",
          code:
            operation === "open"
              ? "TERMINAL_OPEN_FAILED"
              : operation === "release"
                ? "TERMINAL_CLEANUP_UNCERTAIN"
                : "TERMINAL_PLACEMENT_REJECTED",
          message: "tmux failed to validate or apply terminal placement.",
          provider: "tmux",
        },
        retries: 0,
        maxOutputChars: 512 * 1024,
      });
    } catch (error) {
      if (operation === "release") throw error;
      throw tmuxProviderErrorFromUnknown(error, {
        code: operation === "open" ? "TERMINAL_OPEN_FAILED" : "TERMINAL_PLACEMENT_REJECTED",
        message: "tmux failed to validate or apply terminal placement.",
      });
    }
  };
}

export function isExpectedWorkbenchAbsence(error: unknown, sessionName: string): boolean {
  const normalized = tmuxProviderErrorFromUnknown(error, {
    code: "TERMINAL_PLACEMENT_REJECTED",
    message: "tmux failed to inspect the configured workbench session.",
  });
  const diagnostic = externalCommandDiagnosticFromSafeError(normalized);
  if (diagnostic?.exitCode !== 1 || diagnostic.stderrSnippet === undefined) return false;
  const escaped = sessionName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^(?:can't find session: ${escaped}|no server running on .+)$`, "u").test(
    diagnostic.stderrSnippet.trim(),
  );
}

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

  const result = await runRuntimeBoundaryWithRetryAndTimeout(boundaryOptions, ({ signal }) => {
    const commandInput: Parameters<typeof runExternalCommand>[0] = {
      command: input.command,
      args:
        input.socketPath === undefined ? options.args : ["-S", input.socketPath, ...options.args],
      displayArgs:
        input.socketPath === undefined
          ? options.args
          : ["-S", "<configured-tmux-endpoint>", ...options.args],
      signal,
      maxOutputChars: options.maxOutputChars ?? 4096,
    };
    if (input.inheritTmuxEnvironment !== true) {
      commandInput.unsetEnv = ["TMUX", "TMUX_PANE"];
    }
    return runExternalCommand(commandInput, input.runner);
  });

  if (!result.ok) {
    throw redactConfiguredEndpoint(result.error, input.socketPath);
  }
  return result.value as ExternalCommandResult;
}

function redactConfiguredEndpoint(
  error: RuntimeSafeError,
  socketPath: string | undefined,
): RuntimeSafeError {
  if (socketPath === undefined || socketPath.length === 0) return error;
  const redact = (value: string): string =>
    value.replaceAll(socketPath, "<configured-tmux-endpoint>");
  const details = error.diagnosticDetails?.map((detail) => {
    if (detail.type !== "external_command") return detail;
    const sanitized = { ...detail };
    sanitized.command = redact(sanitized.command);
    if (sanitized.cwd !== undefined) sanitized.cwd = redact(sanitized.cwd);
    if (sanitized.stderrSnippet !== undefined) {
      sanitized.stderrSnippet = redact(sanitized.stderrSnippet);
    }
    if (sanitized.stdoutSnippet !== undefined) {
      sanitized.stdoutSnippet = redact(sanitized.stdoutSnippet);
    }
    if (sanitized.pathEnv !== undefined) sanitized.pathEnv = redact(sanitized.pathEnv);
    return sanitized;
  });
  if (details === undefined) return error;
  return { ...error, diagnosticDetails: details };
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
