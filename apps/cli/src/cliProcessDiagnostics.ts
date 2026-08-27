import type { LoadedStationConfig, ObserverPaths } from "@station/config";
import type { CommandId, LogRecord } from "@station/contracts";
import {
  type CreateJsonlLoggerOptions,
  componentLogPath,
  createJsonlLogger,
  type JsonlLogger,
} from "@station/observability";
import { safeErrorFromUnknown } from "@station/runtime";

export type CliRunCorrelation = {
  commandId: CommandId;
  traceId?: string;
  status: "accepted" | "rejected" | "succeeded" | "failed";
};

export type CliProcessDeps = {
  randomUUID?: () => string;
  clock?: { now(): Date };
  loadConfig?: (configPath?: string) => Promise<LoadedStationConfig>;
  resolveObserverPaths?: (config: LoadedStationConfig["config"] | undefined) => ObserverPaths;
  createLogger?: (options: CreateJsonlLoggerOptions) => JsonlLogger;
  stdoutWrite?: (value: string) => void;
  stderrWrite?: (value: string) => void;
  exit?: (code: number) => void;
  setExitCode?: (code: number) => void;
};

export type CliProcessDiagnosticContext = {
  stateDir: string;
  tracing: boolean;
  invocationId: string;
  startedAt: Date;
  route: readonly string[];
  argumentCount: number;
  hasStdin: boolean;
  callerClaims: {
    tmux: boolean;
    tmuxPane: boolean;
  };
  buildVersion?: string;
};

export type CliProcessDiagnosticOutcome = {
  exitCode: number;
  correlation?: CliRunCorrelation;
  error?: unknown;
  observerStartupFailure?: boolean;
};

export type CliProcessDiagnostics = {
  start(): void;
  outcome(input: CliProcessDiagnosticOutcome): Promise<void>;
};

const MAX_BUILD_VERSION_LENGTH = 160;
const MAX_ERROR_ID_LENGTH = 96;

/**
 * ADAPTER
 *
 * Projects one CLI process onto an allowlisted, redacted JSONL diagnostic sink. Its records are
 * non-authoritative and best-effort: logger failure never gates command effects, output, or exit
 * status, and configured-sink failure never redirects evidence to another state directory.
 */
export function createCliProcessDiagnostics(
  context: CliProcessDiagnosticContext,
  deps: Pick<CliProcessDeps, "clock" | "createLogger"> = {},
): CliProcessDiagnostics {
  const clock = deps.clock ?? { now: () => new Date() };
  let logger: JsonlLogger | undefined;
  let loggerUnavailable = false;
  let startWrite: Promise<void> | undefined;
  let finished = false;

  function resolveLogger(): JsonlLogger | undefined {
    if (logger !== undefined || loggerUnavailable) return logger;
    try {
      logger = (deps.createLogger ?? createJsonlLogger)({
        component: "cli",
        path: componentLogPath(context.stateDir, "cli"),
        clock,
      });
      return logger;
    } catch {
      loggerUnavailable = true;
      return undefined;
    }
  }

  function write(record: Parameters<JsonlLogger["log"]>[0]): Promise<void> {
    const sink = resolveLogger();
    if (sink === undefined) return Promise.resolve();
    try {
      return Promise.resolve(sink.log(record)).then(
        () => undefined,
        () => undefined,
      );
    } catch {
      return Promise.resolve();
    }
  }

  function start(): void {
    if (!context.tracing || startWrite !== undefined) return;
    startWrite = write({
      timestamp: context.startedAt.toISOString(),
      level: "debug",
      message: "cli.process.trace.start",
      attributes: sharedAttributes(context),
    });
  }

  async function persistOutcome(input: CliProcessDiagnosticOutcome): Promise<void> {
    if (finished) return;
    finished = true;

    if (startWrite !== undefined) await startWrite;

    const correlation = diagnosticCorrelation(input);
    const durationMs = Math.max(0, clock.now().getTime() - context.startedAt.getTime());
    if (context.tracing) {
      const failed = input.exitCode !== 0;
      const attributes = outcomeAttributes(context, input.exitCode, durationMs);
      if (failed) attributes.error = diagnosticError(input.error, input.correlation);
      await write({
        level: failed ? "error" : "debug",
        message: "cli.process.trace.outcome",
        ...correlation,
        attributes,
      });
      return;
    }

    if (input.correlation?.status === "rejected") {
      const attributes = outcomeAttributes(context, input.exitCode, durationMs);
      attributes.error = diagnosticError(undefined, input.correlation);
      await write({
        level: "error",
        message: "cli.command.rejected",
        ...correlation,
        attributes,
      });
      return;
    }

    if (input.error === undefined || input.observerStartupFailure === true) return;
    const attributes = outcomeAttributes(context, input.exitCode, durationMs);
    attributes.error = diagnosticError(input.error, input.correlation);
    await write({
      level: "error",
      message: "cli.process.failure",
      ...correlation,
      attributes,
    });
  }

  async function outcome(input: CliProcessDiagnosticOutcome): Promise<void> {
    try {
      await persistOutcome(input);
    } catch {
      // Diagnostics are never part of command completion or process exit semantics.
    }
  }

  return { start, outcome };
}

function sharedAttributes(context: CliProcessDiagnosticContext): Record<string, unknown> {
  const attributes: Record<string, unknown> = {
    invocationId: context.invocationId,
    route: [...context.route],
    argumentCount: context.argumentCount,
    hasStdin: context.hasStdin,
    tmux: context.callerClaims.tmux,
    tmuxPane: context.callerClaims.tmuxPane,
  };
  if (context.buildVersion !== undefined) {
    attributes.buildVersion = context.buildVersion.slice(0, MAX_BUILD_VERSION_LENGTH);
  }
  return attributes;
}

function outcomeAttributes(
  context: CliProcessDiagnosticContext,
  exitCode: number,
  durationMs: number,
): Record<string, unknown> {
  return {
    ...sharedAttributes(context),
    durationMs,
    exitCode,
  };
}

function diagnosticCorrelation(
  input: CliProcessDiagnosticOutcome,
): Pick<LogRecord, "commandId" | "traceId"> {
  const result: Pick<LogRecord, "commandId" | "traceId"> = {};
  const safeError =
    input.error === undefined
      ? undefined
      : safeErrorFromUnknown(input.error, {
          tag: "CliProcessError",
          code: "CLI_PROCESS_FAILURE",
          message: "CLI process failed.",
        });
  const commandId = input.correlation?.commandId ?? safeError?.commandId;
  const traceId = input.correlation?.traceId ?? safeError?.traceId;
  if (commandId !== undefined) result.commandId = commandId;
  if (traceId !== undefined) result.traceId = traceId;
  return result;
}

function diagnosticError(
  error: unknown,
  correlation: CliRunCorrelation | undefined,
): Record<string, string> {
  if (error === undefined && correlation?.status === "rejected") {
    return {
      tag: "CommandRejectedError",
      code: "COMMAND_REJECTED",
      message: "Observer rejected the CLI command.",
    };
  }
  if (error === undefined && correlation?.status === "failed") {
    return {
      tag: "CommandOutcomeError",
      code: "COMMAND_FAILED",
      message: "Observer command completed with failure.",
    };
  }
  const safeError = safeErrorFromUnknown(error, {
    tag: "CliProcessError",
    code: "CLI_PROCESS_FAILURE",
    message: "CLI process failed.",
  });
  return {
    tag: boundedErrorIdentifier(safeError.tag, "CliProcessError"),
    code: boundedErrorIdentifier(safeError.code, "CLI_PROCESS_FAILURE"),
    message: "CLI process failed.",
  };
}

function boundedErrorIdentifier(value: string, fallback: string): string {
  const bounded = value.slice(0, MAX_ERROR_ID_LENGTH).replaceAll(/[^a-zA-Z0-9_.-]/g, "_");
  return bounded.length === 0 ? fallback : bounded;
}
