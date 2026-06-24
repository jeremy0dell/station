import type { SafeError } from "@station/contracts";
import type { NdjsonConnection } from "@station/protocol";
import { stationHostErrorFromUnknown } from "./errors.js";
import {
  type HostAttachAck,
  type HostAttachParams,
  HostAttachParamsSchema,
  HostDetachParamsSchema,
  type HostFrame,
  HostRequestSchema,
  hostFailure,
  hostSuccess,
} from "./protocol.js";

/** A single attachment the host opens in response to `host.attach`. */
export type HostAttachmentSource = {
  ack: HostAttachAck;
  frames: AsyncIterable<HostFrame>;
};

/**
 * Method handlers the Bun host supplies. Unary handlers return a JSON result;
 * `attach` returns an ack plus a live frame stream (sync or async). All are
 * optional so the host can grow its surface increment by increment — a missing
 * method answers with a classified `HOST_BAD_REQUEST` rather than crashing.
 */
export type HostHandlers = {
  unary?: Record<string, (params: unknown) => Promise<unknown> | unknown>;
  attach?: (params: HostAttachParams) => HostAttachmentSource | Promise<HostAttachmentSource>;
};

export type HostServerLogger = {
  onError?(error: SafeError): void;
  /** Lifecycle observability — redaction-safe ids/counts only. */
  onEvent?(event: string, attributes: Record<string, unknown>): void;
};

/**
 * Dispatch host requests concurrently so long-lived `host.attach` streams do
 * not block write/resize/detach on the same multiplexed socket.
 */
export async function serveHostConnection(
  connection: NdjsonConnection,
  handlers: HostHandlers,
  logger: HostServerLogger = {},
): Promise<void> {
  // Per-connection attachments so `host.detach` can stop one pane's stream
  // without closing the shared connection (other panes stay attached).
  const attachments = new Map<string, AsyncIterator<HostFrame>>();
  try {
    for await (const message of connection.messages()) {
      void handleMessage(connection, handlers, logger, attachments, message);
    }
  } catch {
    connection.close();
  } finally {
    for (const iterator of attachments.values()) {
      void iterator.return?.();
    }
    attachments.clear();
  }
}

async function handleMessage(
  connection: NdjsonConnection,
  handlers: HostHandlers,
  logger: HostServerLogger,
  attachments: Map<string, AsyncIterator<HostFrame>>,
  message: unknown,
): Promise<void> {
  const parsed = HostRequestSchema.safeParse(message);
  if (!parsed.success) {
    fail(connection, logger, requestId(message), "HOST_BAD_REQUEST", "Malformed host request.");
    return;
  }
  const request = parsed.data;

  if (request.method === "host.attach") {
    await runAttach(connection, handlers, logger, attachments, request.id, request.params);
    return;
  }

  if (request.method === "host.detach") {
    const params = HostDetachParamsSchema.safeParse(request.params);
    if (params.success) {
      const iterator = attachments.get(params.data.ptyId);
      attachments.delete(params.data.ptyId);
      await iterator?.return?.();
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

  try {
    const result = await handler(request.params);
    connection.send(hostSuccess(request.id, result));
  } catch (error) {
    const safeError = stationHostErrorFromUnknown(error, {
      code: "HOST_REQUEST_FAILED",
      message: `Host method "${request.method}" failed.`,
    });
    logger.onError?.(safeError);
    connection.send(hostFailure(request.id, safeError));
  }
}

async function runAttach(
  connection: NdjsonConnection,
  handlers: HostHandlers,
  logger: HostServerLogger,
  attachments: Map<string, AsyncIterator<HostFrame>>,
  id: string,
  rawParams: unknown,
): Promise<void> {
  if (handlers.attach === undefined) {
    fail(connection, logger, id, "HOST_BAD_REQUEST", "Host does not support host.attach.");
    return;
  }
  let attachment: HostAttachmentSource;
  try {
    const params = HostAttachParamsSchema.parse(rawParams);
    attachment = await handlers.attach(params);
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
  // Defensive: if this connection somehow re-attaches the same ptyId, end the
  // previous stream so its iterator can't be orphaned (one pane = one attach).
  const previous = attachments.get(attachment.ack.ptyId);
  if (previous !== undefined) {
    void previous.return?.();
  }
  // Register before sending the ack so a detach that the client issues after the
  // ack always finds this attachment.
  attachments.set(attachment.ack.ptyId, iterator);
  connection.send(hostSuccess(id, attachment.ack));
  logger.onEvent?.("agent.attach", {
    ptyId: attachment.ack.ptyId,
    scrollbackEntries: attachment.ack.scrollback.length,
    truncated: attachment.ack.truncated,
  });

  // End this stream when the socket closes — a disconnected client must not leave
  // the host streaming. One handler, not a per-frame race against connection.closed
  // (which would pile a continuation onto the stable closed promise per frame).
  let socketClosed = false;
  void connection.closed.then(() => {
    socketClosed = true;
    void iterator.return?.();
  });

  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done || socketClosed) {
        return;
      }
      connection.send(next.value);
    }
  } catch {
    // A socket write or iterator fault during streaming: stop cleanly.
  } finally {
    // Evict only our OWN registration — a later attach for the same ptyId on this
    // connection may have already replaced it.
    if (attachments.get(attachment.ack.ptyId) === iterator) {
      attachments.delete(attachment.ack.ptyId);
    }
    await iterator.return?.();
    logger.onEvent?.("agent.detach", { ptyId: attachment.ack.ptyId });
  }
}

function fail(
  connection: NdjsonConnection,
  logger: HostServerLogger,
  id: string,
  code: "HOST_BAD_REQUEST",
  message: string,
): void {
  const safeError = stationHostErrorFromUnknown(undefined, { code, message });
  logger.onError?.(safeError);
  connection.send(hostFailure(id, safeError));
}

function requestId(message: unknown): string {
  if (
    message !== null &&
    typeof message === "object" &&
    "id" in message &&
    typeof (message as { id: unknown }).id === "string"
  ) {
    return (message as { id: string }).id;
  }
  return "unknown";
}
