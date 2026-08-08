import type { ObserverProcessIdentity } from "@station/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createObserverDuplicateCleanup,
  createObserverReap,
  type ObserverDuplicateCleanupExclusion,
  type ObserverDuplicateProcessEvidenceSource,
  selectObserverDuplicateCleanupPlan,
} from "../../src/runtime/observerDuplicateCleanup.js";
import type { SocketIdentity } from "../../src/runtime/socketOwnership.js";

const socketPath = "/tmp/station/observer.sock";
const version = `1.2.3+station.${"a".repeat(64)}`;
const socketIdentity: SocketIdentity = { ino: 10n, birthtimeNs: 20n };
const keeperIdentity: ObserverProcessIdentity = {
  pid: 100,
  osStartTime: "keeper-start",
  processToken: "00000000-0000-4000-8000-000000000001",
  version,
  socketPath,
};

function runObserverReap(
  requestedSocketPath: string,
  options: { force: boolean; graceMs?: number },
  deps: Omit<Parameters<typeof createObserverReap>[0], "exclusion" | "healthPid"> &
    Partial<Pick<Parameters<typeof createObserverReap>[0], "exclusion" | "healthPid">>,
) {
  return createObserverReap({
    ...deps,
    exclusion: deps.exclusion ?? availableExclusion(),
    healthPid: deps.healthPid ?? (async () => 100),
  })(requestedSocketPath, options);
}

function processEntry(pid: number, startToken: string, startupTimeoutMs = 25) {
  const executablePath = "/opt/station/stn";
  return {
    pid,
    argv: [executablePath, "__observer", "--socket", socketPath],
    executablePath,
    startToken,
    processToken:
      pid === 100 ? keeperIdentity.processToken : "00000000-0000-4000-8000-000000000002",
    buildVersion: version,
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

  it("refuses a same-second candidate replacement with a different launch nonce", async () => {
    const { evidence, signals } = createEvidence();
    let inspections = 0;
    const changingEvidence: ObserverDuplicateProcessEvidenceSource = {
      ...evidence,
      listObserverProcesses: () => {
        inspections += 1;
        const candidate = processEntry(200, "candidate-start");
        return [
          processEntry(100, "keeper-start"),
          inspections === 1
            ? candidate
            : { ...candidate, processToken: "00000000-0000-4000-8000-000000000003" },
        ];
      },
    };
    const cleanup = createObserverDuplicateCleanup(
      {
        socketPath,
        keeperIdentity,
        boundSocketIdentity: socketIdentity,
        mode: "terminate",
        legacyQuarantineMs: 10,
      },
      { evidence: changingEvidence, exclusion: availableExclusion(), sleep: async () => undefined },
    );

    await expect(cleanup.run()).resolves.toMatchObject({
      status: "refused",
      refusalCodes: expect.arrayContaining(["candidate-changed-during-quarantine"]),
    });
    expect(signals).toEqual([]);
  });

  it.each([
    { result: "refused" as const, code: "sigterm-refused", exitedPids: [] },
    { result: "absent" as const, code: "candidate-exited-before-signal", exitedPids: [200] },
  ])("reports a $result SIGTERM syscall without claiming termination", async (expected) => {
    const { evidence, signals } = createEvidence();
    const refusingEvidence: ObserverDuplicateProcessEvidenceSource = {
      ...evidence,
      signal: (pid, signal) => {
        signals.push([pid, signal]);
        return pid === 200 && signal === "SIGTERM" ? expected.result : "sent";
      },
    };
    const cleanup = createObserverDuplicateCleanup(
      {
        socketPath,
        keeperIdentity,
        boundSocketIdentity: socketIdentity,
        mode: "terminate",
        legacyQuarantineMs: 10,
      },
      { evidence: refusingEvidence, exclusion: availableExclusion(), sleep: async () => undefined },
    );

    await expect(cleanup.run()).resolves.toMatchObject({
      status: "refused",
      refusalCodes: expect.arrayContaining([expected.code]),
      terminatedPids: [],
      exitedPids: expected.exitedPids,
    });
  });

  it("surfaces boot-claim release failure on a report-only result", async () => {
    const { evidence, signals } = createEvidence();
    const cleanup = createObserverDuplicateCleanup(
      {
        socketPath,
        keeperIdentity,
        boundSocketIdentity: socketIdentity,
        mode: "report",
        legacyQuarantineMs: 10,
      },
      {
        evidence,
        exclusion: {
          runExclusive: async (operation) => ({
            status: "completed",
            value: await operation(),
            released: false,
          }),
        },
        sleep: async () => undefined,
      },
    );

    await expect(cleanup.run()).resolves.toMatchObject({
      status: "would-terminate",
      claimReleased: false,
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

  it("does not signal again when shutdown cancels the SIGTERM grace period", async () => {
    const { evidence, signals } = createEvidence({ surviveSigterm: true });
    let sleepCalls = 0;
    let cleanup: ReturnType<typeof createObserverDuplicateCleanup>;
    cleanup = createObserverDuplicateCleanup(
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
        sleep: (_ms, signal) => {
          sleepCalls += 1;
          if (sleepCalls === 1) return Promise.resolve();
          queueMicrotask(() => cleanup.abort());
          return new Promise((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        },
      },
    );

    await expect(cleanup.run()).resolves.toMatchObject({ status: "cancelled" });
    expect(signals).toEqual([[200, "SIGTERM"]]);
  });

  it("does not signal when shutdown cancels awaited final revalidation", async () => {
    const { evidence: originalEvidence, signals } = createEvidence();
    let identityReads = 0;
    let cleanup: ReturnType<typeof createObserverDuplicateCleanup>;
    const evidence: ObserverDuplicateProcessEvidenceSource = {
      ...originalEvidence,
      readProcessIdentity: async () => {
        identityReads += 1;
        if (identityReads === 2) {
          queueMicrotask(() => cleanup.abort());
          await Promise.resolve();
        }
        return keeperIdentity;
      },
    };
    cleanup = createObserverDuplicateCleanup(
      {
        socketPath,
        keeperIdentity,
        boundSocketIdentity: socketIdentity,
        mode: "terminate",
        legacyQuarantineMs: 10,
      },
      { evidence, exclusion: availableExclusion(), sleep: async () => undefined },
    );

    await expect(cleanup.run()).resolves.toMatchObject({ status: "cancelled" });
    expect(signals).toEqual([]);
  });
});

describe("manual Observer reap", () => {
  it("refuses force while startup owns the boot claim", async () => {
    const { evidence, signals } = createEvidence();

    await expect(
      runObserverReap(
        socketPath,
        { force: true },
        {
          evidence,
          exclusion: { runExclusive: async () => ({ status: "busy" }) },
        },
      ),
    ).resolves.toMatchObject({ applied: false, aborted: "boot-claim-busy" });
    expect(signals).toEqual([]);
  });

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

  it("does not report successful force when boot-claim release fails", async () => {
    let candidateAlive = true;
    const { evidence } = createEvidence();
    const terminatingEvidence: ObserverDuplicateProcessEvidenceSource = {
      ...evidence,
      processStartToken: (pid) =>
        pid === 100 ? "keeper-start" : candidateAlive ? "candidate-start" : undefined,
      listObserverProcesses: () => [
        processEntry(100, "keeper-start"),
        ...(candidateAlive ? [processEntry(200, "candidate-start")] : []),
      ],
      signal: (pid, signal) => {
        if (pid === 200 && signal === "SIGTERM") candidateAlive = false;
        if (pid === 200 && signal === 0) return candidateAlive ? "sent" : "absent";
        return "sent";
      },
    };

    await expect(
      runObserverReap(
        socketPath,
        { force: true, graceMs: 0 },
        {
          evidence: terminatingEvidence,
          exclusion: {
            runExclusive: async (operation) => ({
              status: "completed",
              value: await operation(),
              released: false,
            }),
          },
          sleep: async () => undefined,
        },
      ),
    ).resolves.toMatchObject({
      applied: true,
      killed: [200],
      aborted: "boot-claim-release-failed",
      claimReleased: false,
    });
  });

  it("refuses a target whose Unix-socket evidence changes before SIGTERM", async () => {
    const { evidence, signals } = createEvidence();
    let fdReads = 0;
    const changingEvidence: ObserverDuplicateProcessEvidenceSource = {
      ...evidence,
      unixSocketFdCount: () => (fdReads++ === 0 ? 0 : 1),
    };

    await expect(
      runObserverReap(socketPath, { force: true }, { evidence: changingEvidence }),
    ).resolves.toMatchObject({ applied: false, aborted: "target-changed" });
    expect(signals).toEqual([]);
  });

  it("revalidates a changed target after grace and never sends SIGKILL", async () => {
    let changed = false;
    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    const { evidence } = createEvidence({ surviveSigterm: true });
    const changingEvidence: ObserverDuplicateProcessEvidenceSource = {
      ...evidence,
      listObserverProcesses: () => [
        processEntry(100, "keeper-start"),
        {
          ...processEntry(200, "candidate-start"),
          processToken: changed
            ? "00000000-0000-4000-8000-000000000003"
            : "00000000-0000-4000-8000-000000000002",
        },
      ],
      signal: (pid, signal) => {
        signals.push([pid, signal]);
        return "sent";
      },
    };

    await expect(
      runObserverReap(
        socketPath,
        { force: true, graceMs: 0 },
        {
          evidence: changingEvidence,
          sleep: async () => {
            changed = true;
          },
        },
      ),
    ).resolves.toMatchObject({ applied: true, aborted: "target-changed", killed: [] });
    expect(signals.filter(([, signal]) => signal === "SIGKILL")).toEqual([]);
  });

  it("revalidates the socket owner after grace and never sends SIGKILL", async () => {
    let holder = 100;
    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    const { evidence } = createEvidence({ surviveSigterm: true });
    const changingEvidence: ObserverDuplicateProcessEvidenceSource = {
      ...evidence,
      socketHolders: () => [holder],
      signal: (pid, signal) => {
        signals.push([pid, signal]);
        return "sent";
      },
    };

    await expect(
      runObserverReap(
        socketPath,
        { force: true, graceMs: 0 },
        {
          evidence: changingEvidence,
          sleep: async () => {
            holder = 999;
          },
        },
      ),
    ).resolves.toMatchObject({ applied: true, aborted: "owner-changed", killed: [] });
    expect(signals.filter(([, signal]) => signal === "SIGKILL")).toEqual([]);
  });

  it("revalidates the healthy keeper after grace and never sends SIGKILL", async () => {
    let healthReads = 0;
    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    const { evidence } = createEvidence({ surviveSigterm: true });
    const changingEvidence: ObserverDuplicateProcessEvidenceSource = {
      ...evidence,
      signal: (pid, signal) => {
        signals.push([pid, signal]);
        return "sent";
      },
    };

    await expect(
      runObserverReap(
        socketPath,
        { force: true, graceMs: 0 },
        {
          evidence: changingEvidence,
          healthPid: async () => (healthReads++ < 2 ? 100 : 999),
          sleep: async () => undefined,
        },
      ),
    ).resolves.toMatchObject({ applied: true, aborted: "owner-changed", killed: [] });
    expect(signals.filter(([, signal]) => signal === "SIGKILL")).toEqual([]);
  });

  it("reports an unchanged SIGKILL survivor without claiming success", async () => {
    const { evidence } = createEvidence({ surviveSigterm: true });
    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    const stubbornEvidence: ObserverDuplicateProcessEvidenceSource = {
      ...evidence,
      signal: (pid, signal) => {
        signals.push([pid, signal]);
        return "sent";
      },
    };

    await expect(
      runObserverReap(
        socketPath,
        { force: true, graceMs: 0 },
        { evidence: stubbornEvidence, sleep: async () => undefined },
      ),
    ).resolves.toMatchObject({ applied: true, killed: [], survived: [200] });
    expect(signals).toContainEqual([200, "SIGKILL"]);
  });

  it("reports a target that exits before SIGKILL without claiming the kill", async () => {
    let candidateAlive = true;
    const { evidence } = createEvidence({ surviveSigterm: true });
    const exitingEvidence: ObserverDuplicateProcessEvidenceSource = {
      ...evidence,
      processStartToken: (pid) =>
        pid === 100 ? "keeper-start" : candidateAlive ? "candidate-start" : undefined,
      listObserverProcesses: () => [
        processEntry(100, "keeper-start"),
        ...(candidateAlive ? [processEntry(200, "candidate-start")] : []),
      ],
      signal: (pid, signal) => {
        if (pid === 200 && signal === "SIGKILL") {
          candidateAlive = false;
          return "absent";
        }
        if (pid === 200 && signal === 0) return candidateAlive ? "sent" : "absent";
        return "sent";
      },
    };

    await expect(
      runObserverReap(
        socketPath,
        { force: true, graceMs: 0 },
        { evidence: exitingEvidence, sleep: async () => undefined },
      ),
    ).resolves.toMatchObject({ applied: true, killed: [], exited: [200], survived: [] });
  });

  it("reports signal refusal without classifying the target as killed", async () => {
    const { evidence } = createEvidence({ surviveSigterm: true });
    const refusingEvidence: ObserverDuplicateProcessEvidenceSource = {
      ...evidence,
      signal: (pid, signal) => (pid === 200 && signal === "SIGTERM" ? "refused" : "sent"),
    };

    await expect(
      runObserverReap(socketPath, { force: true }, { evidence: refusingEvidence }),
    ).resolves.toMatchObject({
      applied: false,
      aborted: "signal-refused",
      killed: [],
      survived: [],
    });
  });
});
