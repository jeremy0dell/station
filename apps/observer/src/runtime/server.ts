import type { ObserverApi, SafeError } from "@station/contracts";
import {
  createObserverClient,
  type ProtocolMethod,
  probeUnixSocket,
  readUnixSocketHolderPids,
  startProtocolServer,
  type UnixSocketProbe,
  type UnixSocketProbeOptions,
  type UnixSocketServer,
  unixSocketHolderEvidencePath,
} from "@station/protocol";
import { type RuntimeClock, runRuntimeBoundary, systemClock } from "@station/runtime";
import type { ObserverIncumbentLifecycle } from "./observerHandoff.js";

const DEFAULT_SOCKET_PROBE_TIMEOUT_MS = 1000;
const MIN_SOCKET_PROBE_TIMEOUT_MS = 1;

export type ObserverServer = {
  readonly socketPath: string;
  close(): Promise<void>;
  abandon(): void;
};

export type StartObserverServerOptions = {
  socketPath: string;
  api: ObserverApi;
  clock?: RuntimeClock;
  drainOnStart?: boolean;
  /** Rejects application operations that were not admitted before shutdown. */
  guardOperation?: () => void;
};

export type ObserverSocketProbe =
  | Exclude<UnixSocketProbe, { status: "inaccessible" }>
  | {
      status: "inaccessible";
      reason: Extract<UnixSocketProbe, { status: "inaccessible" }>["reason"];
      error: SafeError;
    };

/**
 * ADAPTER
 *
 * Translates four-state Unix-socket evidence into Observer ownership states and
 * an actionable inaccessible-socket diagnostic.
 */
export async function probeObserverSocket(
  socketPath: string,
  options: Pick<UnixSocketProbeOptions, "socketHolders" | "timeoutMs"> = {},
): Promise<ObserverSocketProbe> {
  const probeOptions: UnixSocketProbeOptions = {
    timeoutMs: Math.max(
      MIN_SOCKET_PROBE_TIMEOUT_MS,
      Math.min(
        options.timeoutMs ?? DEFAULT_SOCKET_PROBE_TIMEOUT_MS,
        DEFAULT_SOCKET_PROBE_TIMEOUT_MS,
      ),
    ),
  };
  if (options.socketHolders !== undefined) probeOptions.socketHolders = options.socketHolders;
  const probe = await probeUnixSocket(socketPath, probeOptions);
  if (probe.status !== "inaccessible") return probe;
  return {
    status: "inaccessible",
    reason: probe.reason,
    error: observerSocketInaccessibleError(socketPath),
  };
}

export function readObserverSocketHolderPids(socketPath: string): number[] {
  return readUnixSocketHolderPids(socketPath);
}

/**
 * ADAPTER
 *
 * Translates build-aware incumbent lifecycle requests into validated local
 * protocol calls; false means proven release while inaccessible probes throw.
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
    socketListening: async (socketPath, request) => {
      const probe = await probeObserverSocket(socketPath, {
        timeoutMs: requestTimeout(request.timeoutMs),
      });
      if (probe.status === "inaccessible") throw probe.error;
      return probe.status === "listening";
    },
  };
}

/**
 * ADAPTER
 *
 * Owns the Observer protocol socket lifecycle, including owned close versus
 * displaced abandon, and enforces admission before application operations.
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
    abandon: () => server.abandon(),
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

export function observerSocketInaccessibleError(socketPath: string): SafeError {
  const evidencePath = unixSocketHolderEvidencePath();
  return {
    tag: "ObserverSocketError",
    code: "OBSERVER_SOCKET_INACCESSIBLE",
    message: "The Observer socket exists but cannot be reached or proven safe to reclaim.",
    hint: `Restore access to ${socketPath}, normally mode 0600. Station will not reclaim it without holder evidence from ${evidencePath}; install lsof if that executable is missing (Debian/Ubuntu: sudo apt-get install lsof; Fedora/RHEL: sudo dnf install lsof). Retry, or use an isolated socket and state directory. Do not unlink it or trust its pidfile as liveness proof.`,
  };
}
