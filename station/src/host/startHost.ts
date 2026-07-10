import { componentLogPath, createJsonlLogger, type JsonlLogger } from "@station/observability";
import { listenUnixSocket } from "@station/protocol";
import {
  HOST_PROTOCOL_VERSION,
  HostCloseParamsSchema,
  HostFocusParamsSchema,
  type HostHandlers,
  HostResizeParamsSchema,
  HostSpawnParamsSchema,
  HostWriteParamsSchema,
  serveHostConnection,
} from "@station/host";
import { createPtyTable, type PtyTable, type PtyTableOptions } from "./ptyTable.js";

export type StartStationHostOptions = {
  socketPath: string;
  stateDir: string;
  logger?: JsonlLogger;
  ptyTableOptions?: PtyTableOptions;
};

export type StationHostInstance = {
  socketPath: string;
  close(): Promise<void>;
};

/**
 * The host owns PTYs independently of any client and answers
 * spawn/write/resize/list + health. Shutdown disposes (gracefully reaps) owned
 * PTYs — the orphan policy for an intentional `host stop`.
 */
export async function startStationHost(
  options: StartStationHostOptions,
): Promise<StationHostInstance> {
  const ptyImplementation = process.env.STATION_PTY_IMPL || "bridge";
  const logger =
    options.logger ??
    createJsonlLogger({
      component: "station-host",
      path: componentLogPath(options.stateDir, "station-host"),
    });

  await logger.log({
    level: "info",
    message: "host.start",
    attributes: { socketPath: options.socketPath, pid: process.pid, ptyImplementation },
  });

  // Every lifecycle event -> station-host.jsonl as a tailable timeline. Redaction-safe: only ids/counts/codes, never PTY data/env.
  const logEvent = (message: string, attributes: Record<string, unknown>): void => {
    void logger.log({ level: "info", message, attributes });
  };
  const ptyTable = createPtyTable({ ...options.ptyTableOptions, onEvent: logEvent });
  const server = await listenUnixSocket({
    socketPath: options.socketPath,
    onConnection: (connection) =>
      serveHostConnection(connection, buildHostHandlers(ptyTable), {
        onError: (error) => {
          void logger.log({
            level: "warn",
            message: "host.error",
            attributes: { code: error.code },
          });
        },
        onEvent: logEvent,
      }),
  });

  return {
    socketPath: server.socketPath,
    close: async () => {
      await server.close();
      ptyTable.disposeAll();
      await logger.log({
        level: "info",
        message: "host.stop",
        attributes: { socketPath: options.socketPath, pid: process.pid },
      });
    },
  };
}

function buildHostHandlers(ptyTable: PtyTable): HostHandlers {
  return {
    unary: {
      "host.health": () => ({ ok: true as const, protocolVersion: HOST_PROTOCOL_VERSION }),
      "host.spawn": (params) => ptyTable.spawn(HostSpawnParamsSchema.parse(params)),
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
  };
}
