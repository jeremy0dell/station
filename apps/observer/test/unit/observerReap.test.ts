import type { ObserverProcessIdentity } from "@station/contracts";
import { describe, expect, it } from "vitest";
import {
  createObserverReap,
  inspectObserverDuplicates,
  type ObserverDuplicateProcessEvidenceSource,
  type ObserverReapExclusion,
} from "../../src/runtime/observerReap.js";
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
    readObserverProcess: (pid) =>
      [
        processEntry(100, "keeper-start"),
        ...(candidateAlive ? [processEntry(200, "candidate-start")] : []),
      ].find((entry) => entry.pid === pid),
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

function availableExclusion(): ObserverReapExclusion {
  return {
    runExclusive: async (operation) => ({
      status: "completed",
      value: await operation(),
      released: true,
    }),
  };
}

describe("Observer duplicate inspection", () => {
  it("reports exact eligible evidence without signaling", async () => {
    const { evidence, signals } = createEvidence();
    const plan = await inspectObserverDuplicates(socketPath, {
      evidence,
      healthPid: async () => 100,
    });
    expect(plan).toMatchObject({ keeper: 100, duplicates: 1 });
    expect(plan.targets).toEqual([
      expect.objectContaining({
        pid: 200,
        startToken: "candidate-start",
        automaticEligibility: {
          eligible: true,
          quarantineMs: 10_000,
          refusalReasons: [],
        },
      }),
    ]);
    expect(signals).toEqual([]);
  });

  it("reports Unix-socket descriptor evidence as ineligible without signaling", async () => {
    const { evidence, signals } = createEvidence({ candidateFds: 1 });
    const plan = await inspectObserverDuplicates(socketPath, {
      evidence,
      healthPid: async () => 100,
    });
    expect(plan.targets[0]?.automaticEligibility).toMatchObject({
      eligible: false,
      refusalReasons: [expect.stringContaining("owns 1 Unix-socket descriptor")],
    });
    expect(signals).toEqual([]);
  });

  it.each([
    {
      name: "socket identity unavailable",
      evidence: () => ({
        ...createEvidence().evidence,
        socketIdentity: async () => undefined,
      }),
    },
    {
      name: "multiple holders",
      evidence: () => ({
        ...createEvidence().evidence,
        socketHolders: () => [100, 101],
      }),
    },
    {
      name: "pidfile changed",
      evidence: () => ({
        ...createEvidence().evidence,
        readProcessIdentity: async () => ({ ...keeperIdentity, osStartTime: "other" }),
      }),
    },
    {
      name: "keeper process changed",
      evidence: () => ({
        ...createEvidence().evidence,
        processStartToken: (pid: number) => (pid === 100 ? "other" : "candidate-start"),
      }),
    },
  ])("refuses automatic eligibility when $name", async ({ evidence }) => {
    const plan = await inspectObserverDuplicates(socketPath, {
      evidence: evidence(),
      healthPid: async () => 100,
    });
    expect(plan.targets[0]?.automaticEligibility.eligible).toBe(false);
    expect(plan.targets[0]?.automaticEligibility.refusalReasons).not.toEqual([]);
  });

  it("reports a clear plan without process mutation", async () => {
    const { evidence, signals } = createEvidence({ candidateAlive: false });
    await expect(
      inspectObserverDuplicates(socketPath, { evidence, healthPid: async () => 100 }),
    ).resolves.toMatchObject({ keeper: 100, duplicates: 0, targets: [] });
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
