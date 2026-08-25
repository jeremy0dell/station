import type { ObserverHealth, ObserverProcessIdentity } from "@station/contracts";
import { STATION_SCHEMA_VERSION } from "@station/contracts";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  type ExactObserverInspectionPorts,
  inspectExactObserverOwner,
} from "../../src/runtime/inspectExactObserverOwner.js";
import type { ObserverCooperativeProcessEntry } from "../../src/runtime/observerCooperativeProcessIdentity.js";

const socketPath = "/tmp/station/observer.sock";
const identity: ObserverProcessIdentity = {
  pid: 42,
  osStartTime: "Mon Aug 24 12:00:00 2026",
  processToken: "00000000-0000-4000-8000-000000000001",
  version: `1.2.3+station.${"a".repeat(64)}`,
  socketPath,
};
const health: ObserverHealth = {
  schemaVersion: STATION_SCHEMA_VERSION,
  status: "healthy",
  pid: identity.pid,
  startedAt: "2026-08-24T12:00:00.000Z",
  version: identity.version,
  socketPath,
};
const processEntry: ObserverCooperativeProcessEntry = {
  pid: identity.pid,
  argv: ["/opt/station/stn", "__observer", "--socket", socketPath],
  executablePath: "/opt/station/stn",
  startToken: identity.osStartTime,
  processToken: identity.processToken,
  buildVersion: identity.version,
  socketPath,
  startupTimeoutMs: 10_000,
  executableProvenance: "exact",
};
const assessment = {
  schemaVersion: 1 as const,
  inventory: { schemaVersion: 1 as const, sessions: [], recoveryHandles: [] },
  resumeEnabled: true,
  providerCapabilities: [],
  sessions: [],
};

describe("inspectExactObserverOwner", () => {
  it.each([
    ["missing", { ...health, socketPath: undefined }],
    ["different", { ...health, socketPath: "/tmp/station/other.sock" }],
  ])("rejects %s health socket evidence before downstream reads", async (_name, currentHealth) => {
    const readPidfileIdentity = vi.fn(async () => identity);
    const readCooperativeObserverProcess = vi.fn(() => processEntry);
    const readRecoveryAssessment = vi.fn(async () => assessment);

    await expect(
      inspectExactObserverOwner(
        { socketPath },
        inspectionPorts({
          readStatus: async () => ({ status: "running", health: currentHealth }),
          readPidfileIdentity,
          processEvidence: {
            readCooperativeObserverProcess,
            processStartToken: () => identity.osStartTime,
          },
          readRecoveryAssessment,
        }),
      ),
    ).resolves.toMatchObject({ status: "blocked", reason: "identity-missing" });
    expect(readPidfileIdentity).not.toHaveBeenCalled();
    expect(readCooperativeObserverProcess).not.toHaveBeenCalled();
    expect(readRecoveryAssessment).not.toHaveBeenCalled();
  });

  it("rejects coherent display-only versions before recovery inspection", async () => {
    const plainIdentity = { ...identity, version: "1.2.3" };
    const readPidfileIdentity = vi.fn(async () => plainIdentity);
    const readCooperativeObserverProcess = vi.fn(() => ({
      ...processEntry,
      buildVersion: plainIdentity.version,
    }));
    const readRecoveryAssessment = vi.fn(async () => assessment);

    await expect(
      inspectExactObserverOwner(
        { socketPath },
        inspectionPorts({
          readStatus: async () => ({
            status: "running",
            health: { ...health, version: plainIdentity.version },
          }),
          readPidfileIdentity,
          processEvidence: {
            readCooperativeObserverProcess,
            processStartToken: () => plainIdentity.osStartTime,
          },
          readRecoveryAssessment,
        }),
      ),
    ).resolves.toMatchObject({ status: "blocked", reason: "identity-missing" });
    expect(readPidfileIdentity).not.toHaveBeenCalled();
    expect(readCooperativeObserverProcess).not.toHaveBeenCalled();
    expect(readRecoveryAssessment).not.toHaveBeenCalled();
  });

  it("classifies missing, unreadable, and health-mismatched pidfile evidence", async () => {
    await expect(
      inspectExactObserverOwner(
        { socketPath },
        inspectionPorts({ readPidfileIdentity: async () => undefined }),
      ),
    ).resolves.toMatchObject({ status: "blocked", reason: "identity-missing" });
    await expect(
      inspectExactObserverOwner(
        { socketPath },
        inspectionPorts({
          readPidfileIdentity: async () => {
            throw new Error("private pidfile failure");
          },
        }),
      ),
    ).resolves.toMatchObject({ status: "blocked", reason: "identity-unavailable" });
    await expect(
      inspectExactObserverOwner(
        { socketPath },
        inspectionPorts({ readPidfileIdentity: async () => ({ ...identity, pid: 43 }) }),
      ),
    ).resolves.toMatchObject({ status: "blocked", reason: "identity-mismatch" });
  });

  it("classifies unavailable and mismatched cooperative process evidence", async () => {
    await expect(
      inspectExactObserverOwner(
        { socketPath },
        inspectionPorts({
          processEvidence: {
            readCooperativeObserverProcess: () => processEntry,
            processStartToken: () => undefined,
          },
        }),
      ),
    ).resolves.toMatchObject({ status: "blocked", reason: "identity-unavailable" });
    await expect(
      inspectExactObserverOwner(
        { socketPath },
        inspectionPorts({
          processEvidence: {
            readCooperativeObserverProcess: () => ({ ...processEntry, processToken: "drift" }),
            processStartToken: () => identity.osStartTime,
          },
        }),
      ),
    ).resolves.toMatchObject({ status: "blocked", reason: "identity-mismatch" });
  });

  it("keeps stable ownership exact when the pinned recovery read fails", async () => {
    const ports = inspectionPorts({
      readRecoveryAssessment: async () => {
        throw new Error("private recovery failure");
      },
    });
    const result = await inspectExactObserverOwner({ socketPath }, ports);
    expect(result).toMatchObject({
      status: "exact",
      processIdentity: identity,
      process: processEntry,
      recovery: { status: "unknown", error: { code: "OBSERVER_INSPECTION_FAILED" } },
    });
    if (result.status !== "exact") throw new Error("expected exact evidence");
    expectTypeOf(result.health.pid).toEqualTypeOf<number>();
    expectTypeOf(result.health.socketPath).toEqualTypeOf<string>();
    expectTypeOf(result.process.startupTimeoutMs).toEqualTypeOf<number>();
    expectTypeOf(result.process.socketPath).toEqualTypeOf<string>();
  });

  it.each([
    undefined,
    0,
  ])("rejects missing or non-positive startup budget %s before recovery inspection", async (startupTimeoutMs) => {
    const readRecoveryAssessment = vi.fn(async () => assessment);
    await expect(
      inspectExactObserverOwner(
        { socketPath },
        inspectionPorts({
          processEvidence: {
            readCooperativeObserverProcess: () => ({ ...processEntry, startupTimeoutMs }),
            processStartToken: () => identity.osStartTime,
          },
          readRecoveryAssessment,
        }),
      ),
    ).resolves.toMatchObject({ status: "blocked", reason: "identity-missing" });
    expect(readRecoveryAssessment).not.toHaveBeenCalled();
  });

  it.each([
    "status",
    "pidfile",
  ] as const)("rejects successor %s evidence even while the old process remains alive", async (drift) => {
    const successorHealth = { ...health, pid: 43, startedAt: "2026-08-24T12:01:00.000Z" };
    const successorIdentity = {
      ...identity,
      pid: 43,
      osStartTime: "Mon Aug 24 12:01:00 2026",
      processToken: "00000000-0000-4000-8000-000000000002",
    };
    const readStatus = vi
      .fn<ExactObserverInspectionPorts["readStatus"]>()
      .mockResolvedValueOnce({ status: "running", health })
      .mockResolvedValueOnce({
        status: "running",
        health: drift === "status" ? successorHealth : health,
      });
    const readPidfileIdentity = vi
      .fn<ExactObserverInspectionPorts["readPidfileIdentity"]>()
      .mockResolvedValueOnce(identity)
      .mockResolvedValueOnce(drift === "pidfile" ? successorIdentity : identity);
    const readProcess = vi.fn(() => processEntry);

    await expect(
      inspectExactObserverOwner(
        { socketPath },
        inspectionPorts({
          readStatus,
          readPidfileIdentity,
          processEvidence: {
            readCooperativeObserverProcess: readProcess,
            processStartToken: () => identity.osStartTime,
          },
        }),
      ),
    ).resolves.toMatchObject({ status: "blocked", reason: "identity-drift" });
    expect(readProcess).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["exact", "installed-path-replaced"],
    ["installed-path-replaced", "exact"],
  ] as const)("rejects provenance drift from %s to %s", async (before, after) => {
    const readProcess = vi
      .fn<ExactObserverInspectionPorts["processEvidence"]["readCooperativeObserverProcess"]>()
      .mockReturnValueOnce({ ...processEntry, executableProvenance: before })
      .mockReturnValueOnce({ ...processEntry, executableProvenance: after });
    await expect(
      inspectExactObserverOwner(
        { socketPath },
        inspectionPorts({
          processEvidence: {
            readCooperativeObserverProcess: readProcess,
            processStartToken: () => identity.osStartTime,
          },
        }),
      ),
    ).resolves.toMatchObject({ status: "blocked", reason: "identity-drift" });
  });
});

function inspectionPorts(
  overrides: Partial<ExactObserverInspectionPorts> = {},
): ExactObserverInspectionPorts {
  return {
    readStatus: async () => ({ status: "running", health }),
    readPidfileIdentity: async () => identity,
    processEvidence: {
      readCooperativeObserverProcess: () => processEntry,
      processStartToken: () => identity.osStartTime,
    },
    readRecoveryAssessment: async () => assessment,
    ...overrides,
  };
}
