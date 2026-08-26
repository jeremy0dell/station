import type { AcceptedCommandReceipt, SafeError } from "@station/contracts";
import type { ObserverProcessDeps } from "../../observerProcess.js";
import { executeTypedObserverCommand, type TypedObserverCommandOptions } from "../command.js";
import { loadObserverSnapshot, type ObserverSnapshotLoadOptions } from "../snapshot.js";
import { parseSessionArgs } from "./args.js";
import { loadCloseSessionConvergence, loadRenameSessionConvergence } from "./convergence.js";
import { runCurrentSessionCommand } from "./current.js";
import type { SessionCommandOptions } from "./options.js";
import type { SessionCommandResult } from "./result.js";
import { filterSessionSummaries, findSessionSummary, summarizeSessions } from "./summary.js";

/**
 * ADAPTER
 *
 * Collects provider-bound current-session evidence, projects exact sessions from one current
 * snapshot, and translates exact rename or close CLI intent into recorded typed commands.
 * Current-session collection remains independent of provider-specific claim keys.
 */
export async function runSessionCommand(
  args: string[],
  options: SessionCommandOptions = {},
  deps: ObserverProcessDeps = {},
): Promise<SessionCommandResult> {
  const parsed = parseSessionArgs(args);
  if (parsed.action === "current") {
    return { action: "current", context: await runCurrentSessionCommand(options, deps) };
  }

  if (parsed.action === "list") {
    const snapshot = await loadObserverSnapshot(
      snapshotLoadOptions(options, parsed.requireRunning),
      deps,
    );
    return {
      action: "list",
      filters: parsed.filters,
      sessions: filterSessionSummaries(summarizeSessions(snapshot), parsed.filters),
    };
  }

  if (parsed.action === "get") {
    const snapshot = await loadObserverSnapshot(
      snapshotLoadOptions(options, parsed.requireRunning),
      deps,
    );
    return {
      action: "get",
      session: findSessionSummary(snapshot, parsed.sessionId),
    };
  }

  const timeoutMs = parsed.timeoutMs ?? options.timeoutMs ?? 30_000;
  const snapshot = await loadObserverSnapshot(snapshotLoadOptions(options, false, timeoutMs), deps);
  if (parsed.action === "rename") {
    const target = findSessionSummary(snapshot, parsed.command.payload.sessionId);
    const outcome = await executeTypedObserverCommand(
      parsed.command,
      mutationExecutionOptions(options, timeoutMs),
      deps,
    );
    if (outcome.status === "accepted") {
      throw missingSessionCompletionError(outcome.receipt);
    }
    if (outcome.status !== "succeeded") {
      return { action: "rename", target, outcome };
    }
    return {
      action: "rename",
      target,
      outcome,
      convergence: await loadRenameSessionConvergence(
        target,
        parsed.command.payload.title,
        snapshotLoadOptions(options, false, timeoutMs),
        deps,
      ),
    };
  }

  const target = findSessionSummary(snapshot, parsed.command.payload.sessionId);
  const outcome = await executeTypedObserverCommand(
    parsed.command,
    mutationExecutionOptions(options, timeoutMs),
    deps,
  );
  if (outcome.status === "accepted") {
    throw missingSessionCompletionError(outcome.receipt);
  }
  if (outcome.status !== "succeeded") {
    return { action: "close", target, outcome };
  }
  return {
    action: "close",
    target,
    outcome,
    convergence: await loadCloseSessionConvergence(
      target,
      snapshotLoadOptions(options, false, timeoutMs),
      deps,
    ),
  };
}

function snapshotLoadOptions(
  options: SessionCommandOptions,
  requireRunning: boolean,
  timeoutMs = options.timeoutMs,
): ObserverSnapshotLoadOptions {
  const loadOptions: ObserverSnapshotLoadOptions = { requireRunning };
  if (options.config !== undefined) loadOptions.config = options.config;
  if (options.configPath !== undefined) loadOptions.configPath = options.configPath;
  if (timeoutMs !== undefined) loadOptions.timeoutMs = timeoutMs;
  return loadOptions;
}

function mutationExecutionOptions(
  options: SessionCommandOptions,
  timeoutMs: number,
): TypedObserverCommandOptions {
  const executionOptions: TypedObserverCommandOptions = {
    timeoutMs,
    waitForCompletion: true,
  };
  if (options.config !== undefined) executionOptions.config = options.config;
  if (options.configPath !== undefined) executionOptions.configPath = options.configPath;
  return executionOptions;
}

function missingSessionCompletionError(receipt: AcceptedCommandReceipt): SafeError {
  const error: SafeError = {
    tag: "SessionCliError",
    code: "SESSION_COMMAND_COMPLETION_MISSING",
    message: "The session command returned before its durable completion was available.",
    commandId: receipt.commandId,
  };
  if (receipt.traceId !== undefined) error.traceId = receipt.traceId;
  return error;
}

export type {
  CloseSessionConvergence,
  RenameSessionConvergence,
  SessionProjectionState,
  SessionWorktreeProjectionState,
} from "./convergence.js";
export type { SessionCommandDeps, SessionCommandOptions } from "./options.js";
export { type SessionCommandResult, sessionCommandExitCode } from "./result.js";
export type { SessionFilters, SessionSummary, SessionWorktreeSummary } from "./summary.js";
export { renderSessionCommandText } from "./text.js";
