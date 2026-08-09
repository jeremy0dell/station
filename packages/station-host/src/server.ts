import type { SafeError, UiLifecycleEventInputFor } from "@station/contracts";
import type { NdjsonConnection } from "@station/protocol";
import { z } from "zod";
import {
  type StationHostErrorCode,
  stationHostErrorFromUnknown,
  stationHostSafeError,
} from "./errors.js";
import {
  type HostAttachAck,
  type HostAttachParams,
  HostAttachParamsSchema,
  type HostClientIdentity,
  HostClientShutdownNotificationSchema,
  type HostCompatibilityIdentity,
  HostDetachParamsSchema,
  type HostFrame,
  HostRequestSchema,
  hostFailure,
  hostSuccess,
  isSameHostPtyRef,
} from "./protocol.js";

/** A single attachment produced after Host's asynchronous replay-capture barrier. */
export type HostAttachmentSource = {
  ack: HostAttachAck;
  frames: AsyncIterable<HostFrame>;
  /** Host-local timing metadata; never serialized onto the acknowledgement. */
  captureDurationMs: number;
};

/**
 * Method handlers the Bun host supplies. Unary handlers return a JSON result;
 * `attach` validates one exact PTY lifetime and returns its ack plus live frames. All are
 * optional so the host can grow its surface increment by increment — a missing
 * method answers with a classified `HOST_BAD_REQUEST` rather than crashing.
 */
export type HostHandlers = {
  /** Exact build identity required on every operational request. */
  hostIdentity: HostCompatibilityIdentity;
  unary?: Record<
    string,
    (params: unknown, client: HostClientIdentity | undefined) => Promise<unknown> | unknown
  >;
  attach?: (
    params: HostAttachParams,
    client: HostClientIdentity,
  ) => HostAttachmentSource | Promise<HostAttachmentSource>;
  /** Called only after a successful unary response has been written to the connection. */
  afterUnaryResponseSent?: (method: string) => void;
};

type HostLifecycleEventInput = UiLifecycleEventInputFor<"station-host">;

export type HostServerLogger = {
  onError?(error: SafeError): void;
  /** Frozen operational timeline and replay metrics; redaction-safe ids/counts only. */
  onEvent?(event: string, attributes: Record<string, unknown>): void;
  /** Typed correlation, attachment reason, and client teardown evidence. */
  onLifecycle?(event: HostLifecycleEventInput): void;
};

type ActiveAttachment = {
  attachmentId: string;
  ptyId: string;
  iterator: AsyncIterator<HostFrame>;
  client: HostClientIdentity;
  reason?: Extract<HostLifecycleEventInput, { kind: "host.attachment.detached" }>["reason"];
};

type ConnectionState = {
  client?: HostClientIdentity;
  clientDetachReason: Extract<HostLifecycleEventInput, { kind: "host.client.detached" }>["reason"];
  attachments: Map<string, ActiveAttachment>;
  attachmentByPty: Map<string, ActiveAttachment>;
  inFlight: Set<Promise<void>>;
};

/**
 * Dispatch host requests concurrently so long-lived `host.attach` streams do
 * not block write/resize/detach on the same multiplexed socket. The first
 * operational request binds one diagnostic client identity to the connection;
 * teardown then classifies every attachment before the client witness closes.
 */
export async function serveHostConnection(
  connection: NdjsonConnection,
  handlers: HostHandlers,
  logger: HostServerLogger = {},
): Promise<void> {
  const state: ConnectionState = {
    clientDetachReason: "socket_closed",
    attachments: new Map(),
    attachmentByPty: new Map(),
    inFlight: new Set(),
  };
  try {
    for await (const message of connection.messages()) {
      if (HostClientShutdownCandidateSchema.safeParse(message).success) {
        handleClientShutdownNotification(handlers, logger, state, message);
        continue;
      }
      const task = handleMessage(connection, handlers, logger, state, message);
      state.inFlight.add(task);
      void task.finally(() => state.inFlight.delete(task));
    }
  } catch {
    state.clientDetachReason = "stream_failed";
    connection.close();
  } finally {
    for (const attachment of state.attachments.values()) {
      attachment.reason ??= state.clientDetachReason;
      void attachment.iterator.return?.();
    }
    await Promise.allSettled([...state.inFlight]);
    state.attachments.clear();
    state.attachmentByPty.clear();
    if (state.client !== undefined) {
      logger.onLifecycle?.({
        kind: "host.client.detached",
        uiRunId: state.client.uiRunId,
        connectionId: state.client.connectionId,
        rendererPid: state.client.rendererPid,
        clientKind: state.client.clientKind,
        reason: state.clientDetachReason,
      });
    }
  }
}

async function handleMessage(
  connection: NdjsonConnection,
  handlers: HostHandlers,
  logger: HostServerLogger,
  state: ConnectionState,
  message: unknown,
): Promise<void> {
  const parsed = HostRequestSchema.safeParse(message);
  if (!parsed.success) {
    fail(connection, logger, requestId(message), "HOST_BAD_REQUEST", "Malformed host request.");
    return;
  }
  const request = parsed.data;
  // adoptRegistry is identity-bound: only cross-build negotiation methods are exempt.
  const lifecycleRequest =
    request.method === "host.health" ||
    request.method === "host.stopIfIdle" ||
    request.method === "host.beginHandoff" ||
    request.method === "host.completeHandoff" ||
    request.method === "host.abortHandoff";
  if (!lifecycleRequest) {
    const binding = bindClientIdentity(request.client, handlers.hostIdentity, state, logger);
    if (!binding.ok) {
      fail(connection, logger, request.id, binding.code, binding.message, binding.hint);
      return;
    }
  }

  if (request.method === "host.attach") {
    await runAttach(connection, handlers, logger, state, request.id, request.params);
    return;
  }

  if (request.method === "host.detach") {
    const params = HostDetachParamsSchema.safeParse(request.params);
    if (!params.success) {
      fail(connection, logger, request.id, "HOST_BAD_REQUEST", "Malformed host detach request.");
      return;
    }
    const attachment = state.attachments.get(params.data.attachmentId);
    if (attachment !== undefined && attachment.ptyId === params.data.ptyId) {
      attachment.reason = params.data.reason;
      state.attachments.delete(attachment.attachmentId);
      if (state.attachmentByPty.get(attachment.ptyId) === attachment) {
        state.attachmentByPty.delete(attachment.ptyId);
      }
      await attachment.iterator.return?.();
    }
    connection.send(hostSuccess(request.id, { ok: true }));
    return;
  }

  const handler = handlers.unary?.[request.method];
  if (handler === undefined) {
    fail(
      connection,
      logger,
      request.id,
      "HOST_BAD_REQUEST",
      `Unknown host method "${request.method}".`,
    );
    return;
  }

  let result: unknown;
  try {
    result = await handler(request.params, request.client);
  } catch (error) {
    const safeError = stationHostErrorFromUnknown(error, {
      code: "HOST_REQUEST_FAILED",
      message: `Host method "${request.method}" failed.`,
    });
    logger.onError?.(safeError);
    connection.send(hostFailure(request.id, safeError));
    return;
  }
  connection.send(hostSuccess(request.id, result));
  handlers.afterUnaryResponseSent?.(request.method);
}

type ClientBinding =
  | { ok: true; client: HostClientIdentity }
  | {
      ok: false;
      code: StationHostErrorCode;
      message: string;
      hint?: string;
    };

function bindClientIdentity(
  client: HostClientIdentity | undefined,
  hostIdentity: HostCompatibilityIdentity,
  state: ConnectionState,
  logger: HostServerLogger,
): ClientBinding {
  if (
    client !== undefined &&
    (client.protocolVersion !== hostIdentity.protocolVersion ||
      client.buildVersion !== hostIdentity.buildVersion)
  ) {
    return {
      ok: false,
      code: "HOST_VERSION_INCOMPATIBLE",
      message: `Station host build "${hostIdentity.buildVersion}" rejected a client with an incompatible protocol or build.`,
      hint: "Use the Station build that started this host, or let the current build negotiate a guarded idle replacement.",
    };
  }
  if (client === undefined) {
    return {
      ok: false,
      code: "HOST_CLIENT_IDENTITY_MISMATCH",
      message: "Station host rejected an operational request without client correlation identity.",
    };
  }
  if (state.client === undefined) {
    state.client = client;
    logger.onLifecycle?.({
      kind: "host.client.attached",
      uiRunId: client.uiRunId,
      connectionId: client.connectionId,
      rendererPid: client.rendererPid,
      clientKind: client.clientKind,
    });
    return { ok: true, client };
  }
  if (!sameClient(state.client, client)) {
    return {
      ok: false,
      code: "HOST_CLIENT_IDENTITY_MISMATCH",
      message:
        "Station host rejected a request whose correlation identity changed on one connection.",
    };
  }
  return { ok: true, client };
}

function sameClient(left: HostClientIdentity, right: HostClientIdentity): boolean {
  return (
    left.protocolVersion === right.protocolVersion &&
    left.buildVersion === right.buildVersion &&
    left.uiRunId === right.uiRunId &&
    left.rendererPid === right.rendererPid &&
    left.clientKind === right.clientKind &&
    left.connectionId === right.connectionId
  );
}

async function runAttach(
  connection: NdjsonConnection,
  handlers: HostHandlers,
  logger: HostServerLogger,
  state: ConnectionState,
  id: string,
  rawParams: unknown,
): Promise<void> {
  if (handlers.attach === undefined || state.client === undefined) {
    fail(connection, logger, id, "HOST_BAD_REQUEST", "Host does not support host.attach.");
    return;
  }
  let attachment: HostAttachmentSource;
  let params: HostAttachParams;
  try {
    params = HostAttachParamsSchema.parse(rawParams);
    attachment = await handlers.attach(params, state.client);
    if (!isSameHostPtyRef(params, attachment.ack)) {
      await attachment.frames[Symbol.asyncIterator]().return?.();
      throw stationHostSafeError(
        "HOST_ATTACHMENT_MISMATCH",
        "Host attach handler acknowledged a different PTY reference than requested.",
      );
    }
  } catch (error) {
    const safeError = stationHostErrorFromUnknown(error, {
      code: "HOST_ATTACH_GONE",
      message: "Could not attach to the requested host PTY.",
    });
    logger.onError?.(safeError);
    connection.send(hostFailure(id, safeError));
    return;
  }

  const iterator = attachment.frames[Symbol.asyncIterator]();
  const active: ActiveAttachment = {
    attachmentId: params.attachmentId,
    ptyId: attachment.ack.ptyId,
    iterator,
    client: state.client,
  };
  const previous = state.attachmentByPty.get(active.ptyId);
  if (previous !== undefined) {
    previous.reason = "attachment_replaced";
    state.attachments.delete(previous.attachmentId);
    void previous.iterator.return?.();
  }
  state.attachments.set(active.attachmentId, active);
  state.attachmentByPty.set(active.ptyId, active);
  connection.send(hostSuccess(id, attachment.ack));
  const replayBytes = attachment.ack.replay.events.reduce(
    (total, event) =>
      event.type === "data" ? total + Buffer.byteLength(event.data, "utf8") : total,
    0,
  );
  logger.onEvent?.("agent.attach", {
    ptyId: attachment.ack.ptyId,
    replayKind: attachment.ack.replay.kind,
    replayEntries: attachment.ack.replay.events.length,
    replayBytes,
    cols: attachment.ack.cols,
    rows: attachment.ack.rows,
    captureDurationMs: attachment.captureDurationMs,
  });
  logger.onLifecycle?.({
    kind: "host.attachment.attached",
    uiRunId: active.client.uiRunId,
    connectionId: active.client.connectionId,
    attachmentId: active.attachmentId,
    rendererPid: active.client.rendererPid,
    clientKind: active.client.clientKind,
    ptyId: active.ptyId,
  });

  void connection.closed.then(() => {
    active.reason ??= state.clientDetachReason;
    void iterator.return?.();
  });

  try {
    let next = await iterator.next();
    while (!next.done) {
      const frame = next.value;
      connection.send(frame);
      if (frame.type === "exit") {
        active.reason = "pty_exited";
      }
      next = await iterator.next();
    }
    active.reason ??= "stream_failed";
  } catch {
    active.reason ??=
      state.clientDetachReason === "socket_closed" ? "stream_failed" : state.clientDetachReason;
  } finally {
    if (state.attachments.get(active.attachmentId) === active) {
      state.attachments.delete(active.attachmentId);
    }
    if (state.attachmentByPty.get(active.ptyId) === active) {
      state.attachmentByPty.delete(active.ptyId);
    }
    await iterator.return?.();
    const reason = active.reason ?? "stream_failed";
    logger.onEvent?.("agent.detach", { ptyId: active.ptyId });
    logger.onLifecycle?.({
      kind: "host.attachment.detached",
      uiRunId: active.client.uiRunId,
      connectionId: active.client.connectionId,
      attachmentId: active.attachmentId,
      rendererPid: active.client.rendererPid,
      clientKind: active.client.clientKind,
      ptyId: active.ptyId,
      reason,
    });
  }
}

function fail(
  connection: NdjsonConnection,
  logger: HostServerLogger,
  id: string,
  code: StationHostErrorCode,
  message: string,
  hint?: string,
): void {
  const safeError = stationHostSafeError(code, message, hint === undefined ? {} : { hint });
  logger.onError?.(safeError);
  connection.send(hostFailure(id, safeError));
}

const HostClientShutdownCandidateSchema = z
  .object({ method: z.literal("host.clientShutdown") })
  .passthrough();
const HostRequestIdCarrierSchema = z.object({ id: z.string().min(1) }).passthrough();

function handleClientShutdownNotification(
  handlers: HostHandlers,
  logger: HostServerLogger,
  state: ConnectionState,
  message: unknown,
): void {
  const notification = HostClientShutdownNotificationSchema.safeParse(message);
  if (!notification.success) {
    logger.onError?.(
      stationHostSafeError(
        "HOST_BAD_REQUEST",
        "Malformed Station host client shutdown notification.",
      ),
    );
    return;
  }
  const binding = bindClientIdentity(
    notification.data.client,
    handlers.hostIdentity,
    state,
    logger,
  );
  if (!binding.ok) {
    logger.onError?.(stationHostSafeError(binding.code, binding.message));
    return;
  }
  state.clientDetachReason = "client_shutdown";
  for (const attachment of state.attachments.values()) {
    attachment.reason ??= "client_shutdown";
    void attachment.iterator.return?.();
  }
}

function requestId(message: unknown): string {
  const parsed = HostRequestIdCarrierSchema.safeParse(message);
  return parsed.success ? parsed.data.id : "unknown";
}
