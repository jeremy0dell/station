import { randomUUID } from "node:crypto";
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
  HostClaimControlParamsSchema,
  type HostClientIdentity,
  HostClientShutdownNotificationSchema,
  type HostCompatibilityIdentity,
  type HostControlEpoch,
  type HostControlState,
  HostDetachParamsSchema,
  type HostFrame,
  HostRequestSchema,
  HostResizeParamsSchema,
  HostWriteParamsSchema,
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
  /** Current table-authoritative role and epoch, used only for safe lifecycle evidence. */
  readonly controlState: HostControlState;
  /** Reclaim mutation authority for this registered attachment without presenting a stale epoch. */
  claimControl(): HostControlState;
  /** The connection registry binds attachment identity; the table still rejects a stale epoch. */
  write(controlEpoch: HostControlEpoch, data: string): void;
  resize(controlEpoch: HostControlEpoch, cols: number, rows: number): void;
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
    attachmentId: string,
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
  source: HostAttachmentSource;
  detachedControlState?: HostControlState;
  reason?: Extract<HostLifecycleEventInput, { kind: "host.attachment.detached" }>["reason"];
};

type ConnectionState = {
  client?: HostClientIdentity;
  clientDetachReason: Extract<HostLifecycleEventInput, { kind: "host.client.detached" }>["reason"];
  attachments: Map<string, ActiveAttachment>;
  attachmentByPty: Map<string, ActiveAttachment>;
  inFlight: Set<Promise<void>>;
  acceptingAttachments: boolean;
};

/**
 * ADAPTER
 *
 * Dispatch host requests concurrently so long-lived `host.attach` streams do
 * not block write/resize/detach on the same multiplexed socket. The first
 * non-health request binds one exact protocol, build, and diagnostic client identity to the connection;
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
    acceptingAttachments: true,
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
    state.acceptingAttachments = false;
    const attachments = [...state.attachments.values()];
    state.attachments.clear();
    state.attachmentByPty.clear();
    for (const attachment of attachments) {
      attachment.reason ??= state.clientDetachReason;
      void releaseAttachmentRegistration(state, attachment);
    }
    await Promise.allSettled([...state.inFlight]);
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
  // Cross-build convergence reads the exact incumbent inventory on the same connection before a
  // lifecycle mutation; operational calls and successor adoption remain identity-bound.
  const lifecycleRequest = request.method === "host.health";
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
    if (attachment !== undefined) {
      attachment.reason = params.data.reason;
      await releaseAttachmentRegistration(state, attachment);
    }
    connection.send(hostSuccess(request.id, { ok: true }));
    return;
  }

  if (request.method === "host.claimControl") {
    const params = HostClaimControlParamsSchema.safeParse(request.params);
    if (!params.success) {
      fail(connection, logger, request.id, "HOST_BAD_REQUEST", "Malformed host control claim.");
      return;
    }
    const attachment = state.attachments.get(params.data.attachmentId);
    if (attachment === undefined) {
      failControlRevoked(connection, logger, request.id);
      return;
    }
    try {
      connection.send(hostSuccess(request.id, attachment.source.claimControl()));
    } catch (error) {
      failFromHandler(connection, logger, request.id, "host.claimControl", error);
    }
    return;
  }

  if (request.method === "host.write") {
    const params = HostWriteParamsSchema.safeParse(request.params);
    if (!params.success) {
      fail(connection, logger, request.id, "HOST_BAD_REQUEST", "Malformed host write request.");
      return;
    }
    const attachment = state.attachments.get(params.data.attachmentId);
    if (attachment === undefined) {
      failControlRevoked(connection, logger, request.id);
      return;
    }
    try {
      attachment.source.write(params.data.controlEpoch, params.data.data);
      connection.send(hostSuccess(request.id, { ok: true }));
    } catch (error) {
      failFromHandler(connection, logger, request.id, "host.write", error);
    }
    return;
  }

  if (request.method === "host.resize") {
    const params = HostResizeParamsSchema.safeParse(request.params);
    if (!params.success) {
      fail(connection, logger, request.id, "HOST_BAD_REQUEST", "Malformed host resize request.");
      return;
    }
    const attachment = state.attachments.get(params.data.attachmentId);
    if (attachment === undefined) {
      failControlRevoked(connection, logger, request.id);
      return;
    }
    try {
      attachment.source.resize(params.data.controlEpoch, params.data.cols, params.data.rows);
      connection.send(hostSuccess(request.id, { ok: true }));
    } catch (error) {
      failFromHandler(connection, logger, request.id, "host.resize", error);
    }
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

/** Release one registered attachment while retaining its last authoritative control evidence. */
function releaseAttachmentRegistration(
  state: ConnectionState,
  attachment: ActiveAttachment,
): Promise<IteratorResult<HostFrame>> | undefined {
  if (state.attachments.get(attachment.attachmentId) === attachment) {
    state.attachments.delete(attachment.attachmentId);
  }
  if (state.attachmentByPty.get(attachment.ptyId) === attachment) {
    state.attachmentByPty.delete(attachment.ptyId);
  }
  attachment.detachedControlState ??= attachment.source.controlState;
  // Registry removal precedes synchronous iterator return so no concurrent request can retain authority.
  return attachment.iterator.return?.();
}

function failControlRevoked(
  connection: NdjsonConnection,
  logger: HostServerLogger,
  id: string,
): void {
  fail(
    connection,
    logger,
    id,
    "HOST_CONTROL_REVOKED",
    "Station Host rejected a mutation from an unknown or cross-connection attachment.",
  );
}

function failFromHandler(
  connection: NdjsonConnection,
  logger: HostServerLogger,
  id: string,
  method: string,
  error: unknown,
): void {
  const safeError = stationHostErrorFromUnknown(error, {
    code: "HOST_REQUEST_FAILED",
    message: `Host method "${method}" failed.`,
  });
  logger.onError?.(safeError);
  connection.send(hostFailure(id, safeError));
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
  const attachmentId = `att_${randomUUID()}`;
  try {
    params = HostAttachParamsSchema.parse(rawParams);
    attachment = await handlers.attach(params, attachmentId);
    if (attachment.ack.attachmentId !== attachmentId || !isSameHostPtyRef(params, attachment.ack)) {
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
  if (!state.acceptingAttachments) {
    await iterator.return?.();
    return;
  }
  const active: ActiveAttachment = {
    attachmentId,
    ptyId: attachment.ack.ptyId,
    iterator,
    client: state.client,
    source: attachment,
  };
  const previous = state.attachmentByPty.get(active.ptyId);
  if (previous !== undefined) {
    previous.reason = "attachment_replaced";
    void releaseAttachmentRegistration(state, previous);
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
  logger.onEvent?.("host.attachment.attached", {
    ptyId: attachment.ack.ptyId,
    attachmentId: active.attachmentId,
    controlEpoch: attachment.ack.controlEpoch,
    role: attachment.ack.role,
    reason: params.intent,
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
    void releaseAttachmentRegistration(state, active);
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
    await releaseAttachmentRegistration(state, active);
    const finalControl = active.detachedControlState ?? active.source.controlState;
    const reason = active.reason ?? "stream_failed";
    logger.onEvent?.("agent.detach", { ptyId: active.ptyId });
    logger.onEvent?.("host.attachment.detached", {
      ptyId: active.ptyId,
      attachmentId: active.attachmentId,
      controlEpoch: finalControl.controlEpoch,
      role: finalControl.role,
      reason,
    });
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
  state.acceptingAttachments = false;
  const attachments = [...state.attachments.values()];
  state.attachments.clear();
  state.attachmentByPty.clear();
  for (const attachment of attachments) {
    attachment.reason ??= "client_shutdown";
    void releaseAttachmentRegistration(state, attachment);
  }
}

function requestId(message: unknown): string {
  const parsed = HostRequestIdCarrierSchema.safeParse(message);
  return parsed.success ? parsed.data.id : "unknown";
}
