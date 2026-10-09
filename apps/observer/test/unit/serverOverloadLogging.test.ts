import type { ObserverApi } from "@station/contracts";
import type { NdjsonTransportDiagnostics, ProtocolServerOptions } from "@station/protocol";
import { describe, expect, it, vi } from "vitest";
import { startObserverServer } from "../../src/runtime/server.js";
import type { StationLogger } from "../../src/stationLogger.js";

const protocolServer = vi.hoisted(() => ({
  onConnectionDiagnostics: undefined as ProtocolServerOptions["onConnectionDiagnostics"],
}));

vi.mock("@station/protocol", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@station/protocol")>()),
  startProtocolServer: vi.fn(async (options: ProtocolServerOptions) => {
    protocolServer.onConnectionDiagnostics = options.onConnectionDiagnostics;
    return {
      socketPath: options.socketPath,
      close: async () => undefined,
      abandon: () => undefined,
    };
  }),
}));

const closedConnection: NdjsonTransportDiagnostics = {
  inboundQueueDepth: 0,
  inboundQueueBytes: 0,
  inboundHighWaterDepth: 1,
  inboundHighWaterBytes: 114,
  outboundBackpressureCount: 1,
  overflowCount: 0,
  closeCount: 1,
};

async function observerLogger() {
  const logger = {
    info: vi.fn(async () => undefined),
    warn: vi.fn(async () => undefined),
    error: vi.fn(async () => undefined),
  } satisfies StationLogger;
  await startObserverServer({
    socketPath: "/tmp/station-test.sock",
    api: {} as ObserverApi,
    logger,
  });
  return logger;
}

describe("Observer transport overload logging", () => {
  it("does not warn when a connection saw a blocked write but never overflowed", async () => {
    const logger = await observerLogger();

    protocolServer.onConnectionDiagnostics?.(closedConnection);

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warns with content-free counts when a connection overflowed its queue", async () => {
    const logger = await observerLogger();
    const overflowed: NdjsonTransportDiagnostics = {
      ...closedConnection,
      overflowCount: 1,
      lastOverflowReason: "outbound-backpressure",
    };

    protocolServer.onConnectionDiagnostics?.(overflowed);

    expect(logger.warn).toHaveBeenCalledWith(
      "Observer protocol transport closed an overloaded connection.",
      { boundary: "protocol.transport", ...overflowed },
    );
  });
});
