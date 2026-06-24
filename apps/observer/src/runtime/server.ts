import { type ObserverApi, startProtocolServer, type UnixSocketServer } from "@station/protocol";
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
