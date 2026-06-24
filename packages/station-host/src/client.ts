import { connectUnixSocket, type NdjsonConnection } from "@station/protocol";
import type { z } from "zod";
import { StationHostProviderError, stationHostErrorFromUnknown } from "./errors.js";
import {
  type HostAttachAck,
  HostAttachAckSchema,
  HostCloseResultSchema,
  type HostFrame,
  HostFrameSchema,
  HostHealthResultSchema,
  HostListResultSchema,
  HostOkResultSchema,
  type HostPtyIdentity,
  type HostPtyKind,
  type HostResponse,
  HostResponseSchema,
  type HostSpawnResult,
  HostSpawnResultSchema,
  hostRequest,
} from "./protocol.js";

export type StationHostClientOptions = {
  socketPath: string;
  timeoutMs?: number;
  /** Test seam: supply a connection instead of dialing the unix socket. */
  connect?: () => Promise<NdjsonConnection>;
};

/** A live attachment to one host PTY: a frame stream plus input/teardown. */
export type HostAttachment = {
  ack: HostAttachAck;
  frames: AsyncIterable<HostFrame>;
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  detach(): Promise<void>;
};

export type StationHostClient = {
  health(): Promise<{ ok: true; protocolVersion: number }>;
  spawn(params: HostSpawnParamsInput): Promise<HostSpawnResult>;
  write(ptyId: string, data: string): Promise<void>;
  resize(ptyId: string, cols: number, rows: number): Promise<void>;
  list(): Promise<HostListResult["ptys"]>;
  focus(ptyId: string): Promise<void>;
  close(ptyId: string): Promise<{ closed: boolean }>;
  attach(ptyId: string): Promise<HostAttachment>;
  dispose(): void;
};

type HostListResult = z.infer<typeof HostListResultSchema>;
export type HostSpawnParamsInput = Omit<HostPtyIdentity, "kind"> & {
  // Optional on input: the schema defaults it to "agent", so existing agent
  // spawns omit it and only Station-owned aux shells pass "aux".
  kind?: HostPtyKind;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd: string;
  cols: number;
  rows: number;
};

type Pending = {
  resolve: (response: HostResponse) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

type FrameSink = {
  push(frame: HostFrame): void;
  end(): void;
};

const defaultTimeoutMs = 5000;

export function createStationHostClient(options: StationHostClientOptions): StationHostClient {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const pending = new Map<string, Pending>();
  const sinks = new Map<string, FrameSink>();
  let connection: NdjsonConnection | undefined;
  let connecting: Promise<NdjsonConnection> | undefined;
  let disposed = false;
  let nextId = 0;

  const connect = options.connect ?? (() => connectUnixSocket(options.socketPath, { timeoutMs }));

  function teardown(error: unknown): void {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
    for (const sink of sinks.values()) {
      sink.end();
    }
    sinks.clear();
    connection = undefined;
    connecting = undefined;
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

  async function request<TResult>(
    method: string,
    params: unknown,
    schema: { parse(value: unknown): TResult },
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
      active.send(hostRequest(id, method, params));
    });
    if (!response.ok) {
      throw response.error;
    }
    return schema.parse(response.result);
  }

  function registerSink(ptyId: string): AsyncIterable<HostFrame> {
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
    sinks.set(ptyId, {
      push: (frame) => {
        queue.push(frame);
        drain();
      },
      end: () => {
        ended = true;
        drain();
      },
    });
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
          ended = true;
          drain();
          return Promise.resolve({ done: true, value: undefined });
        },
      }),
    };
  }

  return {
    health: () => request("host.health", undefined, HostHealthResultSchema),
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
    attach: async (ptyId) => {
      const frames = registerSink(ptyId);
      let ack: HostAttachAck;
      try {
        ack = await request("host.attach", { ptyId }, HostAttachAckSchema);
      } catch (error) {
        sinks.delete(ptyId);
        throw error;
      }
      return {
        ack,
        frames,
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
            await request("host.detach", { ptyId }, HostOkResultSchema);
          } finally {
            const sink = sinks.get(ptyId);
            sinks.delete(ptyId);
            sink?.end();
          }
        },
      };
    },
    dispose: () => {
      disposed = true;
      const current = connection;
      teardown(
        new StationHostProviderError("HOST_UNREACHABLE", "Station host client is disposed."),
      );
      current?.close();
    },
  };
}
