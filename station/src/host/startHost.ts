import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { PtyHandoffManifest } from "@station/contracts";
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
  waitForParkedBridge,
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
 * spawn/write/resize/list + health. Typed PTY lifecycle is emitted directly at
 * the table boundary, while shutdown disposes owned PTYs and flushes evidence.
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
  async function shutdownHost(reason: CloseReason): Promise<void> {
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
  }
  const closeHost = (reason: CloseReason): Promise<void> => {
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
  closeHost: (reason: CloseReason) => Promise<void>,
  onPtySpawned: (
    client: HostClientIdentity,
    outcome: PtySpawnOutcome,
    ptyKind: HostPtyKind,
  ) => void,
): HostHandlers {
  let drainingForBuild: string | undefined;
  let handoffManifest: PtyHandoffManifest | undefined;

  const assertNotDraining = (): void => {
    if (drainingForBuild !== undefined) {
      throw drainingSpawnBlocked(buildVersion, drainingForBuild);
    }
  };

  const stopHostIfIdle = (params: unknown) => {
    const { requestingBuildVersion } = HostStopIfIdleParamsSchema.parse(params);
    if (handoffManifest !== undefined) {
      throw handoffInvalidState("A live handoff is already in progress.");
    }
    const livePtyCount = ptyTable.list().length;
    if (livePtyCount !== 0) {
      throw livePtyUpgradeBlocked(buildVersion, requestingBuildVersion, livePtyCount);
    }
    // Set before returning so no spawn can race the successful acknowledgement.
    drainingForBuild = requestingBuildVersion;
    return { stopping: true as const };
  };

  const beginHandoff = async (params: unknown) => {
    const { requestingBuildVersion, fidelity } = HostBeginHandoffParamsSchema.parse(params);
    if (drainingForBuild !== undefined || handoffManifest !== undefined) {
      throw handoffInvalidState("The host is already draining or handing off.");
    }
    const livePtyCount = ptyTable.list().length;
    if (livePtyCount === 0) {
      throw handoffInvalidState(
        "Live handoff requires at least one live terminal; use idle stop-if-idle replacement instead.",
      );
    }
    drainingForBuild = requestingBuildVersion;
    try {
      const report = await ptyTable.releaseRegistryForHandoff(fidelity);
      if (report.released.length === 0) {
        drainingForBuild = undefined;
        throw handoffInvalidState(
          report.skipped.length > 0
            ? "Live handoff requires every live terminal to be bridge-backed and releasable."
            : "No bridge-backed terminals could be released for handoff.",
        );
      }
      handoffManifest = report.manifest;
      // Real bridges write park.json and listen on the control socket. Scripted
      // releases create neither. A park file without a socket is a hard failure
      // (common when the unix socket path exceeds the OS sun_path limit).
      for (const ptyId of report.released) {
        const controlSocket = report.manifest[ptyId]?.controlSocket;
        if (controlSocket === undefined) {
          continue;
        }
        const parkStatePath = controlSocket.endsWith(".sock")
          ? `${controlSocket.slice(0, -".sock".length)}.park.json`
          : `${controlSocket}.park.json`;
        const artifact = await waitForParkArtifact(controlSocket, parkStatePath, 500);
        if (artifact === "none") {
          continue;
        }
        if (artifact === "park-only") {
          await abortHandoff();
          throw handoffInvalidState(
            `Released terminal "${ptyId}" wrote park state but never opened its control socket.`,
          );
        }
        const ready = await waitForParkedBridge(controlSocket, { timeoutMs: 3_000 });
        if (!ready) {
          await abortHandoff();
          throw handoffInvalidState(
            `Released terminal "${ptyId}" did not park in time for live handoff.`,
          );
        }
      }
      return {
        manifest: report.manifest,
        fidelity: report.fidelity,
        released: report.released,
        skipped: report.skipped,
      };
    } catch (error) {
      if (handoffManifest === undefined) {
        drainingForBuild = undefined;
      }
      throw error;
    }
  };

  const completeHandoff = () => {
    if (handoffManifest === undefined) {
      throw handoffInvalidState("No handoff is in progress.");
    }
    return { stopping: true as const };
  };

  const abortHandoff = async () => {
    if (handoffManifest === undefined) {
      throw handoffInvalidState("No handoff is in progress.");
    }
    const manifest = handoffManifest;
    const report = await ptyTable.adoptRegistry(manifest);
    handoffManifest = undefined;
    drainingForBuild = undefined;
    return report;
  };

  const adoptRegistry = async (params: unknown) => {
    const { manifest } = HostAdoptRegistryParamsSchema.parse(params);
    return ptyTable.adoptRegistry(manifest);
  };

  const spawnPty = (
    params: unknown,
    client: HostClientIdentity | undefined,
  ) => {
    assertNotDraining();
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
      "host.beginHandoff": beginHandoff,
      "host.completeHandoff": completeHandoff,
      "host.abortHandoff": abortHandoff,
      "host.adoptRegistry": adoptRegistry,
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
    attach: (params) => {
      assertNotDraining();
      return ptyTable.attach(params.ptyId);
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

function handoffInvalidState(message: string): StationHostProviderError {
  return new StationHostProviderError("HOST_HANDOFF_INVALID_STATE", message);
}

async function waitForParkArtifact(
  controlSocket: string,
  parkStatePath: string,
  timeoutMs: number,
): Promise<"socket" | "park-only" | "none"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(controlSocket)) {
      return "socket";
    }
    if (existsSync(parkStatePath)) {
      // Give listen() a brief chance after park.json is written.
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      if (existsSync(controlSocket)) {
        return "socket";
      }
      return "park-only";
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  if (existsSync(controlSocket)) {
    return "socket";
  }
  if (existsSync(parkStatePath)) {
    return "park-only";
  }
  return "none";
}
