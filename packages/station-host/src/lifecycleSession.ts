import type { HostHandoffFidelity, PtyHandoffManifest, SafeError } from "@station/contracts";
import { connectUnixSocket, type NdjsonConnection } from "@station/protocol";
import { runRuntimeBoundaryWithTimeout } from "@station/runtime";
import { createHostClientIdentity } from "./clientIdentity.js";
import { stationHostErrorFromUnknown, stationHostSafeError } from "./errors.js";
import {
  type HostAbortHandoffResult,
  HostAbortHandoffResultSchema,
  type HostBeginHandoffResult,
  HostBeginHandoffResultSchema,
  type HostCompleteHandoffResult,
  HostCompleteHandoffResultSchema,
  type HostHealthResult,
  HostHealthResultSchema,
  type HostRecoveryInventoryResult,
  HostRecoveryInventoryResultSchema,
  type HostResponse,
  HostResponseSchema,
  type HostStopIfIdleResult,
  HostStopIfIdleResultSchema,
  hostRequest,
} from "./protocol.js";

export type HostBeginHandoffOutcome =
  | { status: "accepted"; result: HostBeginHandoffResult }
  | { status: "refused"; error: SafeError }
  | { status: "malformed-success"; error: SafeError };

export type StationHostLifecycleSession = {
  health(): Promise<HostHealthResult>;
  recoveryInventory(): Promise<HostRecoveryInventoryResult>;
  stopIfIdle(requestingBuildVersion: string): Promise<HostStopIfIdleResult>;
  beginHandoff(
    requestingBuildVersion: string,
    fidelity: HostHandoffFidelity,
  ): Promise<HostBeginHandoffOutcome>;
  completeHandoff(): Promise<HostCompleteHandoffResult>;
  abortHandoff(): Promise<HostAbortHandoffResult>;
  adoptRegistry(manifest: PtyHandoffManifest): Promise<HostAbortHandoffResult>;
  dispose(): void;
};

export type OpenStationHostLifecycleSessionOptions = {
  socketPath: string;
  expectedBuildVersion: string;
  deadlineMs: number;
  signal?: AbortSignal;
  connect?: (socketPath: string, timeoutMs: number) => Promise<NdjsonConnection>;
};

const requestFailure = (message: string) => stationHostSafeError("HOST_REQUEST_FAILED", message);

/**
 * ADAPTER
 *
 * Opens one non-reconnecting lifecycle client whose requests share one absolute deadline and
 * physical NDJSON connection. Correlation failures poison it; malformed begin success permits
 * only a same-connection abort before disposal.
 */
export async function openStationHostLifecycleSession(
  options: OpenStationHostLifecycleSessionOptions,
): Promise<StationHostLifecycleSession> {
  const socketPath = options.socketPath;
  const deadlineMs = options.deadlineMs;
  const signal = options.signal;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= Date.now() || signal?.aborted) {
    throw requestFailure("Station Host lifecycle authority expired before connection.");
  }
  const connect = options.connect ?? ((path, timeoutMs) => connectUnixSocket(path, { timeoutMs }));
  let connection: NdjsonConnection;
  try {
    connection = await connect(socketPath, Math.max(1, deadlineMs - Date.now()));
  } catch (error) {
    throw stationHostErrorFromUnknown(error, {
      code: "HOST_UNREACHABLE",
      message: "Could not open the Station Host lifecycle session.",
    });
  }
  if (deadlineMs <= Date.now() || signal?.aborted) {
    connection.close();
    throw requestFailure("Station Host lifecycle authority expired during connection.");
  }
  const identity = createHostClientIdentity(options.expectedBuildVersion);
  const iterator = connection.messages()[Symbol.asyncIterator]();
  let nextId = 0;
  let disposed = false;
  let inFlight = false;
  let malformedBegin = false;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    connection.close();
  };

  async function receive(): Promise<unknown> {
    if (deadlineMs <= Date.now() || signal?.aborted) {
      dispose();
      throw requestFailure("Station Host lifecycle deadline was exceeded.");
    }
    const expiration = requestFailure("Station Host lifecycle deadline was exceeded.");
    try {
      const received = await runRuntimeBoundaryWithTimeout(
        {
          operation: "stationHost.lifecycle.receive",
          timeoutMs: Math.max(1, deadlineMs - Date.now()),
          error: expiration,
          timeoutError: expiration,
        },
        async ({ signal: timeoutSignal }) => {
          const close = () => connection.close();
          timeoutSignal.addEventListener("abort", close, { once: true });
          signal?.addEventListener("abort", close, { once: true });
          try {
            return await iterator.next();
          } finally {
            timeoutSignal.removeEventListener("abort", close);
            signal?.removeEventListener("abort", close);
          }
        },
      );
      if (!received.ok) throw received.error;
      const next = received.value;
      if (next.done || deadlineMs <= Date.now() || signal?.aborted) {
        throw requestFailure("Station Host lifecycle connection closed or expired.");
      }
      return next.value;
    } catch (error) {
      dispose();
      throw error;
    }
  }

  async function exchange(
    method: string,
    params: unknown,
    includeIdentity = false,
    allowMalformedBeginAbort = false,
  ): Promise<HostResponse> {
    if (deadlineMs <= Date.now() || signal?.aborted) {
      dispose();
      throw requestFailure("Station Host lifecycle deadline was exceeded.");
    }
    if (disposed || (malformedBegin && !allowMalformedBeginAbort) || inFlight) {
      throw requestFailure("Station Host lifecycle session is no longer usable.");
    }
    inFlight = true;
    const id = `l${nextId++}`;
    try {
      try {
        connection.send(hostRequest(id, method, params, includeIdentity ? identity : undefined));
      } catch {
        dispose();
        throw requestFailure("Station Host lifecycle request could not be sent.");
      }
      const parsed = HostResponseSchema.safeParse(await receive());
      if (!parsed.success || parsed.data.id !== id) {
        dispose();
        throw requestFailure("Station Host lifecycle response correlation failed.");
      }
      return parsed.data;
    } finally {
      inFlight = false;
    }
  }

  async function request<T>(
    method: string,
    params: unknown,
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
    includeIdentity = false,
    allowMalformedBeginAbort = false,
  ): Promise<T> {
    const response = await exchange(method, params, includeIdentity, allowMalformedBeginAbort);
    if (!response.ok) throw response.error;
    const parsed = schema.safeParse(response.result);
    if (!parsed.success) {
      dispose();
      throw requestFailure(`Station Host returned malformed lifecycle evidence for "${method}".`);
    }
    return parsed.data;
  }

  return {
    health: () => request("host.health", undefined, HostHealthResultSchema),
    recoveryInventory: () =>
      request("host.recoveryInventory", undefined, HostRecoveryInventoryResultSchema, true),
    stopIfIdle: (requestingBuildVersion) =>
      request("host.stopIfIdle", { requestingBuildVersion }, HostStopIfIdleResultSchema),
    beginHandoff: async (requestingBuildVersion, fidelity) => {
      const response = await exchange("host.beginHandoff", { requestingBuildVersion, fidelity });
      if (!response.ok) return { status: "refused", error: response.error };
      const parsed = HostBeginHandoffResultSchema.safeParse(response.result);
      if (!parsed.success) {
        malformedBegin = true;
        return {
          status: "malformed-success",
          error: requestFailure("Station Host returned malformed successful handoff evidence."),
        };
      }
      return { status: "accepted", result: parsed.data };
    },
    completeHandoff: () =>
      request("host.completeHandoff", undefined, HostCompleteHandoffResultSchema),
    abortHandoff: async () => {
      const result = await request(
        "host.abortHandoff",
        undefined,
        HostAbortHandoffResultSchema,
        false,
        true,
      );
      malformedBegin = false;
      return result;
    },
    adoptRegistry: (manifest) =>
      request("host.adoptRegistry", { manifest }, HostAbortHandoffResultSchema, true),
    dispose,
  };
}
