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
  HostCloseParamsSchema,
  HostFocusParamsSchema,
  type HostClientIdentity,
  type HostHandlers,
  type HostPtyKind,
  HostResizeParamsSchema,
  HostSpawnParamsSchema,
  HostStopIfIdleParamsSchema,
  HostWriteParamsSchema,
  StationHostProviderError,
  serveHostConnection,
} from "@station/host";
import { createHostLifecycleWitness } from "./hostLifecycle.js";
import {
  createPtyTable,
  type PtySpawnOutcome,
  type PtyTable,
  type PtyTableOptions,
} from "./ptyTable.js";
import {
  ptyBridgesDirectory,
  reapStaleOrphanBridges,
  resolveOrphanTtlMs,
} from "./orphanBridges.js";
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
};

export type StationHostInstance = {
  socketPath: string;
  /** Resolves after the socket is closed, owned PTYs are disposed, and stop is logged. */
  readonly closed: Promise<void>;
  close(): Promise<void>;
};

/**
 * The host owns PTYs independently of any client and answers
 * spawn/write/resize/list + health. Typed PTY lifecycle is emitted directly at
 * the table boundary, while shutdown disposes owned PTYs and flushes evidence.
 */
export async function startStationHost(
  options: StartStationHostOptions,
): Promise<StationHostInstance> {
  const ptyImplementation =
    options.ptyImplementation ?? resolvePtyImplementation(process.env.STATION_PTY_IMPL);
  const buildVersion = stationBuildInfo().version;
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

  const logEvent = (message: string, attributes: Record<string, unknown>): void => {
    void logger.log({ level: "info", message, attributes });
  };
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
  async function shutdownHost(reason: "requested" | "upgrade"): Promise<void> {
    try {
      await server.close();
    } finally {
      ptyTable.disposeAll();
      await logger.log({
        level: "info",
        message: "host.stop",
        attributes: { socketPath: options.socketPath, pid: process.pid, reason },
      });
      await hostLifecycle.flush();
    }
  }
  const closeHost = (reason: "requested" | "upgrade"): Promise<void> => {
    if (closePromise !== undefined) {
      return closePromise;
    }
    closePromise = shutdownHost(reason).finally(resolveClosed);
    return closePromise;
  };
  const handlers = buildHostHandlers(
    ptyTable,
    buildVersion,
    closeHost,
    (client, outcome, ptyKind) => {
      void hostLifecycle.ptySpawned(client, outcome, ptyKind);
    },
  );

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

function buildHostHandlers(
  ptyTable: PtyTable,
  buildVersion: string,
  closeHost: (reason: "requested" | "upgrade") => Promise<void>,
  onPtySpawned: (
    client: HostClientIdentity,
    outcome: PtySpawnOutcome,
    ptyKind: HostPtyKind,
  ) => void,
): HostHandlers {
  let drainingForBuild: string | undefined;
  const stopHostIfIdle = (params: unknown) => {
    const { requestingBuildVersion } = HostStopIfIdleParamsSchema.parse(params);
    const livePtyCount = ptyTable.list().length;
    if (livePtyCount !== 0) {
      throw livePtyUpgradeBlocked(buildVersion, requestingBuildVersion, livePtyCount);
    }
    // Set before returning so no spawn can race the successful acknowledgement.
    drainingForBuild = requestingBuildVersion;
    return { stopping: true as const };
  };
  const spawnPty = (
    params: unknown,
    client: HostClientIdentity | undefined,
  ) => {
    if (drainingForBuild !== undefined) {
      throw drainingSpawnBlocked(buildVersion, drainingForBuild);
    }
    const parsed = HostSpawnParamsSchema.parse(params);
    const outcome = ptyTable.spawn(parsed);
    if (client !== undefined) {
      onPtySpawned(client, outcome, parsed.kind);
    }
    return { ptyId: outcome.ptyId, pid: outcome.pid };
  };

  return {
    hostIdentity: { protocolVersion: HOST_PROTOCOL_VERSION, buildVersion },
    unary: {
      "host.health": () => ({
        ok: true as const,
        protocolVersion: HOST_PROTOCOL_VERSION,
        buildVersion,
      }),
      "host.stopIfIdle": stopHostIfIdle,
      "host.spawn": spawnPty,
      "host.write": (params) => {
        const { ptyId, data } = HostWriteParamsSchema.parse(params);
        ptyTable.write(ptyId, data);
        return { ok: true as const };
      },
      "host.resize": (params) => {
        const { ptyId, cols, rows } = HostResizeParamsSchema.parse(params);
        ptyTable.resize(ptyId, cols, rows);
        return { ok: true as const };
      },
      "host.list": () => ({ ptys: ptyTable.list() }),
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
    attach: (params) => ptyTable.attach(params.ptyId),
    // Draining is set before the ack, and close starts only after it is written, excluding spawn and response-loss races.
    afterUnaryResponseSent: (method) => {
      if (method === "host.stopIfIdle") {
        void closeHost("upgrade");
      }
    },
  };
}

function livePtyUpgradeBlocked(
  runningBuildVersion: string,
  requestingBuildVersion: string,
  livePtyCount: number,
): StationHostProviderError {
  const terminalLabel = livePtyCount === 1 ? "terminal" : "terminals";
  return new StationHostProviderError(
    "HOST_UPGRADE_BLOCKED",
    `Station host build "${runningBuildVersion}" has ${livePtyCount} live ${terminalLabel} and cannot be replaced by build "${requestingBuildVersion}".`,
    {
      hint: `Reopen Station with build "${runningBuildVersion}", finish or close its live terminals, then retry build "${requestingBuildVersion}".`,
    },
  );
}

function drainingSpawnBlocked(
  runningBuildVersion: string,
  requestingBuildVersion: string,
): StationHostProviderError {
  return new StationHostProviderError(
    "HOST_UPGRADE_BLOCKED",
    `Station host build "${runningBuildVersion}" is stopping for build "${requestingBuildVersion}" and cannot spawn a new terminal.`,
  );
}
