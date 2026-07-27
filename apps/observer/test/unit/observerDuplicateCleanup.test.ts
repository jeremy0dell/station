import type { ObserverProcessIdentity } from "@station/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createObserverDuplicateCleanup,
  type ObserverDuplicateCleanupExclusion,
  type ObserverDuplicateProcessEvidenceSource,
  runObserverReap,
  selectObserverDuplicateCleanupPlan,
} from "../../src/runtime/observerDuplicateCleanup.js";
import type { SocketIdentity } from "../../src/runtime/socketOwnership.js";

const socketPath = "/tmp/station/observer.sock";
const version = `1.2.3+station.${"a".repeat(64)}`;
const socketIdentity: SocketIdentity = { ino: 10n, birthtimeNs: 20n };
const keeperIdentity: ObserverProcessIdentity = {
  pid: 100,
  osStartTime: "keeper-start",
  version,
  socketPath,
};

function processEntry(pid: number, startToken: string, startupTimeoutMs = 25) {
  return {
    pid,
    argv: ["/opt/station/stn", "__observer", "--socket", socketPath],
    startToken,
    socketPath,
    startupTimeoutMs,
  };
}

function createEvidence(
  options: { candidateFds?: number; candidateAlive?: boolean; surviveSigterm?: boolean } = {},
) {
  let candidateAlive = options.candidateAlive ?? true;
  const signals: Array<[number, NodeJS.Signals | 0]> = [];
  const evidence: ObserverDuplicateProcessEvidenceSource = {
    listObserverProcesses: () => [
      processEntry(100, "keeper-start"),
      ...(candidateAlive ? [processEntry(200, "candidate-start")] : []),
    ],
    socketHolders: () => [100],
    processStartToken: (pid) => {
      if (pid === 100) return "keeper-start";
      return candidateAlive ? "candidate-start" : undefined;
    },
    readProcessIdentity: async () => keeperIdentity,
    socketIdentity: async () => socketIdentity,
    unixSocketFdCount: () => options.candidateFds ?? 0,
    signal: (pid, signal) => {
      signals.push([pid, signal]);
      if (pid === 200 && signal === "SIGTERM") {
        if (options.surviveSigterm !== true) candidateAlive = false;
        return "sent";
      }
      if (pid === 200 && signal === 0) return candidateAlive ? "sent" : "absent";
      return "sent";
    },
  };
  return {
    evidence,
    signals,
    candidateIsAlive: () => candidateAlive,
    removeCandidate: () => {
      candidateAlive = false;
    },
  };
}

function availableExclusion(): ObserverDuplicateCleanupExclusion {
  return {
    runExclusive: async (operation) => ({
      status: "completed",
      value: await operation(),
      released: true,
    }),
  };
}

describe("Observer duplicate cleanup policy", () => {
  it("requires exact keeper evidence and zero candidate Unix socket descriptors", () => {
    const plan = selectObserverDuplicateCleanupPlan({
      socketPath,
      keeperIdentity,
      boundSocketIdentity: socketIdentity,
      currentSocketIdentity: socketIdentity,
      holders: [100],
      keeperStartToken: "keeper-start",
      currentPidfile: keeperIdentity,
      processes: [processEntry(100, "keeper-start"), processEntry(200, "candidate-start")],
      candidateUnixSocketFdCounts: new Map([[200, 0]]),
      legacyQuarantineMs: 10_000,
    });

    expect(plan.eligibleTargets).toEqual([
      expect.objectContaining({ pid: 200, startToken: "candidate-start", quarantineMs: 10_000 }),
    ]);
    expect(plan.refusals).toEqual([]);

    const refused = selectObserverDuplicateCleanupPlan({
      socketPath,
      keeperIdentity,
      boundSocketIdentity: socketIdentity,
      currentSocketIdentity: socketIdentity,
      holders: [100],
      keeperStartToken: "keeper-start",
      currentPidfile: keeperIdentity,
      processes: [processEntry(100, "keeper-start"), processEntry(200, "candidate-start")],
      candidateUnixSocketFdCounts: new Map([[200, 1]]),
      legacyQuarantineMs: 10_000,
    });
    expect(refused.eligibleTargets).toEqual([]);
    expect(refused.refusals).toContainEqual(
      expect.objectContaining({ pid: 200, code: "candidate-holds-unix-socket" }),
    );
  });

  it.each([
    {
      name: "socket identity changed",
      patch: { currentSocketIdentity: { ino: 11n, birthtimeNs: 20n } },
      code: "keeper-socket-identity-changed",
    },
    {
      name: "multiple holders",
      patch: { holders: [100, 101] },
      code: "keeper-not-sole-holder",
    },
    {
      name: "pidfile changed",
      patch: { currentPidfile: { ...keeperIdentity, osStartTime: "other" } },
      code: "keeper-pidfile-mismatch",
    },
    {
      name: "keeper process changed",
      patch: { keeperStartToken: "other" },
      code: "keeper-process-mismatch",
    },
  ])("refuses every candidate when $name", ({ patch, code }) => {
    const plan = selectObserverDuplicateCleanupPlan({
      socketPath,
      keeperIdentity,
      boundSocketIdentity: socketIdentity,
      currentSocketIdentity: socketIdentity,
      holders: [100],
      keeperStartToken: "keeper-start",
      currentPidfile: keeperIdentity,
      processes: [processEntry(100, "keeper-start"), processEntry(200, "candidate-start")],
      candidateUnixSocketFdCounts: new Map([[200, 0]]),
      legacyQuarantineMs: 10_000,
      ...patch,
    });

    expect(plan.eligibleTargets).toEqual([]);
    expect(plan.refusals).toContainEqual(expect.objectContaining({ code }));
  });
});

describe("Observer duplicate cleanup use case", () => {
  it("quarantines and reports an unchanged eligible duplicate without signaling", async () => {
    const { evidence, signals } = createEvidence();
    const sleep = vi.fn(async () => undefined);
    const cleanup = createObserverDuplicateCleanup(
      {
        socketPath,
        keeperIdentity,
        boundSocketIdentity: socketIdentity,
        mode: "report",
        legacyQuarantineMs: 10,
        exitGraceMs: 5,
      },
      { evidence, exclusion: availableExclusion(), sleep },
    );

    await expect(cleanup.run()).resolves.toMatchObject({
      status: "would-terminate",
      eligiblePids: [200],
    });
    expect(sleep).toHaveBeenCalledWith(25, expect.any(AbortSignal));
    expect(signals).toEqual([]);
    expect(cleanup.status()).toMatchObject({ status: "would-terminate" });
  });

  it("sends SIGTERM once in terminate mode and never escalates", async () => {
    const { evidence, signals, candidateIsAlive } = createEvidence();
    const cleanup = createObserverDuplicateCleanup(
      {
        socketPath,
        keeperIdentity,
        boundSocketIdentity: socketIdentity,
        mode: "terminate",
        legacyQuarantineMs: 10,
        exitGraceMs: 5,
      },
      { evidence, exclusion: availableExclusion(), sleep: async () => undefined },
    );

    await expect(cleanup.run()).resolves.toMatchObject({
      status: "terminated",
      terminatedPids: [200],
      keeperPreservation: { preserved: true },
    });
    expect(candidateIsAlive()).toBe(false);
    expect(signals).toContainEqual([200, "SIGTERM"]);
    expect(signals.some(([, signal]) => signal === "SIGKILL")).toBe(false);
  });

  it("reports a SIGTERM survivor without automatic escalation", async () => {
    const { evidence, signals, candidateIsAlive } = createEvidence({ surviveSigterm: true });
    const cleanup = createObserverDuplicateCleanup(
      {
        socketPath,
        keeperIdentity,
        boundSocketIdentity: socketIdentity,
        mode: "terminate",
        legacyQuarantineMs: 10,
        exitGraceMs: 5,
      },
      { evidence, exclusion: availableExclusion(), sleep: async () => undefined },
    );

    await expect(cleanup.run()).resolves.toMatchObject({
      status: "survived",
      survivedPids: [200],
    });
    expect(candidateIsAlive()).toBe(true);
    expect(signals.filter(([, signal]) => signal === "SIGTERM")).toEqual([[200, "SIGTERM"]]);
    expect(signals.some(([, signal]) => signal === "SIGKILL")).toBe(false);
  });

  it("refuses a candidate that changes during quarantine", async () => {
    const { evidence, signals, removeCandidate } = createEvidence();
    const cleanup = createObserverDuplicateCleanup(
      {
        socketPath,
        keeperIdentity,
        boundSocketIdentity: socketIdentity,
        mode: "terminate",
        legacyQuarantineMs: 10,
        exitGraceMs: 5,
      },
      {
        evidence,
        exclusion: availableExclusion(),
        sleep: async () => removeCandidate(),
      },
    );

    await expect(cleanup.run()).resolves.toMatchObject({
      status: "refused",
      refusalCodes: expect.arrayContaining(["candidate-changed-during-quarantine"]),
    });
    expect(signals).toEqual([]);
  });

  it("is single-flight across repeated starts", async () => {
    const { evidence } = createEvidence();
    const cleanup = createObserverDuplicateCleanup(
      {
        socketPath,
        keeperIdentity,
        boundSocketIdentity: socketIdentity,
        mode: "report",
        legacyQuarantineMs: 10,
      },
      { evidence, exclusion: availableExclusion(), sleep: async () => undefined },
    );

    const first = cleanup.run();
    expect(cleanup.run()).toBe(first);
    await first;
  });

  it("refuses cleanup when the boot claim is busy", async () => {
    const { evidence, signals } = createEvidence();
    const cleanup = createObserverDuplicateCleanup(
      {
        socketPath,
        keeperIdentity,
        boundSocketIdentity: socketIdentity,
        mode: "terminate",
        legacyQuarantineMs: 10,
        exitGraceMs: 5,
      },
      {
        evidence,
        exclusion: { runExclusive: async () => ({ status: "busy" }) },
        sleep: async () => undefined,
      },
    );

    await expect(cleanup.run()).resolves.toMatchObject({
      status: "refused",
      refusalCodes: ["boot-claim-busy"],
    });
    expect(signals).toEqual([]);
  });

  it("aborts the quarantine during shutdown", async () => {
    const { evidence, signals } = createEvidence();
    const cleanup = createObserverDuplicateCleanup(
      {
        socketPath,
        keeperIdentity,
        boundSocketIdentity: socketIdentity,
        mode: "terminate",
        legacyQuarantineMs: 10,
        exitGraceMs: 5,
      },
      {
        evidence,
        exclusion: availableExclusion(),
        sleep: (_ms, signal) =>
          new Promise((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          ),
      },
    );

    const flight = cleanup.run();
    cleanup.abort();
    await expect(flight).resolves.toMatchObject({ status: "cancelled" });
    expect(signals).toEqual([]);
  });
});

describe("manual Observer reap", () => {
  it("keeps explicit force escalation while recording keeper preservation", async () => {
    let candidateAlive = true;
    const { evidence } = createEvidence();
    const stubbornEvidence: ObserverDuplicateProcessEvidenceSource = {
      ...evidence,
      processStartToken: (pid) =>
        pid === 100 ? "keeper-start" : candidateAlive ? "candidate-start" : undefined,
      listObserverProcesses: () => [
        processEntry(100, "keeper-start"),
        ...(candidateAlive ? [processEntry(200, "candidate-start")] : []),
      ],
      signal: (pid, signal) => {
        if (pid === 200 && signal === "SIGKILL") candidateAlive = false;
        if (pid === 200 && signal === 0) return candidateAlive ? "sent" : "absent";
        return "sent";
      },
    };

    await expect(
      runObserverReap(
        socketPath,
        { force: true, graceMs: 0 },
        { evidence: stubbornEvidence, sleep: async () => undefined },
      ),
    ).resolves.toMatchObject({
      applied: true,
      killed: [200],
      keeperPreservation: { preserved: true },
    });
  });
});
