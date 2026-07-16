import { lstat } from "node:fs/promises";
import type { ObserverApi } from "@station/contracts";
import {
  connectUnixSocket,
  createObserverClient,
  type ProtocolMethod,
  startProtocolServer,
  type UnixSocketServer,
} from "@station/protocol";
import { type RuntimeClock, runRuntimeBoundary, systemClock } from "@station/runtime";
import type { ObserverIncumbentLifecycle } from "./observerHandoff.js";

const DEFAULT_SOCKET_PROBE_TIMEOUT_MS = 1000;
const MIN_SOCKET_PROBE_TIMEOUT_MS = 1;

export type ObserverServer = {
  readonly socketPath: string;
  close(): Promise<void>;
};

export type StartObserverServerOptions = {
  socketPath: string;
  api: ObserverApi;
  clock?: RuntimeClock;
  drainOnStart?: boolean;
  /** Rejects application operations that were not admitted before shutdown. */
  guardOperation?: () => void;
};

export type ObserverSocketProbe = "absent" | "stale" | "listening";

/**
 * ADAPTER
 *
 * Translates local Unix-socket transport evidence into the boot states used by
 * Observer composition without exposing connection mechanics there.
 */
export async function probeObserverSocket(
  socketPath: string,
  options: { timeoutMs?: number } = {},
): Promise<ObserverSocketProbe> {
  const initial = await socketMetadata(socketPath);
  if (initial === undefined) {
    return "absent";
  }
  if (!initial.isSocket()) {
    return "stale";
  }

  try {
    const connection = await connectUnixSocket(socketPath, {
      timeoutMs: Math.max(
        MIN_SOCKET_PROBE_TIMEOUT_MS,
        Math.min(
          options.timeoutMs ?? DEFAULT_SOCKET_PROBE_TIMEOUT_MS,
          DEFAULT_SOCKET_PROBE_TIMEOUT_MS,
        ),
      ),
    });
    connection.close();
    return "listening";
  } catch {
    return (await socketMetadata(socketPath)) === undefined ? "absent" : "stale";
  }
}

/**
 * ADAPTER
 *
 * Translates build-aware incumbent lifecycle requests into validated local
 * protocol calls and socket probes.
 */
export function createObserverLifecycleClient(options: {
  timeoutMs: number;
}): ObserverIncumbentLifecycle {
  const requestTimeout = (requestedTimeoutMs: number) =>
    Math.max(MIN_SOCKET_PROBE_TIMEOUT_MS, Math.min(options.timeoutMs, requestedTimeoutMs));
  return {
    health: (socketPath, request) =>
      createObserverClient({
        socketPath,
        timeoutMs: requestTimeout(request.timeoutMs),
      }).health(),
    stop: (socketPath, request) =>
      createObserverClient({
        socketPath,
        timeoutMs: requestTimeout(request.timeoutMs),
        expectedObserverIdentity: request.expectedObserver,
      }).stop(),
    socketListening: async (socketPath, request) =>
      (await probeObserverSocket(socketPath, {
        timeoutMs: requestTimeout(request.timeoutMs),
      })) === "listening",
  };
}

/**
 * ADAPTER
 *
 * Owns the Observer protocol socket lifecycle and enforces the runtime's
 * admission policy before application operations cross the transport boundary.
 */
export async function startObserverServer(
  options: StartObserverServerOptions,
): Promise<ObserverServer> {
  const clock = options.clock ?? systemClock;
  const started = await runRuntimeBoundary(
    {
      operation: "observer.server.start",
      clock,
      error: {
        tag: "ObserverServerError",
        code: "OBSERVER_SERVER_START_FAILED",
        message: "Observer protocol server could not start.",
      },
    },
    () =>
      startProtocolServer({
        socketPath: options.socketPath,
        api: options.api,
        ...(options.guardOperation === undefined
          ? {}
          : { requestGuard: lifecycleRequestGuard(options.guardOperation) }),
      }),
  );

  if (!started.ok) {
    throw started.error;
  }

  const server = started.value;
  if (options.drainOnStart !== false) {
    await options.api.reconcile("observer.startup");
  }

  return {
    socketPath: options.socketPath,
    close: () => closeObserverServer(server, clock),
  };
}

function lifecycleRequestGuard(guardOperation: () => void): (method: ProtocolMethod) => void {
  return (method) => {
    if (method !== "observer.health" && method !== "observer.stop") {
      guardOperation();
    }
  };
}

async function closeObserverServer(server: UnixSocketServer, clock: RuntimeClock): Promise<void> {
  const closed = await runRuntimeBoundary(
    {
      operation: "observer.server.stop",
      clock,
      error: {
        tag: "ObserverServerError",
        code: "OBSERVER_SERVER_STOP_FAILED",
        message: "Observer protocol server could not stop cleanly.",
      },
    },
    () => server.close(),
  );
  if (!closed.ok) {
    throw closed.error;
  }
}

async function socketMetadata(
  socketPath: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
