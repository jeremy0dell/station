import type { ObserverApi, StationEvent } from "@station/contracts";
import {
  AgentPrepareExternalLaunchParamsSchema,
  AgentReportExternalExitParamsSchema,
  DiagnosticCollectionOptionsSchema,
  DoctorOptionsSchema,
  SafeErrorSchema,
  STATION_SCHEMA_VERSION,
} from "@station/contracts";
import { Effect, runRuntimeBoundaryWithTimeout } from "@station/runtime";
import { ZodError } from "zod";
import {
  CommandDispatchParamsSchema,
  CommandGetParamsSchema,
  EventsSubscribeParamsSchema,
  HarnessEventReportParamsSchema,
  ProtocolEventEnvelopeSchema,
  type ProtocolMethod,
  type ProtocolRequest,
  ProtocolRequestSchema,
  ProviderHookIngestParamsSchema,
  protocolErrorResponse,
  protocolSafeError,
  protocolSuccessResponse,
  ReconcileParamsSchema,
  SnapshotGetParamsSchema,
} from "./messages.js";
import { listenUnixSocket, type NdjsonConnection, type UnixSocketServer } from "./transport.js";

const defaultRequestTimeoutMs = 5000;
const diagnosticRequestTimeoutMs = 30_000;

export type ProtocolServerOptions = {
  socketPath: string;
  api: ObserverApi;
  requestTimeoutMs?: number;
  /** Synchronous lifecycle admission check run immediately before API routing. */
  requestGuard?: (method: ProtocolMethod) => void;
};

/**
 * ADAPTER
 *
 * Exposes Observer operations through validated NDJSON requests on a Unix socket.
 */
export async function startProtocolServer(
  options: ProtocolServerOptions,
): Promise<UnixSocketServer> {
  return listenUnixSocket({
    socketPath: options.socketPath,
    onConnection: (connection) =>
      handleConnection(
        connection,
        options.api,
        options.requestTimeoutMs ?? defaultRequestTimeoutMs,
        options.requestGuard,
      ),
  });
}

async function handleConnection(
  connection: NdjsonConnection,
  api: ObserverApi,
  requestTimeoutMs: number,
  requestGuard: ((method: ProtocolMethod) => void) | undefined,
): Promise<void> {
  try {
    for await (const message of connection.messages()) {
      const request = ProtocolRequestSchema.safeParse(message);
      if (!request.success) {
        connection.send(errorResponse(requestId(message), "Invalid protocol request."));
        continue;
      }
      await routeRequest(connection, api, request.data, requestTimeoutMs, requestGuard);
    }
  } catch {
    connection.close();
  }
}

async function routeRequest(
  connection: NdjsonConnection,
  api: ObserverApi,
  request: ProtocolRequest,
  requestTimeoutMs: number,
  requestGuard: ((method: ProtocolMethod) => void) | undefined,
): Promise<void> {
  try {
    requestGuard?.(request.method);
  } catch (error) {
    connection.send(errorResponse(request.id, "Observer is not accepting this operation.", error));
    return;
  }
  if (request.method === "events.subscribe") {
    await routeSubscriptionRequest(connection, api, request);
    return;
  }

  const timeoutMs = protocolHandlerTimeoutMs(request.method, requestTimeoutMs);
  const result = await runRuntimeBoundaryWithTimeout(
    {
      operation: `protocol.server.${request.method}`,
      timeoutMs,
      error: protocolSafeError({
        code: "PROTOCOL_HANDLER_FAILED",
        message: "Observer protocol method failed.",
      }),
      timeoutError: protocolSafeError({
        tag: "TimeoutError",
        code: "PROTOCOL_HANDLER_TIMEOUT",
        message: "Observer protocol method timed out.",
      }),
    },
    async () => routeSingleResponseRequest(api, request),
  );
  if (!result.ok) {
    connection.send(errorResponse(request.id, "Observer protocol method failed.", result.error));
    return;
  }
  try {
    sendResult(connection, request.id, request.method, result.value);
  } catch (error) {
    connection.send(
      errorResponse(request.id, "Observer protocol response validation failed.", error),
    );
  }
}

function protocolHandlerTimeoutMs(method: ProtocolMethod, requestTimeoutMs: number): number {
  switch (method) {
    case "doctor.run":
    case "diagnostics.collect":
      return Math.max(requestTimeoutMs, diagnosticRequestTimeoutMs);
    default:
      return requestTimeoutMs;
  }
}

async function routeSingleResponseRequest(
  api: ObserverApi,
  request: ProtocolRequest,
): Promise<unknown> {
  try {
    switch (request.method) {
      case "observer.health": {
        return await api.health();
      }
      case "observer.stop": {
        return await api.stop();
      }
      case "snapshot.get": {
        const params = SnapshotGetParamsSchema.parse(request.params);
        return await api.getSnapshot(
          params?.includeDebug === undefined ? undefined : { includeDebug: params.includeDebug },
        );
      }
      case "command.dispatch": {
        const params = CommandDispatchParamsSchema.parse(request.params);
        return await api.dispatch(params.command);
      }
      case "command.get": {
        const params = CommandGetParamsSchema.parse(request.params);
        return (await api.getCommand(params.commandId)) ?? null;
      }
      case "observer.reconcile": {
        const params = ReconcileParamsSchema.parse(request.params);
        return await api.reconcile(params?.reason);
      }
      case "observer.ingestProviderHookEvent": {
        const params = ProviderHookIngestParamsSchema.parse(request.params);
        return await api.ingestProviderHookEvent(params.event);
      }
      case "observer.harnessEvent.report": {
        const params = HarnessEventReportParamsSchema.parse(request.params);
        return await api.reportHarnessEvent(params.report);
      }
      case "agent.prepareExternalLaunch": {
        const params = AgentPrepareExternalLaunchParamsSchema.parse(request.params);
        return await api.prepareExternalLaunch(params);
      }
      case "agent.reportExternalExit": {
        const params = AgentReportExternalExitParamsSchema.parse(request.params);
        return await api.reportExternalExit(params);
      }
      case "doctor.run": {
        const params = DoctorOptionsSchema.parse(request.params);
        return await api.runDoctor(params);
      }
      case "diagnostics.collect": {
        const params = DiagnosticCollectionOptionsSchema.parse(request.params);
        return await api.collectDiagnostics(params);
      }
    }
  } catch (error) {
    throw protocolSafeErrorFromUnknown(error);
  }
}

async function routeSubscriptionRequest(
  connection: NdjsonConnection,
  api: ObserverApi,
  request: ProtocolRequest,
): Promise<void> {
  try {
    const params = EventsSubscribeParamsSchema.parse(request.params);
    sendResult(connection, request.id, "events.subscribe", { subscribed: true });
    await streamEvents(connection, api.subscribe(params));
  } catch (error) {
    connection.send(errorResponse(request.id, "Observer protocol method failed.", error));
  } finally {
    connection.close();
  }
}

function sendResult(
  connection: NdjsonConnection,
  id: string,
  method: ProtocolMethod,
  value: unknown,
): void {
  connection.send(protocolSuccessResponse(id, method, value));
}

async function streamEvents(
  connection: NdjsonConnection,
  events: AsyncIterable<StationEvent>,
): Promise<void> {
  // Subscription streams end on iterator completion or socket close; return() releases the bus queue.
  const iterator = events[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await nextEventOrClosed(connection, iterator);
      if (next.done) {
        return;
      }
      connection.send(
        ProtocolEventEnvelopeSchema.parse({
          schemaVersion: STATION_SCHEMA_VERSION,
          event: next.value,
        }),
      );
    }
  } finally {
    await iterator.return?.();
  }
}

async function nextEventOrClosed(
  connection: NdjsonConnection,
  iterator: AsyncIterator<StationEvent>,
): Promise<IteratorResult<StationEvent>> {
  // Race the next event against socket close so a disconnected client cannot
  // leave a subscriber alive.
  return Effect.runPromise(
    Effect.raceFirst(
      Effect.tryPromise({
        try: () => iterator.next(),
        catch: protocolSafeErrorFromUnknown,
      }),
      Effect.as(
        Effect.tryPromise({
          try: () => connection.closed,
          catch: protocolSafeErrorFromUnknown,
        }),
        { done: true as const, value: undefined },
      ),
    ),
  );
}

function errorResponse(id: string, message: string, error?: unknown) {
  const parsedSafeError = SafeErrorSchema.safeParse(error);
  const safeError = parsedSafeError.success ? parsedSafeError.data : protocolSafeError({ message });
  return protocolErrorResponse(id, safeError);
}

function protocolSafeErrorFromUnknown(error: unknown) {
  const parsedSafeError = SafeErrorSchema.safeParse(error);
  if (parsedSafeError.success) {
    return parsedSafeError.data;
  }
  if (error instanceof ZodError) {
    return protocolSafeError({
      code: "PROTOCOL_VALIDATION_FAILED",
      message: "Observer protocol payload failed validation.",
      hint: "If station was just rebuilt, restart the observer so it loads the current schema.",
    });
  }
  return protocolSafeError({ message: "Observer protocol method failed." });
}

function requestId(message: unknown): string {
  if (message && typeof message === "object" && "id" in message && typeof message.id === "string") {
    return message.id;
  }
  return "unknown";
}
