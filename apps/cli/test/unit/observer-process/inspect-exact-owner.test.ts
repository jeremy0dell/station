import { describe, expect, it, vi } from "vitest";
import { inspectExactObserverOwnerWithLocalAdapters } from "../../../src/observerProcess/inspectExactObserverOwner.js";

const paths = {
  stateDir: "/tmp/station",
  socketPath: "/tmp/station/observer.sock",
  dbPath: "/tmp/station/station.db",
  logDir: "/tmp/station/logs",
  diagnosticsDir: "/tmp/station/diagnostics",
  hookSpoolDir: "/tmp/station/hooks",
};
const processIdentity = {
  pid: 42,
  osStartTime: "Sat Aug 24 12:00:00 2026",
  processToken: "00000000-0000-4000-8000-000000000001",
  version: `1.2.3+station.${"a".repeat(64)}`,
  socketPath: paths.socketPath,
};
const processEntry = {
  pid: processIdentity.pid,
  argv: ["/opt/station/stn", "__observer"],
  executablePath: "/opt/station/stn",
  startToken: processIdentity.osStartTime,
  processToken: processIdentity.processToken,
  buildVersion: processIdentity.version,
  socketPath: paths.socketPath,
  startupTimeoutMs: 10_000,
  executableProvenance: "exact" as const,
};
const health = {
  schemaVersion: "0.11.0",
  status: "healthy",
  pid: processIdentity.pid,
  startedAt: "2026-08-24T12:00:00.000Z",
  version: processIdentity.version,
  socketPath: paths.socketPath,
} as const;
const assessment = {
  schemaVersion: 1 as const,
  inventory: { schemaVersion: 1 as const, sessions: [], recoveryHandles: [] },
  resumeEnabled: true,
  providerCapabilities: [],
  sessions: [],
};

describe("inspectExactObserverOwnerWithLocalAdapters", () => {
  it("reports exact absence without lifecycle mutation", async () => {
    await expect(
      inspectExactObserverOwnerWithLocalAdapters(
        { paths },
        {
          readStatus: async () => ({ status: "stopped", paths }),
          readPidfileIdentity: async () => undefined,
          processEvidence: {
            readCooperativeObserverProcess: vi.fn(),
            processStartToken: vi.fn(),
          },
          readRecoveryAssessment: vi.fn(),
        },
      ),
    ).resolves.toEqual({ status: "absent" });
  });

  it("returns coherent process, health, provenance, and selected-handle assessment", async () => {
    const readObserverProcess = vi.fn(() => processEntry);
    const getSessionRecoveryAssessment = vi.fn(async () => assessment);
    const result = await inspectExactObserverOwnerWithLocalAdapters(
      { paths, timeoutMs: 50 },
      {
        readStatus: async () => ({ status: "running", paths, health }),
        readPidfileIdentity: async () => processIdentity,
        processEvidence: {
          readCooperativeObserverProcess: readObserverProcess,
          processStartToken: () => processIdentity.osStartTime,
        },
        readRecoveryAssessment: getSessionRecoveryAssessment,
      },
    );

    expect(result).toMatchObject({
      status: "exact",
      processIdentity,
      process: processEntry,
      recovery: { status: "assessed", assessment },
    });
    expect(readObserverProcess).toHaveBeenCalledTimes(2);
  });
});
