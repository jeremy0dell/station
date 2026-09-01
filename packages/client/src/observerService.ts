import type {
  AgentPrepareExternalLaunchParams,
  AgentPrepareExternalLaunchResult,
  AgentReportExternalExitParams,
  AgentReportExternalExitResult,
  CommandId,
  ObserverApi,
  StationCommand,
  StationEvent,
  StationSnapshot,
  WorktreeCancelRemovalParams,
  WorktreeCancelRemovalResult,
  WorktreePrepareRemovalParams,
  WorktreePrepareRemovalResult,
} from "@station/contracts";
import {
  createObserverClient,
  type NdjsonTransportDiagnostics,
  type ObserverClient,
} from "@station/protocol";
import {
  type RuntimeBoundaryTask,
  type RuntimeSafeErrorFallback,
  runRuntimeBoundaryWithRetryAndTimeout,
  runRuntimeBoundaryWithTimeout,
} from "@station/runtime";
import { completionFromTerminalRecord, mapCommandWaitError } from "./commandLifecycle.js";
import { observerErrorFallback, timeoutErrorFallback } from "./errors.js";
import type { ObserverService, StationClientCommandCompletion } from "./types.js";

export type CreateObserverServiceOptions = {
  socketPath?: string;
  /** Exact Observer selector accepted before this service began issuing operations. */
  expectedBuildVersion?: string;
  timeoutMs?: number;
  reconcileTimeoutMs?: number;
  /** Budget for host negotiation and process preparation. */
  prepareExternalLaunchTimeoutMs?: number;
  commandWaitTimeoutMs?: number;
  clientLabel?: string;
  requestId?: () => string;
  client?: ObserverClient;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_RECONCILE_TIMEOUT_MS = 30_000;
const DEFAULT_PREPARE_EXTERNAL_LAUNCH_TIMEOUT_MS = 30_000;
const DEFAULT_COMMAND_WAIT_TIMEOUT_MS = 35_000;

/**
 * ADAPTER
 *
 * Presents one build-pinned Observer protocol endpoint as the shared client
 * service, preserves durable command results loaded at terminal completion,
 * and aggregates content-free metrics across discarded physical connections.
 */
export function createObserverService(options: CreateObserverServiceOptions): ObserverService {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const reconcileTimeoutMs =
    options.reconcileTimeoutMs ?? options.timeoutMs ?? DEFAULT_RECONCILE_TIMEOUT_MS;
  const prepareExternalLaunchTimeoutMs =
    options.prepareExternalLaunchTimeoutMs ?? DEFAULT_PREPARE_EXTERNAL_LAUNCH_TIMEOUT_MS;
  const commandWaitTimeoutMs = options.commandWaitTimeoutMs ?? DEFAULT_COMMAND_WAIT_TIMEOUT_MS;
  let transportDiagnostics = emptyTransportDiagnostics();
  const recordConnectionDiagnostics = (diagnostics: NdjsonTransportDiagnostics) => {
    transportDiagnostics = mergeTransportDiagnostics(transportDiagnostics, diagnostics);
  };
  const client = options.client ?? createClient(options, timeoutMs, recordConnectionDiagnostics);
  const reconcileClient =
    options.client ?? createClient(options, reconcileTimeoutMs, recordConnectionDiagnostics);
  const prepareExternalLaunchClient =
    options.client ??
    createClient(options, prepareExternalLaunchTimeoutMs, recordConnectionDiagnostics);
  const copy = createObserverServiceCopy(options.clientLabel);

  return {
    diagnostics: () => ({ ...transportDiagnostics }),
    loadSnapshot: () => loadSnapshot(client, timeoutMs, copy),
    subscribeEvents: () => wrapSubscription(client.subscribe()),
    dispatch: (command: StationCommand) => dispatchCommand(client, command, timeoutMs, copy),
    waitForCommandCompletion: (commandId: CommandId) =>
      waitForCommandCompletion(client, commandId, commandWaitTimeoutMs, copy),
    reconcile: (reason?: string) =>
      requestReconcile(reconcileClient, reason, reconcileTimeoutMs, copy),
    prepareExternalLaunch: (params: AgentPrepareExternalLaunchParams) =>
      prepareExternalLaunch(
        prepareExternalLaunchClient,
        params,
        prepareExternalLaunchTimeoutMs,
        copy,
      ),
    reportExternalExit: (params: AgentReportExternalExitParams) =>
      reportExternalExit(client, params, timeoutMs, copy),
    prepareWorktreeRemoval: (params: WorktreePrepareRemovalParams) =>
      prepareWorktreeRemoval(client, params, timeoutMs, copy),
    cancelWorktreeRemoval: (params: WorktreeCancelRemovalParams) =>
      cancelWorktreeRemoval(client, params, timeoutMs, copy),
  };
}

type ObserverServiceCopy = {
  snapshotFailed: string;
  snapshotTimeout: string;
  commandFailed: string;
  commandTimeout: string;
  commandWaitFailed: string;
  commandWaitTimeout: string;
  reconcileFailed: string;
  reconcileTimeout: string;
  prepareExternalLaunchFailed: string;
  prepareExternalLaunchTimeout: string;
  reportExternalExitFailed: string;
  reportExternalExitTimeout: string;
  prepareWorktreeRemovalFailed: string;
  prepareWorktreeRemovalTimeout: string;
  cancelWorktreeRemovalFailed: string;
  cancelWorktreeRemovalTimeout: string;
};

function createObserverServiceCopy(clientLabel: string | undefined): ObserverServiceCopy {
  const subject =
    clientLabel === undefined || clientLabel.length === 0 ? "The client" : `The ${clientLabel}`;
  return {
    snapshotFailed: `${subject} could not load the observer snapshot.`,
    snapshotTimeout: `${subject} timed out while loading the observer snapshot.`,
    commandFailed: `${subject} could not dispatch the command.`,
    commandTimeout: `${subject} timed out while dispatching the command.`,
    commandWaitFailed: `${subject} could not observe command completion.`,
    commandWaitTimeout: `${subject} timed out while waiting for command completion.`,
    reconcileFailed: `${subject} could not request observer reconciliation.`,
    reconcileTimeout: `${subject} timed out while reconciling observer state.`,
    prepareExternalLaunchFailed: `${subject} could not prepare the external agent launch.`,
    prepareExternalLaunchTimeout: `${subject} timed out while preparing the external agent launch.`,
    reportExternalExitFailed: `${subject} could not report the external agent exit.`,
    reportExternalExitTimeout: `${subject} timed out while reporting the external agent exit.`,
    prepareWorktreeRemovalFailed: `${subject} could not prepare worktree removal.`,
    prepareWorktreeRemovalTimeout: `${subject} timed out while preparing worktree removal.`,
    cancelWorktreeRemovalFailed: `${subject} could not cancel worktree removal.`,
    cancelWorktreeRemovalTimeout: `${subject} timed out while cancelling worktree removal.`,
  };
}

async function loadSnapshot(
  client: ObserverApi,
  timeoutMs: number,
  copy: ObserverServiceCopy,
): Promise<StationSnapshot> {
  const result = await runRuntimeBoundaryWithRetryAndTimeout(
    {
      operation: "client.observer.snapshot.get",
      timeoutMs,
      error: observerErrorFallback("CLIENT_SNAPSHOT_FAILED", copy.snapshotFailed),
      timeoutError: timeoutErrorFallback("CLIENT_SNAPSHOT_TIMEOUT", copy.snapshotTimeout),
      retry: {
        retries: 0,
      },
    },
    () => client.getSnapshot(),
  );
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

async function dispatchCommand(
  client: ObserverApi,
  command: StationCommand,
  timeoutMs: number,
  copy: ObserverServiceCopy,
): ReturnType<ObserverService["dispatch"]> {
  return runClientRequest(
    {
      operation: `client.observer.command.${command.type}`,
      timeoutMs,
      error: observerErrorFallback("CLIENT_COMMAND_FAILED", copy.commandFailed),
      timeoutError: timeoutErrorFallback("CLIENT_COMMAND_TIMEOUT", copy.commandTimeout),
    },
    () => client.dispatch(command),
  );
}

async function waitForCommandCompletion(
  client: ObserverClient,
  commandId: CommandId,
  timeoutMs: number,
  copy: ObserverServiceCopy,
): Promise<StationClientCommandCompletion> {
  return runClientRequest(
    {
      operation: "client.observer.command.wait",
      timeoutMs,
      error: observerErrorFallback("CLIENT_COMMAND_WAIT_FAILED", copy.commandWaitFailed),
      timeoutError: timeoutErrorFallback("CLIENT_COMMAND_WAIT_TIMEOUT", copy.commandWaitTimeout),
    },
    () => waitForCommandTerminalRecord(client, commandId, timeoutMs, copy),
  );
}

async function requestReconcile(
  client: ObserverApi,
  reason: string | undefined,
  timeoutMs: number,
  copy: ObserverServiceCopy,
): Promise<StationSnapshot> {
  const receipt = await runClientRequest(
    {
      operation: "client.observer.reconcile",
      timeoutMs,
      error: observerErrorFallback("CLIENT_RECONCILE_FAILED", copy.reconcileFailed),
      timeoutError: timeoutErrorFallback("CLIENT_RECONCILE_TIMEOUT", copy.reconcileTimeout),
    },
    () => client.reconcile(reason),
  );
  return receipt.snapshot;
}

async function prepareExternalLaunch(
  client: ObserverApi,
  params: AgentPrepareExternalLaunchParams,
  timeoutMs: number,
  copy: ObserverServiceCopy,
): Promise<AgentPrepareExternalLaunchResult> {
  return runClientRequest(
    {
      operation: "client.observer.agent.prepareExternalLaunch",
      timeoutMs,
      error: observerErrorFallback(
        "CLIENT_PREPARE_EXTERNAL_LAUNCH_FAILED",
        copy.prepareExternalLaunchFailed,
      ),
      timeoutError: timeoutErrorFallback(
        "CLIENT_PREPARE_EXTERNAL_LAUNCH_TIMEOUT",
        copy.prepareExternalLaunchTimeout,
      ),
    },
    () => client.prepareExternalLaunch(params),
  );
}

async function reportExternalExit(
  client: ObserverApi,
  params: AgentReportExternalExitParams,
  timeoutMs: number,
  copy: ObserverServiceCopy,
): Promise<AgentReportExternalExitResult> {
  return runClientRequest(
    {
      operation: "client.observer.agent.reportExternalExit",
      timeoutMs,
      error: observerErrorFallback(
        "CLIENT_REPORT_EXTERNAL_EXIT_FAILED",
        copy.reportExternalExitFailed,
      ),
      timeoutError: timeoutErrorFallback(
        "CLIENT_REPORT_EXTERNAL_EXIT_TIMEOUT",
        copy.reportExternalExitTimeout,
      ),
    },
    () => client.reportExternalExit(params),
  );
}

async function prepareWorktreeRemoval(
  client: ObserverApi,
  params: WorktreePrepareRemovalParams,
  timeoutMs: number,
  copy: ObserverServiceCopy,
): Promise<WorktreePrepareRemovalResult> {
  return runClientRequest(
    {
      operation: "client.observer.worktree.prepareRemoval",
      timeoutMs,
      error: observerErrorFallback(
        "CLIENT_PREPARE_WORKTREE_REMOVAL_FAILED",
        copy.prepareWorktreeRemovalFailed,
      ),
      timeoutError: timeoutErrorFallback(
        "CLIENT_PREPARE_WORKTREE_REMOVAL_TIMEOUT",
        copy.prepareWorktreeRemovalTimeout,
      ),
    },
    () => client.prepareWorktreeRemoval(params),
  );
}

async function cancelWorktreeRemoval(
  client: ObserverApi,
  params: WorktreeCancelRemovalParams,
  timeoutMs: number,
  copy: ObserverServiceCopy,
): Promise<WorktreeCancelRemovalResult> {
  return runClientRequest(
    {
      operation: "client.observer.worktree.cancelRemoval",
      timeoutMs,
      error: observerErrorFallback(
        "CLIENT_CANCEL_WORKTREE_REMOVAL_FAILED",
        copy.cancelWorktreeRemovalFailed,
      ),
      timeoutError: timeoutErrorFallback(
        "CLIENT_CANCEL_WORKTREE_REMOVAL_TIMEOUT",
        copy.cancelWorktreeRemovalTimeout,
      ),
    },
    () => client.cancelWorktreeRemoval(params),
  );
}

async function runClientRequest<T>(
  input: {
    operation: string;
    timeoutMs: number;
    error: RuntimeSafeErrorFallback;
    timeoutError: RuntimeSafeErrorFallback;
  },
  task: RuntimeBoundaryTask<T>,
): Promise<T> {
  const result = await runRuntimeBoundaryWithTimeout(input, task);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

async function waitForCommandTerminalRecord(
  client: ObserverClient,
  commandId: CommandId,
  timeoutMs: number,
  copy: ObserverServiceCopy,
): Promise<StationClientCommandCompletion> {
  try {
    const record = await client.waitForCommand(commandId, { timeoutMs });
    return completionFromTerminalRecord(record);
  } catch (error) {
    throw mapCommandWaitError(error, {
      failed: copy.commandWaitFailed,
      timeout: copy.commandWaitTimeout,
    });
  }
}

function createClient(
  options: CreateObserverServiceOptions,
  timeoutMs: number,
  onConnectionDiagnostics: (diagnostics: NdjsonTransportDiagnostics) => void,
): ObserverClient {
  if (options.socketPath === undefined) {
    throw new Error("createObserverService requires socketPath or client.");
  }
  return createObserverClient({
    socketPath: options.socketPath,
    timeoutMs,
    ...(options.expectedBuildVersion === undefined
      ? {}
      : { expectedBuildVersion: options.expectedBuildVersion }),
    ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
    onConnectionDiagnostics,
  });
}

function emptyTransportDiagnostics(): NdjsonTransportDiagnostics {
  return {
    inboundQueueDepth: 0,
    inboundQueueBytes: 0,
    inboundHighWaterDepth: 0,
    inboundHighWaterBytes: 0,
    outboundBackpressureCount: 0,
    overflowCount: 0,
    closeCount: 0,
  };
}

function mergeTransportDiagnostics(
  aggregate: NdjsonTransportDiagnostics,
  connection: NdjsonTransportDiagnostics,
): NdjsonTransportDiagnostics {
  const merged: NdjsonTransportDiagnostics = {
    inboundQueueDepth: connection.inboundQueueDepth,
    inboundQueueBytes: connection.inboundQueueBytes,
    inboundHighWaterDepth: Math.max(
      aggregate.inboundHighWaterDepth,
      connection.inboundHighWaterDepth,
    ),
    inboundHighWaterBytes: Math.max(
      aggregate.inboundHighWaterBytes,
      connection.inboundHighWaterBytes,
    ),
    outboundBackpressureCount:
      aggregate.outboundBackpressureCount + connection.outboundBackpressureCount,
    overflowCount: aggregate.overflowCount + connection.overflowCount,
    closeCount: aggregate.closeCount + connection.closeCount,
  };
  if (connection.lastOverflowReason !== undefined) {
    merged.lastOverflowReason = connection.lastOverflowReason;
  } else if (aggregate.lastOverflowReason !== undefined) {
    merged.lastOverflowReason = aggregate.lastOverflowReason;
  }
  return merged;
}

function wrapSubscription(events: AsyncIterable<StationEvent>): AsyncIterable<StationEvent> {
  return {
    [Symbol.asyncIterator]: () => {
      const iterator = events[Symbol.asyncIterator]();
      return {
        next: () => iterator.next(),
        return: async () => {
          await iterator.return?.();
          return { done: true, value: undefined };
        },
      };
    },
  };
}
