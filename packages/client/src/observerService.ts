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
} from "@station/contracts";
import { createObserverClient, type ObserverClient } from "@station/protocol";
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
  timeoutMs?: number;
  reconcileTimeoutMs?: number;
  commandWaitTimeoutMs?: number;
  clientLabel?: string;
  requestId?: () => string;
  client?: ObserverClient;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_RECONCILE_TIMEOUT_MS = 30_000;
const DEFAULT_COMMAND_WAIT_TIMEOUT_MS = 35_000;

export function createObserverService(options: CreateObserverServiceOptions): ObserverService {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const reconcileTimeoutMs =
    options.reconcileTimeoutMs ?? options.timeoutMs ?? DEFAULT_RECONCILE_TIMEOUT_MS;
  const commandWaitTimeoutMs = options.commandWaitTimeoutMs ?? DEFAULT_COMMAND_WAIT_TIMEOUT_MS;
  const client = options.client ?? createClient(options, timeoutMs);
  const reconcileClient = options.client ?? createClient(options, reconcileTimeoutMs);
  const copy = createObserverServiceCopy(options.clientLabel);

  return {
    loadSnapshot: () => loadSnapshot(client, timeoutMs, copy),
    subscribeEvents: () => wrapSubscription(client.subscribe()),
    dispatch: (command: StationCommand) => dispatchCommand(client, command, timeoutMs, copy),
    waitForCommandCompletion: (commandId: CommandId) =>
      waitForCommandCompletion(client, commandId, commandWaitTimeoutMs, copy),
    reconcile: (reason?: string) =>
      requestReconcile(reconcileClient, reason, reconcileTimeoutMs, copy),
    prepareExternalLaunch: (params: AgentPrepareExternalLaunchParams) =>
      prepareExternalLaunch(client, params, timeoutMs, copy),
    reportExternalExit: (params: AgentReportExternalExitParams) =>
      reportExternalExit(client, params, timeoutMs, copy),
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

function createClient(options: CreateObserverServiceOptions, timeoutMs: number): ObserverClient {
  if (options.socketPath === undefined) {
    throw new Error("createObserverService requires socketPath or client.");
  }
  return createObserverClient({
    socketPath: options.socketPath,
    timeoutMs,
    ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
  });
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
