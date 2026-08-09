import { randomUUID } from "node:crypto";
import {
  componentLogPath,
  createJsonlLogger,
  createUiLifecycleRecorder,
  type JsonlLogger,
} from "@station/observability";
import { listenUnixSocket } from "@station/protocol";
import { stationBuildInfo } from "@station/runtime";
import {
  HOST_PROTOCOL_VERSION,
  HostAdoptRegistryParamsSchema,
  HostBeginHandoffParamsSchema,
  HostCloseParamsSchema,
  HostFocusParamsSchema,
  type HostClientIdentity,
  type HostHandlers,
  type HostPtyKind,
  HostSpawnParamsSchema,
  HostStopIfIdleParamsSchema,
  serveHostConnection,
} from "@station/host";
import { createHostHandoffSession } from "./hostHandoffSession.js";
import { createHostLifecycleWitness } from "./hostLifecycle.js";
import {
  ptyBridgesDirectory,
  reapStaleOrphanBridges,
  resolveOrphanTtlMs,
} from "./orphanBridges.js";
import {
  createPtyTable,
  type PtySpawnOutcome,
  type PtyTable,
  type PtyTableOptions,
} from "./ptyTable.js";
import {
  type PtyImplementation,
  resolvePtyImplementation,
} from "../terminal/pty/localPtyTerminal.js";

export type StartStationHostOptions = {
  socketPath: string;
  stateDir: string;
  logger?: JsonlLogger;
  ptyTableOptions?: PtyTableOptions;
  /** Prepared compiled runtimes supply the fixed selector reported at startup. */
  ptyImplementation?: PtyImplementation;
  /**
   * Test-only opaque build identity override for A/B upgrade lanes. Production
   * entrypoints leave this unset and use `stationBuildInfo().version`.
   */
  buildVersion?: string;
};

export type StationHostInstance = {
  socketPath: string;
  /** Resolves after the socket is closed, owned PTYs are disposed, and stop is logged. */
  readonly closed: Promise<void>;
  close(): Promise<void>;
};

type CloseReason = "requested" | "upgrade" | "handoff";

/**
 * The host owns PTYs independently of any client and answers
 * spawn/list + health. Attachment-scoped mutation is resolved by the server's
 * connection registry and enforced by the PTY table before reaching a child.
 * Typed PTY lifecycle is emitted directly at the table boundary, while shutdown
 * disposes owned PTYs and flushes evidence.
 */
export async function startStationHost(
  options: StartStationHostOptions,
): Promise<StationHostInstance> {
  const ptyImplementation =
    options.ptyImplementation ?? resolvePtyImplementation(process.env.STATION_PTY_IMPL);
  const buildVersion = options.buildVersion ?? stationBuildInfo().version;
  const orphanTtlMs = resolveOrphanTtlMs(process.env.STATION_PTY_ORPHAN_TTL_MS);
  const logger =
    options.logger ??
    createJsonlLogger({
      component: "station-host",
      path: componentLogPath(options.stateDir, "station-host"),
    });
  const lifecycle = createUiLifecycleRecorder({
    logger,
    component: "station-host",
    sourceId: `host_${process.pid}_${randomUUID()}`,
  });
  const hostLifecycle = createHostLifecycleWitness({ recorder: lifecycle });
  const logEvent = (message: string, attributes: Record<string, unknown>): void => {
    void logger.log({ level: "info", message, attributes });
  };

  await logger.log({
    level: "info",
    message: "host.start",
    attributes: {
      socketPath: options.socketPath,
      pid: process.pid,
      ptyImplementation,
      protocolVersion: HOST_PROTOCOL_VERSION,
      buildVersion,
      orphanTtlMs,
    },
  });

  // Clean-startup reap: stale park remains are unlinked before the socket
  // opens, while every live parked bridge is left for negotiated adoption.
  const orphanDirectory = ptyBridgesDirectory(options.stateDir);
  let reap = { reaped: 0, parked: 0 };
  try {
    reap = await reapStaleOrphanBridges(orphanDirectory);
  } catch (error) {
    logEvent("host.orphan-reap-failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  if (reap.reaped > 0 || reap.parked > 0) {
    logEvent("host.orphan-reap", { reaped: reap.reaped, parked: reap.parked });
  }

  const configuredOnEvent = options.ptyTableOptions?.onEvent;
  const configuredOnPtyExit = options.ptyTableOptions?.onPtyExit;
  const ptyTable = createPtyTable({
    ...options.ptyTableOptions,
    onEvent: (event, attributes) => {
      configuredOnEvent?.(event, attributes);
      logEvent(event, attributes);
    },
    onPtyExit: (event) => {
      configuredOnPtyExit?.(event);
      void hostLifecycle.ptyExited(event);
    },
    orphanBridges: {
      directory: orphanDirectory,
      ttlMs: orphanTtlMs,
    },
  });

  const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<void>();
  let closePromise: Promise<void> | undefined;
  let server: Awaited<ReturnType<typeof listenUnixSocket>>;

  const closeHost = (reason: CloseReason): Promise<void> => {
    if (closePromise !== undefined) {
      return closePromise;
    }
    closePromise = (async () => {
      try {
        await server.close();
      } finally {
        // Handoff already parked bridges and cleared the table; disposeAll would
        // only kill parks if any residual entries remained.
        if (reason !== "handoff") {
          ptyTable.disposeAll();
        }
        await logger.log({
          level: "info",
          message: "host.stop",
          attributes: { socketPath: options.socketPath, pid: process.pid, reason },
        });
        await hostLifecycle.flush();
      }
    })().finally(resolveClosed);
    return closePromise;
  };

  const handlers = buildHostHandlers({
    ptyTable,
    buildVersion,
    closeHost,
    onPtySpawned: (client, outcome, ptyKind) => {
      void hostLifecycle.ptySpawned(client, outcome, ptyKind);
    },
  });

  server = await listenUnixSocket({
    socketPath: options.socketPath,
    onConnection: (connection) =>
      serveHostConnection(connection, handlers, {
        onError: (error) => {
          void logger.log({
            level: "warn",
            message: "host.error",
            attributes: { code: error.code },
          });
        },
        onEvent: logEvent,
        onLifecycle: (event) => {
          void hostLifecycle.record(event);
        },
      }),
  });

  return {
    socketPath: server.socketPath,
    closed,
    close: () => closeHost("requested"),
  };
}

function buildHostHandlers(input: {
  ptyTable: PtyTable;
  buildVersion: string;
  closeHost: (reason: CloseReason) => Promise<void>;
  onPtySpawned: (
    client: HostClientIdentity,
    outcome: PtySpawnOutcome,
    ptyKind: HostPtyKind,
  ) => void;
}): HostHandlers {
  const { ptyTable, buildVersion, closeHost, onPtySpawned } = input;
  const handoff = createHostHandoffSession({ ptyTable, buildVersion });

  return {
    hostIdentity: { protocolVersion: HOST_PROTOCOL_VERSION, buildVersion },
    unary: {
      "host.health": () => ({
        ok: true as const,
        protocolVersion: HOST_PROTOCOL_VERSION,
        buildVersion,
      }),
      "host.stopIfIdle": (params) => {
        const { requestingBuildVersion } = HostStopIfIdleParamsSchema.parse(params);
        handoff.beginIdleDrain(requestingBuildVersion);
        return { stopping: true as const };
      },
      "host.beginHandoff": async (params) => {
        const { requestingBuildVersion, fidelity } = HostBeginHandoffParamsSchema.parse(params);
        return handoff.beginHandoff(requestingBuildVersion, fidelity);
      },
      "host.completeHandoff": () => handoff.completeHandoff(),
      "host.abortHandoff": () => handoff.abortHandoff(),
      "host.adoptRegistry": (params) => {
        const { manifest } = HostAdoptRegistryParamsSchema.parse(params);
        return handoff.adoptRegistry(manifest);
      },
      "host.spawn": (params, client) => {
        handoff.assertNotDraining();
        const parsed = HostSpawnParamsSchema.parse(params);
        const outcome = ptyTable.spawn(parsed);
        if (client !== undefined) {
          onPtySpawned(client, outcome, parsed.kind);
        }
        return {
          terminalTargetId: outcome.terminalTargetId,
          ptyId: outcome.ptyId,
          ptyInstanceId: outcome.ptyInstanceId,
          pid: outcome.pid,
        };
      },
      "host.list": () => {
        handoff.assertNotDraining();
        return { ptys: ptyTable.list() };
      },
      "host.focus": (params) => {
        const { ptyId } = HostFocusParamsSchema.parse(params);
        ptyTable.focus(ptyId); // best-effort
        return { ok: true as const };
      },
      "host.close": (params) => {
        // confirm is required by the schema — a guarded, explicit kill.
        const { ptyId } = HostCloseParamsSchema.parse(params);
        return { closed: ptyTable.close(ptyId) };
      },
    },
    attach: (params, registration) => {
      handoff.assertNotDraining();
      return ptyTable.attach(params, registration.attachmentId, params.intent);
    },
    // Draining is set before the ack, and close starts only after it is written, excluding spawn and response-loss races.
    afterUnaryResponseSent: (method) => {
      if (method === "host.stopIfIdle") {
        void closeHost("upgrade");
      }
      if (method === "host.completeHandoff") {
        void closeHost("handoff");
      }
    },
  };
}
