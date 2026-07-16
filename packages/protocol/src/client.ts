import type {
  CommandId,
  CommandRecord,
  DiagnosticCollectionOptions,
  DoctorOptions,
  EventFilter,
  HarnessEventReport,
  ObserverApi,
  ObserverHealth,
  ProviderHookEvent,
  StationCommand,
  StationEvent,
} from "@station/contracts";
import { STATION_SCHEMA_VERSION, StationEventSchema } from "@station/contracts";
import { Effect, runRuntimeBoundaryWithTimeout } from "@station/runtime";
import { z } from "zod";
import {
  type ProtocolMethod,
  type ProtocolResponse,
  ProtocolResponseSchema,
  ProtocolResultSchemas,
  protocolRequest,
  protocolSafeError,
  protocolSocketClosedError,
} from "./messages.js";
import { unwrapBoundaryResult } from "./runtime.js";
import { connectUnixSocket, type NdjsonConnection } from "./transport.js";

type ProtocolResult<TMethod extends ProtocolMethod> = z.infer<
  (typeof ProtocolResultSchemas)[TMethod]
>;

export type TerminalCommandRecord = CommandRecord & {
  status: "succeeded" | "failed";
};

export type CommandWaitOptions = {
  timeoutMs?: number;
};

/** Process identity pinned before a mutation; version may be absent in legacy health. */
export type ExpectedObserverIdentity = Required<Pick<ObserverHealth, "pid" | "startedAt">> &
  Pick<ObserverHealth, "version"> & {
    socketPath: string;
  };

type ExpectedObserver =
  | { kind: "build"; version: string }
  | { kind: "process"; identity: ExpectedObserverIdentity };

export type ObserverClient = ObserverApi & {
  waitForCommand(
    commandId: CommandId,
    options?: CommandWaitOptions,
  ): Promise<TerminalCommandRecord>;
};

export type CreateObserverClientOptions = {
  socketPath: string;
  timeoutMs?: number;
  requestId?: () => string;
  /** Exact Observer build selector required before each non-health operation. */
  expectedBuildVersion?: string;
  /** Exact process identity required before an ownership-changing operation. */
  expectedObserverIdentity?: ExpectedObserverIdentity;
};

type OpenSubscription = {
  connection: NdjsonConnection;
  iterator: AsyncIterator<unknown>;
};

const defaultRequestId = () => `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const ProtocolSchemaVersionProbeSchema = z
  .object({
    schemaVersion: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();
const ProtocolEventEnvelopeMessageSchema = z
  .object({
    schemaVersion: z.literal(STATION_SCHEMA_VERSION),
    event: z.unknown(),
  })
  .strict();

/**
 * ADAPTER
 *
 * Presents Observer operations to clients through validated NDJSON requests.
 */
export function createObserverClient(options: CreateObserverClientOptions): ObserverClient {
  const requestId = options.requestId ?? defaultRequestId;

  return {
    health: async () => requestProtocolMethod(options, requestId(), "observer.health"),
    stop: async () => requestProtocolMethod(options, requestId(), "observer.stop"),
    getSnapshot: async (params) =>
      requestProtocolMethod(options, requestId(), "snapshot.get", params),
    dispatch: async (command: StationCommand) =>
      requestProtocolMethod(options, requestId(), "command.dispatch", { command }),
    getCommand: async (commandId: CommandId) => {
      const result = await requestProtocolMethod(options, requestId(), "command.get", {
        commandId,
      });
      return result === null ? undefined : (result satisfies CommandRecord);
    },
    reconcile: async (reason?: string) =>
      requestProtocolMethod(
        options,
        requestId(),
        "observer.reconcile",
        reason === undefined ? undefined : { reason },
      ),
    ingestProviderHookEvent: async (event: ProviderHookEvent) =>
      requestProtocolMethod(options, requestId(), "observer.ingestProviderHookEvent", { event }),
    reportHarnessEvent: async (report: HarnessEventReport) =>
      requestProtocolMethod(options, requestId(), "observer.harnessEvent.report", { report }),
    prepareExternalLaunch: async (params) =>
      requestProtocolMethod(options, requestId(), "agent.prepareExternalLaunch", params),
    reportExternalExit: async (params) =>
      requestProtocolMethod(options, requestId(), "agent.reportExternalExit", params),
    runDoctor: async (params?: DoctorOptions) =>
      requestProtocolMethod(options, requestId(), "doctor.run", params),
    collectDiagnostics: async (params?: DiagnosticCollectionOptions) =>
      requestProtocolMethod(options, requestId(), "diagnostics.collect", params),
    subscribe: (filter?: EventFilter) => subscriptionIterator(options, requestId(), filter),
    waitForCommand: (commandId: CommandId, waitOptions?: CommandWaitOptions) =>
      waitForCommand(options, requestId, commandId, waitOptions),
  };
}

async function requestProtocolMethod<TMethod extends ProtocolMethod>(
  options: CreateObserverClientOptions,
  id: string,
  method: TMethod,
  params?: unknown,
): Promise<ProtocolResult<TMethod>> {
  const expectedObserver =
    method === "observer.health" ? undefined : resolveExpectedObserver(options);
  const result = await runRuntimeBoundaryWithTimeout(
    protocolClientBoundary(method, requestTimeoutMs(options)),
    ({ signal }) =>
      openRequestConnection(options, signal, async (connection) => {
        const iterator = connection.messages()[Symbol.asyncIterator]();
        if (expectedObserver !== undefined) {
          await assertExpectedObserver(connection, iterator, `${id}_health`, expectedObserver);
        }
        return readResponseForRequest(connection, iterator, id, method, params);
      }),
  );

  return unwrapBoundaryResult(result);
}

function protocolClientBoundary(method: ProtocolMethod, timeoutMs: number) {
  return {
    operation: `protocol.client.${method}`,
    timeoutMs,
    error: protocolSafeError({
      code: "PROTOCOL_REQUEST_FAILED",
      message: "Observer protocol request failed.",
    }),
    timeoutError: protocolSafeError({
      tag: "TimeoutError",
      code: "PROTOCOL_REQUEST_TIMEOUT",
      message: "Observer protocol request timed out.",
    }),
  };
}

async function openRequestConnection<T>(
  options: CreateObserverClientOptions,
  signal: AbortSignal,
  task: (connection: NdjsonConnection) => Promise<T>,
): Promise<T> {
  const connection = await connectUnixSocket(
    options.socketPath,
    options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
  );

  try {
    return await withConnectionAbort(connection, signal, () => task(connection));
  } finally {
    connection.close();
  }
}

async function readResponseForRequest<TMethod extends ProtocolMethod>(
  connection: NdjsonConnection,
  iterator: AsyncIterator<unknown>,
  id: string,
  method: TMethod,
  params?: unknown,
): Promise<ProtocolResult<TMethod>> {
  connection.send(protocolRequest(id, method, params));

  for (;;) {
    const next = await iterator.next();
    if (next.done) {
      throw protocolSocketClosedError();
    }
    const response = parseProtocolResponseMessage(next.value);
    if (response.id !== id) {
      continue;
    }
    return parseProtocolResponseResult(response, method);
  }
}

async function assertExpectedObserver(
  connection: NdjsonConnection,
  iterator: AsyncIterator<unknown>,
  id: string,
  expectedObserver: ExpectedObserver,
): Promise<void> {
  const health = await readResponseForRequest(connection, iterator, id, "observer.health");
  assertObserverIdentity(expectedObserver, health);
}

function assertObserverIdentity(
  expectedObserver: ExpectedObserver,
  actualObserver: ObserverHealth,
): void {
  const expectedBuildVersion =
    expectedObserver.kind === "build"
      ? expectedObserver.version
      : expectedObserver.identity.version;
  if (
    (expectedObserver.kind === "build" && actualObserver.version === expectedBuildVersion) ||
    (expectedObserver.kind === "process" &&
      actualObserver.pid === expectedObserver.identity.pid &&
      actualObserver.startedAt === expectedObserver.identity.startedAt &&
      actualObserver.version === expectedObserver.identity.version &&
      // Legacy health can omit socketPath; this connection already proves the configured endpoint.
      (actualObserver.socketPath === undefined ||
        actualObserver.socketPath === expectedObserver.identity.socketPath))
  ) {
    return;
  }

  const reportedBuildVersion = actualObserver.version ?? "missing";
  throw protocolSafeError({
    code: "OBSERVER_BUILD_MISMATCH",
    message:
      expectedObserver.kind === "build"
        ? `Observer build mismatch: this client expects "${expectedBuildVersion}", but the socket owner reports "${reportedBuildVersion}".`
        : "Observer process changed before the guarded operation could run.",
    hint: "Close and relaunch this client so it can hand off to the current Observer, or use a config with an isolated observer socket_path and state_dir.",
  });
}

function parseProtocolResponseResult<TMethod extends ProtocolMethod>(
  response: ProtocolResponse,
  method: TMethod,
): ProtocolResult<TMethod> {
  if ("error" in response) {
    throw response.error;
  }
  const parsed = ProtocolResultSchemas[method].safeParse(response.result);
  if (parsed.success) {
    return parsed.data as ProtocolResult<TMethod>;
  }
  throw protocolSafeError({
    code: "PROTOCOL_RESPONSE_VALIDATION_FAILED",
    message: `Observer protocol response failed validation for ${method}.`,
    hint: "The running observer may be from a different STATION build. Restart it or use a config with an isolated observer socket_path and state_dir.",
  });
}

function subscriptionIterator(
  options: CreateObserverClientOptions,
  id: string,
  filter?: EventFilter,
): AsyncIterable<StationEvent> {
  return {
    [Symbol.asyncIterator]: () => {
      let subscriptionPromise: Promise<OpenSubscription> | undefined;
      let subscription: OpenSubscription | undefined;
      let closed = false;

      const getSubscription = async (): Promise<OpenSubscription | undefined> => {
        if (closed) {
          return undefined;
        }
        if (subscriptionPromise === undefined) {
          subscriptionPromise = openSubscription(options, id, filter).then((opened) => {
            subscription = opened;
            if (closed) {
              void closeSubscription(opened);
            }
            return opened;
          });
        }
        const opened = await subscriptionPromise;
        return closed ? undefined : opened;
      };

      const close = async (): Promise<void> => {
        if (closed) {
          return;
        }
        closed = true;
        if (subscription !== undefined) {
          await closeSubscription(subscription);
          return;
        }
        if (subscriptionPromise !== undefined) {
          void subscriptionPromise.then(closeSubscription).catch(() => undefined);
        }
      };

      return {
        next: async () => {
          const opened = await getSubscription();
          if (opened === undefined) {
            return { done: true, value: undefined };
          }
          try {
            // Event streams are long-lived after the bounded subscription acknowledgement.
            const event = await readSubscriptionEvent(opened);
            if (event === undefined) {
              await close();
              return { done: true, value: undefined };
            }
            return { done: false, value: event };
          } catch (error) {
            await close();
            throw error;
          }
        },
        return: async () => {
          await close();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

function requestTimeoutMs(options: CreateObserverClientOptions): number {
  return options.timeoutMs ?? 5000;
}

async function openSubscription(
  options: CreateObserverClientOptions,
  id: string,
  filter?: EventFilter,
  signal?: AbortSignal,
): Promise<OpenSubscription> {
  const expectedObserver = resolveExpectedObserver(options);
  const connection = await connectUnixSocket(
    options.socketPath,
    options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
  );
  const iterator = connection.messages()[Symbol.asyncIterator]();
  try {
    if (expectedObserver !== undefined) {
      await assertExpectedObserverForSubscription(
        connection,
        iterator,
        `${id}_health`,
        expectedObserver,
        requestTimeoutMs(options),
        signal,
      );
    }
    connection.send(protocolRequest(id, "events.subscribe", filter));
    // The acknowledgement is bounded; the event stream itself remains long-lived.
    await readSubscriptionAck(connection, iterator, id, requestTimeoutMs(options), signal);
    return { connection, iterator };
  } catch (error) {
    connection.close();
    throw error;
  }
}

function resolveExpectedObserver(
  options: CreateObserverClientOptions,
): ExpectedObserver | undefined {
  if (options.expectedObserverIdentity !== undefined) {
    return { kind: "process", identity: options.expectedObserverIdentity };
  }
  if (options.expectedBuildVersion !== undefined) {
    return { kind: "build", version: options.expectedBuildVersion };
  }
  return undefined;
}

async function assertExpectedObserverForSubscription(
  connection: NdjsonConnection,
  iterator: AsyncIterator<unknown>,
  id: string,
  expectedObserver: ExpectedObserver,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  connection.send(protocolRequest(id, "observer.health"));
  const message = await readNextProtocolMessage(
    connection,
    iterator,
    {
      timeoutMs,
      code: "PROTOCOL_REQUEST_TIMEOUT",
      message: "Observer protocol build check timed out.",
    },
    signal,
  );
  const response = parseProtocolResponseMessage(message);
  if (response.id !== id) {
    throw protocolSafeError({
      code: "PROTOCOL_RESPONSE_VALIDATION_FAILED",
      message: "Observer protocol build check did not match the request.",
    });
  }
  const health = parseProtocolResponseResult(response, "observer.health");
  assertObserverIdentity(expectedObserver, health);
}

async function readSubscriptionAck(
  connection: NdjsonConnection,
  iterator: AsyncIterator<unknown>,
  id: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const ack = await readNextProtocolMessage(
    connection,
    iterator,
    {
      timeoutMs,
      code: "PROTOCOL_SUBSCRIBE_TIMEOUT",
      message: "Observer protocol subscription acknowledgement timed out.",
    },
    signal,
  );
  const response = parseProtocolResponseMessage(ack);
  if (response.id !== id) {
    throw protocolSafeError({
      code: "PROTOCOL_SUBSCRIBE_ACK_MISMATCH",
      message: "Observer protocol subscription acknowledgement did not match the request.",
    });
  }
  if ("error" in response) {
    throw response.error;
  }
}

async function readSubscriptionEvent(
  subscription: OpenSubscription,
  signal?: AbortSignal,
): Promise<StationEvent | undefined> {
  const next = await readIteratorResult(subscription.connection, subscription.iterator, signal);
  if (next.done) {
    return undefined;
  }
  const envelope = parseProtocolEventEnvelope(next.value);
  const parsed = StationEventSchema.safeParse(envelope.event);
  if (parsed.success) {
    return parsed.data;
  }
  throw protocolSafeError({
    code: "PROTOCOL_EVENT_VALIDATION_FAILED",
    message: "Observer protocol event failed validation.",
    hint: "The running observer may be from a different STATION build. Restart it or use a config with an isolated observer socket_path and state_dir.",
  });
}

function parseProtocolResponseMessage(message: unknown): ProtocolResponse {
  const parsed = ProtocolResponseSchema.safeParse(message);
  if (parsed.success) {
    return parsed.data;
  }
  throwProtocolSchemaMismatchIfPresent(message);
  throw parsed.error;
}

function parseProtocolEventEnvelope(message: unknown) {
  const parsed = ProtocolEventEnvelopeMessageSchema.safeParse(message);
  if (parsed.success) {
    return parsed.data;
  }
  throwProtocolSchemaMismatchIfPresent(message);
  throw parsed.error;
}

function throwProtocolSchemaMismatchIfPresent(message: unknown): void {
  const probed = ProtocolSchemaVersionProbeSchema.safeParse(message);
  const schemaVersion = probed.success ? probed.data.schemaVersion : undefined;
  if (schemaVersion === undefined || String(schemaVersion) === STATION_SCHEMA_VERSION) {
    return;
  }
  throw protocolSafeError({
    code: "PROTOCOL_SCHEMA_MISMATCH",
    message: `Observer protocol schema mismatch: the observer responded with schema ${String(schemaVersion)}, but this CLI expects schema ${STATION_SCHEMA_VERSION}.`,
    hint: "A different STATION checkout may own the observer socket. Stop that observer, rebuild this checkout, or use a config with an isolated observer socket_path and state_dir.",
  });
}

async function closeSubscription(subscription: OpenSubscription): Promise<void> {
  // Returning the iterator closes the socket and releases the observer-side subscription.
  try {
    await subscription.iterator.return?.();
  } finally {
    subscription.connection.close();
  }
}

async function waitForCommand(
  options: CreateObserverClientOptions,
  requestId: () => string,
  commandId: CommandId,
  waitOptions: CommandWaitOptions = {},
): Promise<TerminalCommandRecord> {
  const program = commandWaitEffect(options, requestId, commandId);
  if (waitOptions.timeoutMs === undefined) {
    return runEffectAsPromise(program);
  }
  return runEffectAsPromise(
    Effect.timeoutFail(program, {
      duration: `${waitOptions.timeoutMs} millis`,
      onTimeout: () =>
        protocolSafeError({
          tag: "TimeoutError",
          code: "PROTOCOL_COMMAND_WAIT_TIMEOUT",
          message: "Observer command did not finish before the timeout.",
        }),
    }),
  );
}

function commandWaitEffect(
  options: CreateObserverClientOptions,
  requestId: () => string,
  commandId: CommandId,
): Effect.Effect<TerminalCommandRecord, unknown> {
  let subscription: OpenSubscription | undefined;

  return Effect.gen(function* () {
    subscription = yield* openSubscriptionEffect(options, requestId(), {
      type: ["command.succeeded", "command.failed"],
      commandId,
    });
    // Subscribe before getCommand so fast command completions cannot be missed.
    const existing = yield* commandTerminalRecordEffect(options, requestId, commandId);
    if (existing !== undefined) {
      return existing;
    }
    return yield* awaitCommandTerminalRecord(options, requestId, commandId, subscription);
  }).pipe(
    Effect.ensuring(
      Effect.tryPromise({
        try: async () => {
          if (subscription !== undefined) {
            await closeSubscription(subscription);
          }
        },
        catch: () => undefined,
      }).pipe(Effect.catchAll(() => Effect.succeed(undefined))),
    ),
  );
}

function openSubscriptionEffect(
  options: CreateObserverClientOptions,
  id: string,
  filter: EventFilter,
): Effect.Effect<OpenSubscription, unknown> {
  return Effect.tryPromise({
    try: (signal) => openSubscription(options, id, filter, signal),
    catch: (error) => error,
  });
}

function commandTerminalRecordEffect(
  options: CreateObserverClientOptions,
  requestId: () => string,
  commandId: CommandId,
): Effect.Effect<TerminalCommandRecord | undefined, unknown> {
  return Effect.tryPromise({
    try: () => requestProtocolMethod(options, requestId(), "command.get", { commandId }),
    catch: (error) => error,
  }).pipe(Effect.map((record) => terminalCommandRecord(record ?? undefined)));
}

function awaitCommandTerminalRecord(
  options: CreateObserverClientOptions,
  requestId: () => string,
  commandId: CommandId,
  subscription: OpenSubscription,
): Effect.Effect<TerminalCommandRecord, unknown> {
  return Effect.gen(function* () {
    const event = yield* readSubscriptionEventEffect(subscription);
    if (event === undefined) {
      const refreshed = yield* commandTerminalRecordEffect(options, requestId, commandId);
      if (refreshed !== undefined) {
        return refreshed;
      }
      return yield* Effect.fail(
        protocolSafeError({
          code: "PROTOCOL_COMMAND_EVENT_STREAM_CLOSED",
          message: "Observer event stream closed before command completion.",
        }),
      );
    }
    if (
      (event.type === "command.succeeded" || event.type === "command.failed") &&
      event.commandId === commandId
    ) {
      const terminal = yield* commandTerminalRecordEffect(options, requestId, commandId);
      if (terminal !== undefined) {
        return terminal;
      }
    }
    return yield* awaitCommandTerminalRecord(options, requestId, commandId, subscription);
  });
}

function readSubscriptionEventEffect(
  subscription: OpenSubscription,
): Effect.Effect<StationEvent | undefined, unknown> {
  return Effect.tryPromise({
    try: (signal) => readSubscriptionEvent(subscription, signal),
    catch: (error) => error,
  });
}

function terminalCommandRecord(
  record: CommandRecord | undefined,
): TerminalCommandRecord | undefined {
  if (record?.status === "succeeded" || record?.status === "failed") {
    return record as TerminalCommandRecord;
  }
  return undefined;
}

async function readNextProtocolMessage(
  connection: NdjsonConnection,
  iterator: AsyncIterator<unknown>,
  timeout: { timeoutMs: number; code: string; message: string },
  signal?: AbortSignal,
): Promise<unknown> {
  return runEffectAsPromise(
    Effect.timeoutFail(readNextProtocolMessageEffect(connection, iterator, signal), {
      duration: `${timeout.timeoutMs} millis`,
      onTimeout: () =>
        protocolSafeError({
          tag: "TimeoutError",
          code: timeout.code,
          message: timeout.message,
        }),
    }),
  );
}

function readNextProtocolMessageEffect(
  connection: NdjsonConnection,
  iterator: AsyncIterator<unknown>,
  externalSignal?: AbortSignal,
): Effect.Effect<unknown, unknown> {
  return Effect.tryPromise({
    try: (signal) =>
      readIteratorResult(connection, iterator, externalSignal ?? signal).then((next) => {
        if (next.done) {
          throw protocolSocketClosedError();
        }
        return next.value;
      }),
    catch: (error) => error,
  });
}

async function readIteratorResult(
  connection: NdjsonConnection,
  iterator: AsyncIterator<unknown>,
  signal?: AbortSignal,
): Promise<IteratorResult<unknown>> {
  const read = async () => iterator.next();
  if (signal === undefined) {
    return read();
  }
  return withConnectionAbort(connection, signal, read);
}

async function runEffectAsPromise<T>(effect: Effect.Effect<T, unknown>): Promise<T> {
  const result = await Effect.runPromise(
    effect.pipe(
      Effect.match({
        onFailure: (error) => ({ ok: false as const, error }),
        onSuccess: (value) => ({ ok: true as const, value }),
      }),
    ),
  );
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

async function withConnectionAbort<T>(
  connection: NdjsonConnection,
  signal: AbortSignal,
  task: () => Promise<T>,
): Promise<T> {
  const abort = () => connection.close();
  if (signal.aborted) {
    abort();
  } else {
    signal.addEventListener("abort", abort, { once: true });
  }
  try {
    return await task();
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
