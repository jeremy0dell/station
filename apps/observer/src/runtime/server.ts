import { lstat } from "node:fs/promises";
import type { ObserverApi } from "@station/contracts";
import { connectUnixSocket, startProtocolServer, type UnixSocketServer } from "@station/protocol";
import { type RuntimeClock, runRuntimeBoundary, systemClock } from "@station/runtime";

export type ObserverServer = {
  readonly socketPath: string;
  close(): Promise<void>;
};

export type StartObserverServerOptions = {
  socketPath: string;
  api: ObserverApi;
  clock?: RuntimeClock;
  drainOnStart?: boolean;
};

export type ObserverSocketProbe = "absent" | "stale" | "listening";

/**
 * ADAPTER
 *
 * Translates local Unix-socket transport evidence into the boot states used by
 * Observer composition without exposing connection mechanics there.
 */
export async function probeObserverSocket(socketPath: string): Promise<ObserverSocketProbe> {
  const initial = await socketMetadata(socketPath);
  if (initial === undefined) {
    return "absent";
  }
  if (!initial.isSocket()) {
    return "stale";
  }

  try {
    const connection = await connectUnixSocket(socketPath, { timeoutMs: 1000 });
    connection.close();
    return "listening";
  } catch {
    return (await socketMetadata(socketPath)) === undefined ? "absent" : "stale";
  }
}

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
    () => startProtocolServer({ socketPath: options.socketPath, api: options.api }),
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
