import { randomUUID } from "node:crypto";
import type { HostHandoffFidelity, PtyHandoffManifest, UiRunContext } from "@station/contracts";
import { connectUnixSocket, type NdjsonConnection } from "@station/protocol";
import { stationBuildInfo } from "@station/runtime";
import type { z } from "zod";
import {
  assertHostReusable,
  StationHostProviderError,
  stationHostErrorFromUnknown,
} from "./errors.js";
import {
  HOST_PROTOCOL_VERSION,
  type HostAbortHandoffResult,
  HostAbortHandoffResultSchema,
  type HostAdoptRegistryResult,
  HostAdoptRegistryResultSchema,
  type HostAttachAck,
  HostAttachAckSchema,
  type HostBeginHandoffResult,
  HostBeginHandoffResultSchema,
  type HostClientIdentity,
  HostClientIdentitySchema,
  HostCloseResultSchema,
  type HostCompleteHandoffResult,
  HostCompleteHandoffResultSchema,
  type HostFrame,
  HostFrameSchema,
  type HostHealthResult,
  HostHealthResultSchema,
  HostListResultSchema,
  HostOkResultSchema,
  type HostPtyAttachExpectation,
  type HostPtyIdentity,
  type HostPtyKind,
  type HostPtyRef,
  type HostResponse,
  HostResponseSchema,
  type HostSpawnParams,
  type HostSpawnResult,
  HostSpawnResultSchema,
  type HostStopIfIdleResult,
  HostStopIfIdleResultSchema,
  hostClientShutdownNotification,
  hostRequest,
  isSameHostPtyIdentity,
  isSameHostPtyRef,
} from "./protocol.js";

export type StationHostClientOptions = {
  socketPath: string;
  timeoutMs?: number;
  /** Build expected by operational calls; defaults to this Station build. */
  expectedBuildVersion?: string;
  /** Cross-process UI identity captured once by renderer composition. */
  uiContext?: UiRunContext;
  /** Test seam for deterministic protocol assertions. */
  connectionId?: string;
  /** Test seam: supply a connection instead of dialing the unix socket. */
  connect?: () => Promise<NdjsonConnection>;
};

/**
 * One successful attachment attempt to an exact Host PTY lifetime. Its frame
 * iterator and detach operation release only this attempt, even after replacement.
 */
export type HostAttachment = {
  attachmentId: string;
  ack: HostAttachAck;
  frames: AsyncIterable<HostFrame>;
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  detach(): Promise<void>;
};

export type StationHostClient = {
  health(): Promise<HostHealthResult>;
  /** Lifecycle-only request; intentionally available before compatibility is established. */
  stopIfIdle(requestingBuildVersion: string): Promise<HostStopIfIdleResult>;
  /** Lifecycle-only negotiated live handoff begin; parks bridges and returns the manifest. */
  beginHandoff(
    requestingBuildVersion: string,
    fidelity?: HostHandoffFidelity,
  ): Promise<HostBeginHandoffResult>;
  /** Lifecycle-only: release the socket and exit without disposing parked bridges. */
  completeHandoff(): Promise<HostCompleteHandoffResult>;
  /** Lifecycle-only: re-adopt parked bridges and resume normal serving. */
  abortHandoff(): Promise<HostAbortHandoffResult>;
  /** Lifecycle-only: adopt a parked manifest on a successor host. */
  adoptRegistry(manifest: PtyHandoffManifest): Promise<HostAdoptRegistryResult>;
  spawn(params: HostSpawnParamsInput): Promise<HostSpawnResult>;
  write(ptyId: string, data: string): Promise<void>;
  resize(ptyId: string, cols: number, rows: number): Promise<void>;
  list(): Promise<HostListResult["ptys"]>;
  focus(ptyId: string): Promise<void>;
  close(ptyId: string): Promise<{ closed: boolean }>;
  /** Attach only when the acknowledgement matches the complete client-held identity proof. */
  attach(expectation: HostPtyAttachExpectation): Promise<HostAttachment>;
  /** Send a one-way shutdown notification, then gracefully close the connection. */
  dispose(): void;
};

type HostListResult = z.infer<typeof HostListResultSchema>;
/** Host spawn contract with defaulted kind and absent-by-default output compatibility. */
export type HostSpawnParamsInput = Omit<HostSpawnParams, "kind"> & {
  // Optional on input: existing agent spawns omit it and only Station-owned aux shells pass "aux".
  kind?: HostPtyKind;
};

type Pending = {
  resolve: (response: HostResponse) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

type FrameSink = {
  readonly frames: AsyncIterable<HostFrame>;
  readonly ended: boolean;
  push(frame: HostFrame): void;
  end(): void;
  release(): void;
};

const defaultTimeoutMs = 5000;

export function createStationHostClient(options: StationHostClientOptions): StationHostClient {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const expectedBuildVersion = options.expectedBuildVersion ?? stationBuildInfo().version;
  const pending = new Map<string, Pending>();
  const sinks = new Map<string, FrameSink>();
  const allSinks = new Set<FrameSink>();
  let connection: NdjsonConnection | undefined;
  let connecting: Promise<NdjsonConnection> | undefined;
  let compatibilityCheck: Promise<void> | undefined;
  let clientIdentity: HostClientIdentity | undefined;
  let disposed = false;
  let nextId = 0;

  const connect = options.connect ?? (() => connectUnixSocket(options.socketPath, { timeoutMs }));

  function teardown(error: unknown): void {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
    for (const sink of allSinks) {
      sink.end();
    }
    sinks.clear();
    connection = undefined;
    connecting = undefined;
    compatibilityCheck = undefined;
    clientIdentity = undefined;
  }

  async function readLoop(active: NdjsonConnection): Promise<void> {
    try {
      for await (const message of active.messages()) {
        const response = HostResponseSchema.safeParse(message);
        if (response.success) {
          const entry = pending.get(response.data.id);
          if (entry !== undefined) {
            clearTimeout(entry.timer);
            pending.delete(response.data.id);
            entry.resolve(response.data);
          }
          continue;
        }
        const frame = HostFrameSchema.safeParse(message);
        if (frame.success) {
          sinks.get(frame.data.ptyId)?.push(frame.data);
        }
      }
      teardown(
        stationHostErrorFromUnknown(undefined, {
          code: "HOST_UNREACHABLE",
          message: "Station host connection closed.",
        }),
      );
    } catch (cause) {
      teardown(
        stationHostErrorFromUnknown(cause, {
          code: "HOST_UNREACHABLE",
          message: "Station host connection failed.",
        }),
      );
    }
  }

  async function ensureConnection(): Promise<NdjsonConnection> {
    if (disposed) {
      throw new StationHostProviderError("HOST_UNREACHABLE", "Station host client is disposed.");
    }
    if (connection !== undefined) {
      return connection;
    }
    if (connecting === undefined) {
      clientIdentity = createClientIdentity(options, expectedBuildVersion);
      connecting = connect()
        .then((opened) => {
          if (disposed) {
            // dispose() raced the connect: close the socket we just opened and do
            // not start the read loop, or it leaks for the process lifetime.
            opened.close();
            throw new StationHostProviderError(
              "HOST_UNREACHABLE",
              "Station host client is disposed.",
            );
          }
          connection = opened;
          void readLoop(opened);
          return opened;
        })
        .catch((cause) => {
          connecting = undefined;
          throw stationHostErrorFromUnknown(cause, {
            code: "HOST_UNREACHABLE",
            message: "Could not reach the station host.",
          });
        });
    }
    return connecting;
  }

  async function rawRequest<TResult>(
    method: string,
    params: unknown,
    schema: { parse(value: unknown): TResult },
    includeClientIdentity = false,
  ): Promise<TResult> {
    const active = await ensureConnection();
    const id = `h${nextId++}`;
    const response = await new Promise<HostResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new StationHostProviderError(
            "HOST_REQUEST_FAILED",
            `Station host request "${method}" timed out.`,
          ),
        );
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      active.send(
        hostRequest(id, method, params, includeClientIdentity ? clientIdentity : undefined),
      );
    });
    if (!response.ok) {
      throw response.error;
    }
    return schema.parse(response.result);
  }

  function ensureCompatible(): Promise<void> {
    if (compatibilityCheck === undefined) {
      const check = rawRequest("host.health", undefined, HostHealthResultSchema).then((health) => {
        assertHostReusable(health, expectedBuildVersion);
      });
      compatibilityCheck = check;
      // A failed preflight may precede host startup, so only a successful
      // handshake remains memoized for this connection lifecycle.
      void check.catch(() => {
        if (compatibilityCheck === check) {
          compatibilityCheck = undefined;
        }
      });
    }
    return compatibilityCheck;
  }

  async function request<TResult>(
    method: string,
    params: unknown,
    schema: { parse(value: unknown): TResult },
  ): Promise<TResult> {
    await ensureCompatible();
    return rawRequest(method, params, schema, true);
  }

  function createSink(ptyId: string): FrameSink {
    const queue: HostFrame[] = [];
    const waiters: Array<(result: IteratorResult<HostFrame>) => void> = [];
    let ended = false;
    const drain = () => {
      while (waiters.length > 0 && (queue.length > 0 || ended)) {
        const waiter = waiters.shift();
        if (waiter === undefined) break;
        const next = queue.shift();
        waiter(
          next === undefined ? { done: true, value: undefined } : { done: false, value: next },
        );
      }
    };
    const sink: FrameSink = {
      get frames() {
        return {
          [Symbol.asyncIterator]: () => ({
            next: () =>
              new Promise<IteratorResult<HostFrame>>((resolve) => {
                if (queue.length > 0) {
                  const next = queue.shift();
                  resolve(
                    next === undefined
                      ? { done: true, value: undefined }
                      : { done: false, value: next },
                  );
                  return;
                }
                if (ended) {
                  resolve({ done: true, value: undefined });
                  return;
                }
                waiters.push(resolve);
              }),
            return: () => {
              sink.release();
              return Promise.resolve({ done: true as const, value: undefined });
            },
          }),
        };
      },
      get ended() {
        return ended;
      },
      push: (frame) => {
        if (ended) {
          return;
        }
        queue.push(frame);
        drain();
      },
      end: () => {
        if (ended) {
          return;
        }
        ended = true;
        allSinks.delete(sink);
        drain();
      },
      release: () => {
        if (sinks.get(ptyId) === sink) {
          sinks.delete(ptyId);
        }
        sink.end();
      },
    };
    allSinks.add(sink);
    return sink;
  }

  return {
    health: () => rawRequest("host.health", undefined, HostHealthResultSchema),
    stopIfIdle: (requestingBuildVersion) =>
      rawRequest("host.stopIfIdle", { requestingBuildVersion }, HostStopIfIdleResultSchema),
    beginHandoff: (requestingBuildVersion, fidelity = "processes") =>
      rawRequest(
        "host.beginHandoff",
        { requestingBuildVersion, fidelity },
        HostBeginHandoffResultSchema,
      ),
    completeHandoff: () =>
      rawRequest("host.completeHandoff", undefined, HostCompleteHandoffResultSchema),
    abortHandoff: () => rawRequest("host.abortHandoff", undefined, HostAbortHandoffResultSchema),
    // Successor adopt requires matching build identity; not a lifecycle exemption.
    adoptRegistry: (manifest) =>
      request("host.adoptRegistry", { manifest }, HostAdoptRegistryResultSchema),
    spawn: (params) => request("host.spawn", params, HostSpawnResultSchema),
    write: async (ptyId, data) => {
      await request("host.write", { ptyId, data }, HostOkResultSchema);
    },
    resize: async (ptyId, cols, rows) => {
      await request("host.resize", { ptyId, cols, rows }, HostOkResultSchema);
    },
    list: async () => (await request("host.list", undefined, HostListResultSchema)).ptys,
    focus: async (ptyId) => {
      await request("host.focus", { ptyId }, HostOkResultSchema);
    },
    close: (ptyId) => request("host.close", { ptyId, confirm: true }, HostCloseResultSchema),
    attach: async (expectation) => {
      const requestedRef: HostPtyRef = {
        terminalTargetId: expectation.terminalTargetId,
        ptyId: expectation.ptyId,
        ptyInstanceId: expectation.ptyInstanceId,
      };
      const requestedIdentity: HostPtyIdentity = {
        kind: expectation.kind,
        terminalTargetId: expectation.terminalTargetId,
        worktreeId: expectation.worktreeId,
        projectId: expectation.projectId,
        sessionId: expectation.sessionId,
        worktreePath: expectation.worktreePath,
        harnessProvider: expectation.harnessProvider,
      };
      const { ptyId } = requestedRef;
      const attachmentId = `att_${randomUUID()}`;
      const sink = createSink(ptyId);
      let ack: HostAttachAck;
      try {
        ack = await request("host.attach", { ...requestedRef, attachmentId }, HostAttachAckSchema);
      } catch (error) {
        sink.release();
        throw error;
      }
      if (!isSameHostPtyRef(requestedRef, ack) || !isSameHostPtyIdentity(requestedIdentity, ack)) {
        try {
          await request(
            "host.detach",
            { ptyId, attachmentId, reason: "explicit_detach" },
            HostOkResultSchema,
          );
        } catch {
          // Best-effort cleanup: the mismatch remains the authoritative failure.
        } finally {
          sink.release();
        }
        throw new StationHostProviderError(
          "HOST_ATTACHMENT_MISMATCH",
          "Station host acknowledged a different PTY identity than the client expected.",
        );
      }
      // The server acknowledges before it can send frames, so routing starts only after validation.
      sinks.get(ptyId)?.release();
      if (!sink.ended) {
        sinks.set(ptyId, sink);
      }
      return {
        attachmentId,
        ack,
        frames: sink.frames,
        write: async (data) => {
          await request("host.write", { ptyId, data }, HostOkResultSchema);
        },
        resize: async (cols, rows) => {
          await request("host.resize", { ptyId, cols, rows }, HostOkResultSchema);
        },
        detach: async () => {
          // Ask the host to detach first, then release the local sink — but always
          // end it (finally) so a failed/closed request can't leave frames hanging.
          try {
            await request(
              "host.detach",
              { ptyId, attachmentId, reason: "explicit_detach" },
              HostOkResultSchema,
            );
          } finally {
            sink.release();
          }
        },
      };
    },
    dispose: () => {
      disposed = true;
      const current = connection;
      const identity = clientIdentity;
      if (current !== undefined && identity !== undefined) {
        current.send(hostClientShutdownNotification(identity));
      }
      teardown(
        new StationHostProviderError("HOST_UNREACHABLE", "Station host client is disposed."),
      );
      current?.close();
    },
  };
}

function createClientIdentity(
  options: StationHostClientOptions,
  buildVersion: string,
): HostClientIdentity {
  const uiContext = options.uiContext ?? {
    uiRunId: `ui_${randomUUID()}`,
    rendererPid: process.pid,
    clientKind: "host_tool" as const,
  };
  return HostClientIdentitySchema.parse({
    protocolVersion: HOST_PROTOCOL_VERSION,
    buildVersion,
    ...uiContext,
    connectionId: options.connectionId ?? `conn_${randomUUID()}`,
  });
}
