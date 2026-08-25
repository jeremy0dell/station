import type { StationConfig } from "@station/config";
import type {
  AcceptedCommandReceipt,
  AgentState,
  CommandExecutionOutcome,
  CurrentSessionContext,
  ProjectId,
  ProviderId,
  SafeError,
  SessionId,
  StationCommand,
  TerminalCallerContextRequest,
} from "@station/contracts";
import {
  AgentStateSchema,
  CloseSessionCommandSchema,
  ProjectIdSchema,
  ProviderIdSchema,
  RenameSessionCommandSchema,
  SessionIdSchema,
  SessionOriginSchema,
} from "@station/contracts";
import { createObserverClient } from "@station/protocol";
import {
  createLocalProcessEvidence,
  type ProcessEvidence,
  publicSafeErrorFromUnknown,
  runRuntimeBoundaryWithTimeout,
} from "@station/runtime";
import { parsePositiveIntegerOption, parseRequiredOptionValue } from "../args.js";
import {
  type ObserverProcessDeps,
  type ObserverStatus,
  observerStatusErrorMessage,
  startObserver,
} from "../observerProcess.js";
import { resolveObserverPaths } from "../paths.js";
import { executeTypedObserverCommand, type TypedObserverCommandOptions } from "./command.js";
import {
  filterSessionSummaries,
  findOptionalSessionSummary,
  findSessionSummary,
  findSessionWorktreeSummary,
  type SessionFilters,
  type SessionSummary,
  type SessionWorktreeSummary,
  summarizeSessions,
} from "./sessionSummary.js";
import { loadObserverSnapshot, type ObserverSnapshotLoadOptions } from "./snapshot.js";

export type SessionCommandOptions = {
  config?: StationConfig;
  configPath?: string;
  timeoutMs?: number;
  caller?: () => TerminalCallerContextRequest;
  processEvidence?: ProcessEvidence;
  environment?: Readonly<Record<string, string | undefined>>;
  captureCallerClaims?: (
    environment: Readonly<Record<string, string | undefined>>,
  ) => Record<string, string>;
};

export type SessionCommandDeps = Pick<
  SessionCommandOptions,
  "caller" | "captureCallerClaims" | "environment" | "processEvidence"
>;

type RenameSessionCommand = Extract<StationCommand, { type: "session.rename" }>;
type CloseSessionCommand = Extract<StationCommand, { type: "session.close" }>;
type SessionMutationCommand = RenameSessionCommand | CloseSessionCommand;
type TerminalCommandOutcome<TCommand extends SessionMutationCommand> = Exclude<
  CommandExecutionOutcome<TCommand>,
  { status: "accepted" }
>;

export type SessionProjectionState =
  | { state: "present"; value: SessionSummary }
  | { state: "missing" }
  | { state: "unknown" };

export type SessionWorktreeProjectionState =
  | { state: "present"; value: SessionWorktreeSummary }
  | { state: "missing" }
  | { state: "unknown" };

export type RenameSessionConvergence = {
  status: "confirmed" | "warning";
  session: SessionProjectionState;
  warning?: SafeError;
};

export type CloseSessionConvergence = {
  status: "confirmed" | "warning";
  session: SessionProjectionState;
  worktree: SessionWorktreeProjectionState;
  warning?: SafeError;
};

export type SessionCommandResult =
  | {
      action: "current";
      context: CurrentSessionContext;
    }
  | {
      action: "list";
      filters: SessionFilters;
      sessions: SessionSummary[];
    }
  | {
      action: "get";
      session: SessionSummary;
    }
  | {
      action: "rename";
      target: SessionSummary;
      outcome: TerminalCommandOutcome<RenameSessionCommand>;
      convergence?: RenameSessionConvergence;
    }
  | {
      action: "close";
      target: SessionSummary;
      outcome: TerminalCommandOutcome<CloseSessionCommand>;
      convergence?: CloseSessionConvergence;
    };

type ParsedSessionArgs =
  | { action: "current" }
  | {
      action: "list";
      filters: SessionFilters;
      requireRunning: boolean;
    }
  | {
      action: "get";
      sessionId: SessionId;
      requireRunning: boolean;
    }
  | {
      action: "rename";
      command: RenameSessionCommand;
      timeoutMs?: number;
    }
  | {
      action: "close";
      command: CloseSessionCommand;
      timeoutMs?: number;
    };

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
      convergence: await loadRenameConvergence(
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
    convergence: await loadCloseConvergence(
      target,
      snapshotLoadOptions(options, false, timeoutMs),
      deps,
    ),
  };
}

export function sessionCommandExitCode(result: SessionCommandResult): number {
  if (
    (result.action === "rename" || result.action === "close") &&
    (result.outcome.status === "rejected" || result.outcome.status === "failed")
  ) {
    return 1;
  }
  return 0;
}

function parseSessionArgs(args: string[]): ParsedSessionArgs {
  const action = args[0];
  if (action === undefined) {
    throw new Error("Session command requires a subcommand. Use: stn session --help.");
  }
  if (action === "current") return parseCurrentArgs(args.slice(1));
  if (action === "list") return parseListArgs(args.slice(1));
  if (action === "get") return parseGetArgs(args.slice(1));
  if (action === "rename") return parseRenameArgs(args.slice(1));
  if (action === "close") return parseCloseArgs(args.slice(1));
  throw new Error(`Unknown session command: ${action}. Use: stn session --help.`);
}

function parseCurrentArgs(args: string[]): Extract<ParsedSessionArgs, { action: "current" }> {
  const unexpected = args[0];
  if (unexpected !== undefined) {
    throw new Error(
      `Unexpected argument for stn session current: ${unexpected}. Use: stn session current --help.`,
    );
  }
  return { action: "current" };
}

function parseListArgs(args: string[]): Extract<ParsedSessionArgs, { action: "list" }> {
  const filters: SessionFilters = {};
  const seen = new Set<string>();
  let requireRunning = false;

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--json") {
      claimOption(seen, option, "session list");
      continue;
    }
    if (option === "--require-running") {
      claimOption(seen, option, "session list");
      requireRunning = true;
      continue;
    }
    if (option === "--project") {
      claimOption(seen, option, "session list");
      filters.project = parseProjectId(args[index + 1], option);
      index += 1;
      continue;
    }
    if (option === "--provider") {
      claimOption(seen, option, "session list");
      filters.provider = parseProviderId(args[index + 1], option);
      index += 1;
      continue;
    }
    if (option === "--status") {
      claimOption(seen, option, "session list");
      filters.status = parseAgentState(args[index + 1], option);
      index += 1;
      continue;
    }
    if (option === "--origin") {
      claimOption(seen, option, "session list");
      filters.origin = parseSessionOrigin(args[index + 1], option);
      index += 1;
      continue;
    }
    if (option === "--query") {
      claimOption(seen, option, "session list");
      filters.query = parseSessionOptionValue(args[index + 1], option);
      index += 1;
      continue;
    }
    throw new Error(`Unknown session list option: ${option ?? ""}`);
  }
  return { action: "list", filters, requireRunning };
}

function parseGetArgs(args: string[]): Extract<ParsedSessionArgs, { action: "get" }> {
  const sessionId = parseSessionId(args[0], "session get");
  const seen = new Set<string>();
  let requireRunning = false;
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--json") {
      claimOption(seen, option, "session get");
      continue;
    }
    if (option === "--require-running") {
      claimOption(seen, option, "session get");
      requireRunning = true;
      continue;
    }
    throw new Error(`Unknown session get option: ${option ?? ""}`);
  }
  return { action: "get", sessionId, requireRunning };
}

function parseRenameArgs(args: string[]): Extract<ParsedSessionArgs, { action: "rename" }> {
  const sessionId = parseSessionId(args[0], "session rename");
  const title = args[1];
  if (title === undefined || title.startsWith("--")) {
    throw new Error("session rename requires a non-empty title.");
  }
  const seen = new Set<string>();
  let timeoutMs: number | undefined;
  for (let index = 2; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--json") {
      claimOption(seen, option, "session rename");
      continue;
    }
    if (option === "--timeout-ms") {
      claimOption(seen, option, "session rename");
      timeoutMs = parsePositiveIntegerOption(args[index + 1], option);
      index += 1;
      continue;
    }
    throw new Error(`Unknown session rename option: ${option ?? ""}`);
  }
  const command = RenameSessionCommandSchema.parse({
    type: "session.rename",
    payload: { sessionId, title },
  });
  return {
    action: "rename",
    command,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

function parseCloseArgs(args: string[]): Extract<ParsedSessionArgs, { action: "close" }> {
  const sessionId = parseSessionId(args[0], "session close");
  const seen = new Set<string>();
  let mode: "harness" | "terminal" | "all" | undefined;
  let force = false;
  let timeoutMs: number | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--json") {
      claimOption(seen, option, "session close");
      continue;
    }
    if (option === "--mode") {
      claimOption(seen, option, "session close");
      mode = parseCloseMode(args[index + 1]);
      index += 1;
      continue;
    }
    if (option === "--force") {
      claimOption(seen, option, "session close");
      force = true;
      continue;
    }
    if (option === "--timeout-ms") {
      claimOption(seen, option, "session close");
      timeoutMs = parsePositiveIntegerOption(args[index + 1], option);
      index += 1;
      continue;
    }
    throw new Error(`Unknown session close option: ${option ?? ""}`);
  }
  if (mode === undefined) {
    throw new Error("session close requires --mode <harness|terminal|all>.");
  }
  const payload: { sessionId: SessionId; mode: typeof mode; force?: true } = { sessionId, mode };
  if (force) payload.force = true;
  const command = CloseSessionCommandSchema.parse({ type: "session.close", payload });
  return {
    action: "close",
    command,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

function parseSessionId(value: string | undefined, command: string): SessionId {
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${command} requires an exact session id.`);
  }
  const parsed = SessionIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid session id: ${parsed.error.message}`);
  }
  return parsed.data;
}

function parseProjectId(value: string | undefined, option: string): ProjectId {
  const parsed = ProjectIdSchema.safeParse(parseSessionOptionValue(value, option));
  if (!parsed.success) throw new Error(`${option} requires a non-empty project id.`);
  return parsed.data;
}

function parseProviderId(value: string | undefined, option: string): ProviderId {
  const parsed = ProviderIdSchema.safeParse(parseSessionOptionValue(value, option));
  if (!parsed.success) throw new Error(`${option} requires a non-empty provider id.`);
  return parsed.data;
}

function parseAgentState(value: string | undefined, option: string): AgentState {
  const parsed = AgentStateSchema.safeParse(parseSessionOptionValue(value, option));
  if (!parsed.success) {
    throw new Error(`${option} must be a current session status.`);
  }
  return parsed.data;
}

function parseSessionOrigin(value: string | undefined, option: string): "station" | "external" {
  const parsed = SessionOriginSchema.safeParse(parseSessionOptionValue(value, option));
  if (!parsed.success) throw new Error(`${option} must be station or external.`);
  return parsed.data;
}

function parseCloseMode(value: string | undefined): "harness" | "terminal" | "all" {
  const parsed = CloseSessionCommandSchema.shape.payload.shape.mode.safeParse(
    parseSessionOptionValue(value, "--mode"),
  );
  if (!parsed.success) throw new Error("--mode must be harness, terminal, or all.");
  return parsed.data;
}

function parseSessionOptionValue(value: string | undefined, option: string): string {
  const parsed = parseRequiredOptionValue(value, option);
  if (parsed.startsWith("--")) throw new Error(`${option} requires a value.`);
  return parsed;
}

function claimOption(seen: Set<string>, option: string, command: string): void {
  if (seen.has(option)) {
    throw new Error(`Duplicate ${command} option: ${option}.`);
  }
  seen.add(option);
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

async function loadRenameConvergence(
  target: SessionSummary,
  requestedTitle: string,
  options: ObserverSnapshotLoadOptions,
  deps: ObserverProcessDeps,
): Promise<RenameSessionConvergence> {
  try {
    const snapshot = await loadObserverSnapshot(options, deps);
    const session = findOptionalSessionSummary(snapshot, target.sessionId);
    if (session === undefined) {
      return {
        status: "warning",
        session: { state: "missing" },
        warning: convergenceWarning(
          "SESSION_RENAME_CONVERGENCE_MISSING",
          "The rename command succeeded, but the refreshed snapshot no longer contains the session.",
          target,
        ),
      };
    }
    if (!renameConverged(target, session, requestedTitle)) {
      return {
        status: "warning",
        session: { state: "present", value: session },
        warning: convergenceWarning(
          "SESSION_RENAME_CONVERGENCE_STALE",
          "The rename command succeeded, but the refreshed snapshot did not preserve the expected identity and title.",
          target,
        ),
      };
    }
    return {
      status: "confirmed",
      session: { state: "present", value: session },
    };
  } catch (error) {
    return {
      status: "warning",
      session: { state: "unknown" },
      warning: convergenceRefreshWarning(error, "rename", target),
    };
  }
}

async function loadCloseConvergence(
  target: SessionSummary,
  options: ObserverSnapshotLoadOptions,
  deps: ObserverProcessDeps,
): Promise<CloseSessionConvergence> {
  try {
    const snapshot = await loadObserverSnapshot(options, deps);
    const worktree = findSessionWorktreeSummary(snapshot, target);
    if (worktree === undefined) {
      return {
        status: "warning",
        session: { state: "unknown" },
        worktree: { state: "missing" },
        warning: convergenceWarning(
          "SESSION_CLOSE_WORKTREE_MISSING",
          "The close command succeeded, but the refreshed snapshot no longer contains its worktree.",
          target,
        ),
      };
    }
    const session = findOptionalSessionSummary(snapshot, target.sessionId);
    const sessionState: SessionProjectionState =
      session === undefined ? { state: "missing" } : { state: "present", value: session };
    if (!worktreeRetained(target, worktree)) {
      return {
        status: "warning",
        session: sessionState,
        worktree: { state: "present", value: worktree },
        warning: convergenceWarning(
          "SESSION_CLOSE_WORKTREE_CHANGED",
          "The close command succeeded, but the refreshed worktree identity changed unexpectedly.",
          target,
        ),
      };
    }
    return {
      status: "confirmed",
      session: sessionState,
      worktree: { state: "present", value: worktree },
    };
  } catch (error) {
    return {
      status: "warning",
      session: { state: "unknown" },
      worktree: { state: "unknown" },
      warning: convergenceRefreshWarning(error, "close", target),
    };
  }
}

function renameConverged(
  target: SessionSummary,
  refreshed: SessionSummary,
  requestedTitle: string,
): boolean {
  return (
    refreshed.sessionId === target.sessionId &&
    refreshed.projectId === target.projectId &&
    refreshed.worktreeId === target.worktreeId &&
    refreshed.title === requestedTitle &&
    refreshed.worktreeTitle === requestedTitle &&
    refreshed.branch === target.branch &&
    refreshed.path === target.path &&
    refreshed.harness.provider === target.harness.provider &&
    refreshed.harness.mode === target.harness.mode &&
    refreshed.harness.runId === target.harness.runId
  );
}

function worktreeRetained(target: SessionSummary, refreshed: SessionWorktreeSummary): boolean {
  return (
    refreshed.projectId === target.projectId &&
    refreshed.worktreeId === target.worktreeId &&
    refreshed.title === target.worktreeTitle &&
    refreshed.branch === target.branch &&
    refreshed.path === target.path
  );
}

function convergenceRefreshWarning(
  error: unknown,
  action: "rename" | "close",
  target: SessionSummary,
): SafeError {
  const normalized = publicSafeErrorFromUnknown(error, {
    tag: "SessionCliError",
    code: `SESSION_${action.toUpperCase()}_CONVERGENCE_REFRESH_FAILED`,
    message: `The ${action} command succeeded, but Station could not load the refreshed snapshot.`,
  });
  const warning: SafeError = { ...normalized };
  if (warning.sessionId === undefined) warning.sessionId = target.sessionId;
  if (warning.projectId === undefined) warning.projectId = target.projectId;
  if (warning.worktreeId === undefined) warning.worktreeId = target.worktreeId;
  return warning;
}

function convergenceWarning(code: string, message: string, target: SessionSummary): SafeError {
  return {
    tag: "SessionCliError",
    code,
    message,
    hint: "Inspect `stn session get <sessionId> --json` or `stn snapshot --json` before another mutation.",
    sessionId: target.sessionId,
    projectId: target.projectId,
    worktreeId: target.worktreeId,
  };
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

async function runCurrentSessionCommand(
  options: SessionCommandOptions,
  deps: ObserverProcessDeps,
): Promise<CurrentSessionContext> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const paths = resolveObserverPaths(options.config);
  const status = await startObserver({ ...options, paths, timeoutMs }, deps);
  assertRunning(status);
  const client =
    deps.clientFactory?.(paths.socketPath) ??
    createObserverClient({
      socketPath: paths.socketPath,
      timeoutMs,
      ...(status.health.version === undefined
        ? {}
        : { expectedBuildVersion: status.health.version }),
    });
  const result = await runRuntimeBoundaryWithTimeout(
    {
      operation: "cli.session.current",
      timeoutMs,
      error: {
        tag: "SessionCommandError",
        code: "SESSION_CURRENT_RPC_FAILED",
        message: "Session current could not contact the Observer.",
      },
      timeoutError: {
        tag: "TimeoutError",
        code: "SESSION_CURRENT_RPC_TIMEOUT",
        message: "Session current timed out while contacting the Observer.",
      },
    },
    () =>
      client.getCurrentSessionContext(
        options.caller?.() ??
          currentCaller(options.processEvidence, options.environment, options.captureCallerClaims),
      ),
  );
  if (!result.ok) throw result.error;
  return result.value;
}

function currentCaller(
  processEvidence: ProcessEvidence = createLocalProcessEvidence(),
  environment: Readonly<Record<string, string | undefined>> = process.env,
  captureCallerClaims: (
    environment: Readonly<Record<string, string | undefined>>,
  ) => Record<string, string> = () => ({}),
): TerminalCallerContextRequest {
  const processIdentity = processEvidence.read(process.pid);
  if (processIdentity === undefined) {
    throw {
      tag: "SessionCommandError",
      code: "SESSION_CURRENT_PROCESS_EVIDENCE_UNAVAILABLE",
      message: "STATION could not verify the invoking process identity.",
    };
  }
  return {
    process: { pid: processIdentity.pid, startToken: processIdentity.startToken },
    claims: captureCallerClaims(environment),
  };
}

function assertRunning(
  status: ObserverStatus,
): asserts status is Extract<ObserverStatus, { status: "running" }> {
  if (status.status !== "running") throw new Error(observerStatusErrorMessage(status));
}
