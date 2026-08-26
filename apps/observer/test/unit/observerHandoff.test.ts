import type { ObserverHealth, ObserverProcessIdentity } from "@station/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  classifyObserverBuildPrecedence,
  classifyObserverIncumbent,
  negotiateObserverIncumbent,
  type ObserverIncumbentLifecycle,
  type ObserverProcessEvidenceSource,
  type ObserverProcessSignalResult,
} from "../../src/runtime/observerHandoff.js";

const socketPath = "/tmp/station/observer.sock";
const candidate = {
  version: "2.0.0",
  startedAt: "2026-07-12T12:00:00.000Z",
  pid: 200,
};
const lowerBuildIdentity = "1".repeat(64);
const higherBuildIdentity = "e".repeat(64);

describe("classifyObserverBuildPrecedence", () => {
  it("classifies only an exact identified selector as the exact build", () => {
    const exact = observerBuildVersion("2.0.0", lowerBuildIdentity);

    expect(precedenceFor(exact, exact)).toEqual({ outcome: "exact-build" });
    expect(precedenceFor("2.0.0", "2.0.0")).toEqual({
      outcome: "refused",
      reason: "Same-version Observer reuse requires immutable build identity.",
    });
  });

  it("orders different immutable builds at one display version in only the admitted direction", () => {
    const lower = observerBuildVersion("2.0.0", lowerBuildIdentity);
    const higher = observerBuildVersion("2.0.0", higherBuildIdentity);

    expect(precedenceFor(higher, lower)).toEqual({ outcome: "candidate-precedes" });
    expect(precedenceFor(lower, higher)).toEqual({
      outcome: "refused",
      reason: "A different build of this Station version already owns the Observer socket.",
    });
  });

  it("refuses incomplete immutable identity at one display version", () => {
    const identified = observerBuildVersion("2.0.0", higherBuildIdentity);
    const refusal = {
      outcome: "refused",
      reason: "Same-version Observer handoff requires build identity from both contenders.",
    } as const;

    expect(precedenceFor(identified, "2.0.0")).toEqual(refusal);
    expect(precedenceFor("2.0.0", identified)).toEqual(refusal);
  });

  it("orders newer and older SemVer without numeric truncation", () => {
    expect(precedenceFor("100000000000000000000.0.0", "99999999999999999999.0.0")).toEqual({
      outcome: "candidate-precedes",
    });
    expect(precedenceFor("2.0.0-rc.10", "2.0.0-rc.2")).toEqual({
      outcome: "candidate-precedes",
    });
    expect(precedenceFor("1.9.9", "2.0.0")).toEqual({ outcome: "incumbent-precedes" });
  });

  it("uses both directions of the exact selector as the equal-SemVer tiebreak", () => {
    expect(precedenceFor("2.0.0+candidate", "2.0.0+incumbent")).toEqual({
      outcome: "incumbent-precedes",
    });
    expect(precedenceFor("2.0.0+incumbent", "2.0.0+candidate")).toEqual({
      outcome: "candidate-precedes",
    });
  });

  it("orders the public pre-alpha after the internal preview version line", () => {
    const publicPreAlpha = observerBuildVersion("0.0.0-pre-alpha.7", higherBuildIdentity);
    const internalPreview = observerBuildVersion("0.7.1-rc.8", lowerBuildIdentity);

    expect(precedenceFor(publicPreAlpha, internalPreview)).toEqual({
      outcome: "candidate-precedes",
    });
    expect(precedenceFor(internalPreview, publicPreAlpha)).toEqual({
      outcome: "incumbent-precedes",
    });
  });

  it("orders the next public pre-alpha epoch after the prior release", () => {
    const nextEpoch = observerBuildVersion("0.0.0-pre-alpha.7", higherBuildIdentity);
    const priorRelease = observerBuildVersion("0.0.0-pre-alpha.6", lowerBuildIdentity);

    expect(precedenceFor(nextEpoch, priorRelease)).toEqual({
      outcome: "candidate-precedes",
    });
    expect(precedenceFor(priorRelease, nextEpoch)).toEqual({
      outcome: "incumbent-precedes",
    });
  });

  it.each([
    `2.0.0+station.${"A".repeat(64)}`,
    `2.0.0+station.${"a".repeat(63)}`,
    `2.0.0+station.${"a".repeat(65)}`,
    `2.0.0+station.${"g".repeat(64)}`,
    `2.0.0+station.${lowerBuildIdentity}.station.${higherBuildIdentity}`,
  ])("refuses malformed reserved build identity %s", (malformed) => {
    const identified = observerBuildVersion("2.0.0", higherBuildIdentity);

    expect(precedenceFor(malformed, identified)).toEqual({
      outcome: "refused",
      reason: "The candidate Observer build identity is invalid.",
    });
    expect(precedenceFor(identified, malformed)).toEqual({
      outcome: "refused",
      reason: "The incumbent Observer build identity is invalid.",
    });
  });

  it("refuses invalid or absent selectors in candidate-first order", () => {
    expect(precedenceFor("v2.0.0", undefined)).toEqual({
      outcome: "refused",
      reason: "The candidate Observer version is not valid SemVer.",
    });
    expect(precedenceFor("2.0.0", undefined)).toEqual({
      outcome: "refused",
      reason: "The incumbent Observer did not report a version.",
    });
    expect(precedenceFor("2.0.0", "v1.0.0")).toEqual({
      outcome: "refused",
      reason: "The incumbent Observer version is not valid SemVer.",
    });
  });
});

describe("classifyObserverIncumbent", () => {
  const exactSelector = observerBuildVersion("2.0.0", lowerBuildIdentity);
  const lowerSelector = observerBuildVersion("2.0.0", lowerBuildIdentity);
  const higherSelector = observerBuildVersion("2.0.0", higherBuildIdentity);
  const mappingCases: ReadonlyArray<{
    name: string;
    candidateSelector: string;
    incumbent: Pick<ObserverHealth, "version" | "startedAt" | "pid">;
    precedence: ReturnType<typeof classifyObserverBuildPrecedence>;
    decision: ReturnType<typeof classifyObserverIncumbent>;
  }> = [
    {
      name: "exact build",
      candidateSelector: exactSelector,
      incumbent: { version: exactSelector },
      precedence: { outcome: "exact-build" },
      decision: { action: "attach", reason: "exact-build" },
    },
    {
      name: "candidate precedence",
      candidateSelector: higherSelector,
      incumbent: {
        version: lowerSelector,
        startedAt: "2026-07-12T11:59:59.000Z",
        pid: 100,
      },
      precedence: { outcome: "candidate-precedes" },
      decision: { action: "replace", reason: "candidate-wins" },
    },
    {
      name: "incumbent precedence without mutation identity",
      candidateSelector: "1.0.0",
      incumbent: { version: "2.0.0" },
      precedence: { outcome: "incumbent-precedes" },
      decision: { action: "attach", reason: "incumbent-wins" },
    },
    {
      name: "refusal passthrough",
      candidateSelector: "2.0.0",
      incumbent: {},
      precedence: {
        outcome: "refused",
        reason: "The incumbent Observer did not report a version.",
      },
      decision: {
        action: "refuse",
        reason: "The incumbent Observer did not report a version.",
      },
    },
  ];

  it.each(mappingCases)("maps $name", ({ candidateSelector, incumbent, precedence, decision }) => {
    expect(
      classifyObserverBuildPrecedence({
        candidateSelector,
        incumbentSelector: incumbent.version,
      }),
    ).toEqual(precedence);
    expect(
      classifyObserverIncumbent({
        candidate: { ...candidate, version: candidateSelector },
        incumbent,
      }),
    ).toEqual(decision);
  });

  it.each([
    { startedAt: undefined, pid: 100 },
    { startedAt: candidate.startedAt, pid: undefined },
  ])("refuses candidate precedence without complete incumbent process identity %#", (incumbent) => {
    const lower = observerBuildVersion("2.0.0", lowerBuildIdentity);
    const higher = observerBuildVersion("2.0.0", higherBuildIdentity);

    expect(precedenceFor(higher, lower)).toEqual({ outcome: "candidate-precedes" });
    expect(
      classifyObserverIncumbent({
        candidate: { ...candidate, version: higher },
        incumbent: { ...incumbent, version: lower },
      }),
    ).toEqual({
      action: "refuse",
      reason: "Replacing a different-build Observer requires complete incumbent identity.",
    });
  });

  it("keeps parent and child equal-precedence decisions consistent", () => {
    const incumbent = {
      version: "2.0.0+incumbent",
      startedAt: "2026-07-12T11:30:00.000Z",
      pid: 100,
    };
    const parent = {
      version: "2.0.0+candidate",
      startedAt: "2026-07-12T11:00:00.000Z",
      pid: 10,
    };
    const child = {
      version: "2.0.0+candidate",
      startedAt: "2026-07-12T12:00:00.000Z",
      pid: 200,
    };

    expect(classifyObserverIncumbent({ candidate: parent, incumbent })).toEqual(
      classifyObserverIncumbent({ candidate: child, incumbent }),
    );
    const winningParent = { ...parent, version: "2.0.0+winner" };
    const winningChild = { ...child, version: "2.0.0+winner" };
    expect(classifyObserverIncumbent({ candidate: winningParent, incumbent })).toEqual(
      classifyObserverIncumbent({ candidate: winningChild, incumbent }),
    );
    expect(classifyObserverIncumbent({ candidate: winningChild, incumbent }).action).toBe(
      "replace",
    );
  });

  it("never lets both members of an equal-precedence pair replace each other", () => {
    const first = {
      version: "2.0.0+first",
      startedAt: candidate.startedAt,
      pid: 20,
    };
    const second = {
      version: "2.0.0+second",
      startedAt: candidate.startedAt,
      pid: 30,
    };

    expect(classifyObserverIncumbent({ candidate: first, incumbent: second }).action).toBe(
      "attach",
    );
    expect(classifyObserverIncumbent({ candidate: second, incumbent: first }).action).toBe(
      "replace",
    );
  });
});

describe("negotiateObserverIncumbent", () => {
  it("passes one shrinking absolute deadline through health and stop", async () => {
    const fixture = handoffFixture();
    const healthTimeouts: number[] = [];
    const stopTimeouts: number[] = [];
    fixture.health.mockImplementation(async (_socketPath, request) => {
      healthTimeouts.push(request.timeoutMs);
      fixture.time += 5;
      return fixture.incumbentHealth;
    });
    fixture.stop.mockImplementation(async (_socketPath, request) => {
      stopTimeouts.push(request.timeoutMs);
      fixture.time += 5;
      fixture.listening = false;
      fixture.startToken = undefined;
      return {
        schemaVersion: "0.11.0" as const,
        stopped: true,
        at: "2026-07-12T12:00:00.000Z",
      };
    });

    await expect(runNegotiation(fixture)).resolves.toMatchObject({ action: "replaced" });
    expect(healthTimeouts).toEqual([40, 35]);
    expect(stopTimeouts).toEqual([10]);
    expect(fixture.stop).toHaveBeenCalledWith(socketPath, {
      timeoutMs: 10,
      expectedObserver: {
        pid: fixture.incumbentHealth.pid,
        startedAt: fixture.incumbentHealth.startedAt,
        version: fixture.incumbentHealth.version,
        socketPath,
      },
    });
  });

  it("does not begin stop after earlier lifecycle calls exhaust the deadline", async () => {
    const fixture = handoffFixture();
    const healthTimeouts: number[] = [];
    fixture.health.mockImplementation(async (_socketPath, request) => {
      healthTimeouts.push(request.timeoutMs);
      fixture.time += 20;
      return fixture.incumbentHealth;
    });

    await expect(runNegotiation(fixture)).rejects.toMatchObject({
      code: "OBSERVER_HANDOFF_REFUSED",
    });
    expect(healthTimeouts).toEqual([40, 20]);
    expect(fixture.stop).not.toHaveBeenCalled();
    expect(fixture.signal).not.toHaveBeenCalled();
  });

  it("preserves the incumbent when replacement prerequisites fail", async () => {
    const fixture = handoffFixture();
    const prerequisiteFailure = Object.assign(new Error("hook reconciliation failed"), {
      tag: "HarnessProviderError",
      code: "HARNESS_HOOK_RECONCILIATION_FAILED",
    });
    const prepareReplacement = vi.fn(async () => {
      throw prerequisiteFailure;
    });

    const failure = await runNegotiation(fixture, 40, { prepareReplacement }).catch(
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({
      code: "OBSERVER_HANDOFF_REFUSED",
      cause: prerequisiteFailure,
    });
    expect(prepareReplacement).toHaveBeenCalledWith({ timeoutMs: 40 });
    expect(fixture.health).toHaveBeenCalledTimes(1);
    expect(fixture.stop).not.toHaveBeenCalled();
    expect(fixture.signal).not.toHaveBeenCalled();
  });

  it("revalidates the exact incumbent after replacement prerequisites", async () => {
    const fixture = handoffFixture();
    const order: string[] = [];
    fixture.health.mockImplementation(async () => {
      order.push("health");
      return fixture.incumbentHealth;
    });
    fixture.stop.mockImplementation(async () => {
      order.push("stop");
      fixture.listening = false;
      fixture.startToken = undefined;
      return {
        schemaVersion: "0.11.0" as const,
        stopped: true,
        at: "2026-07-12T12:00:00.000Z",
      };
    });

    await expect(
      runNegotiation(fixture, 40, {
        prepareReplacement: async () => {
          order.push("prepare");
        },
        commitReplacement: () => {
          order.push("commit");
        },
      }),
    ).resolves.toMatchObject({ action: "replaced" });

    expect(order).toEqual(["health", "prepare", "health", "commit", "stop"]);
  });

  it("preserves the incumbent when cancellation wins immediately before replacement commit", async () => {
    const fixture = handoffFixture();
    const cancellation = Object.assign(new Error("candidate cancelled"), {
      tag: "ObserverStartupError",
      code: "OBSERVER_STARTUP_CANCELLED",
    });

    const failure = await runNegotiation(fixture, 40, {
      prepareReplacement: async () => undefined,
      commitReplacement: () => {
        throw cancellation;
      },
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "OBSERVER_HANDOFF_REFUSED",
      cause: cancellation,
    });
    expect(fixture.stop).not.toHaveBeenCalled();
    expect(fixture.signal).not.toHaveBeenCalled();
  });

  it("does not stop when replacement prerequisites consume the handoff deadline", async () => {
    const fixture = handoffFixture();

    await expect(
      runNegotiation(fixture, 40, {
        prepareReplacement: async () => {
          fixture.time = 40;
        },
      }),
    ).rejects.toMatchObject({ code: "OBSERVER_HANDOFF_REFUSED" });

    expect(fixture.health).toHaveBeenCalledTimes(1);
    expect(fixture.stop).not.toHaveBeenCalled();
    expect(fixture.signal).not.toHaveBeenCalled();
  });

  it("bounds the stop acknowledgement wait so exact-exit fallback keeps the handoff budget", async () => {
    const fixture = handoffFixture();

    await expect(runNegotiation(fixture, 4_000)).rejects.toMatchObject({
      code: "OBSERVER_HANDOFF_REFUSED",
    });
    expect(fixture.stop).toHaveBeenCalledWith(socketPath, {
      timeoutMs: 1_000,
      expectedObserver: {
        pid: fixture.incumbentHealth.pid,
        startedAt: fixture.incumbentHealth.startedAt,
        version: fixture.incumbentHealth.version,
        socketPath,
      },
    });
  });

  it("refuses when the exact process changes between verification and stop", async () => {
    const fixture = handoffFixture();
    const replacementHealth = {
      ...fixture.incumbentHealth,
      pid: 200,
      startedAt: "2026-07-12T11:30:00.000Z",
    };
    fixture.health
      .mockResolvedValueOnce(fixture.incumbentHealth)
      .mockImplementationOnce(async () => {
        fixture.identity.pid = replacementHealth.pid;
        fixture.identity.osStartTime = "Sat Jul 12 11:30:00 2026";
        fixture.holders[0] = replacementHealth.pid;
        fixture.startToken = fixture.identity.osStartTime;
        return replacementHealth;
      });

    await expect(runNegotiation(fixture)).rejects.toMatchObject({
      code: "OBSERVER_HANDOFF_REFUSED",
      message: "The incumbent Observer process changed during handoff.",
    });
    expect(fixture.stop).not.toHaveBeenCalled();
    expect(fixture.signal).not.toHaveBeenCalled();
  });

  it("requires lsof, health, pidfile, argv, and OS start-token agreement", async () => {
    const fixture = handoffFixture();
    fixture.holders.splice(0, 1, 999);

    await expect(runNegotiation(fixture)).rejects.toMatchObject({
      code: "OBSERVER_HANDOFF_REFUSED",
    });
    expect(fixture.stop).not.toHaveBeenCalled();
    expect(fixture.signal).not.toHaveBeenCalled();
  });

  it("refuses unavailable holder evidence before stop or signal", async () => {
    const fixture = handoffFixture();
    fixture.evidence.socketHolders = () => {
      throw Object.assign(new Error("lsof unavailable"), {
        code: "PROTOCOL_SOCKET_EVIDENCE_UNAVAILABLE",
      });
    };

    await expect(runNegotiation(fixture)).rejects.toMatchObject({
      code: "OBSERVER_HANDOFF_REFUSED",
    });
    expect(fixture.stop).not.toHaveBeenCalled();
    expect(fixture.signal).not.toHaveBeenCalled();
  });

  it("preserves a typed process-evidence failure as the handoff refusal cause", async () => {
    const fixture = handoffFixture();
    const evidenceFailure = Object.assign(
      new Error("Observer process evidence did not match the exact executable and argv."),
      {
        tag: "ObserverProcessEvidenceError",
        code: "OBSERVER_PROCESS_EXECUTABLE_ARGV_MISMATCH",
        message: "Observer process evidence did not match the exact executable and argv.",
      },
    );
    fixture.evidence.readObserverProcess = () => {
      throw evidenceFailure;
    };

    const failure = await runNegotiation(fixture).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "OBSERVER_HANDOFF_REFUSED",
      cause: evidenceFailure,
    });
    expect(fixture.stop).not.toHaveBeenCalled();
    expect(fixture.signal).not.toHaveBeenCalled();
  });

  it("treats a stop receipt as acknowledgement and waits for socket closure and exact death", async () => {
    const fixture = handoffFixture();
    let sleeps = 0;
    fixture.sleep.mockImplementation(async (ms) => {
      fixture.time += ms;
      sleeps += 1;
      if (sleeps === 2) {
        fixture.listening = false;
        fixture.startToken = undefined;
      }
    });

    await expect(runNegotiation(fixture)).resolves.toMatchObject({ action: "replaced" });
    expect(sleeps).toBe(2);
    expect(fixture.signal).toHaveBeenCalledWith(100, 0);
    expect(fixture.signal).not.toHaveBeenCalledWith(100, "SIGTERM");
  });

  it("recovers from a timed-out stop acknowledgement through verified SIGTERM", async () => {
    const fixture = handoffFixture();
    fixture.stop.mockRejectedValue(new Error("stop acknowledgement timed out"));
    fixture.signal.mockImplementation((_pid, signal) => {
      if (signal === "SIGTERM") {
        fixture.listening = false;
        fixture.startToken = undefined;
      }
      return signal === 0 && fixture.startToken === undefined ? "absent" : "sent";
    });

    await expect(runNegotiation(fixture)).resolves.toMatchObject({ action: "replaced" });
    expect(fixture.signal).toHaveBeenCalledWith(100, "SIGTERM");
  });

  it("revalidates complete ownership before one SIGTERM and never sends SIGKILL", async () => {
    const fixture = handoffFixture();
    fixture.signal.mockImplementation((_pid, signal) => {
      if (signal === "SIGTERM") {
        fixture.listening = false;
        fixture.startToken = undefined;
      }
      return signal === 0 && fixture.startToken === undefined ? "absent" : "sent";
    });

    await expect(runNegotiation(fixture)).resolves.toMatchObject({ action: "replaced" });
    expect(fixture.health).toHaveBeenCalledTimes(2);
    expect(fixture.signal.mock.calls.filter(([, signal]) => signal === "SIGTERM")).toHaveLength(1);
    expect(fixture.signal).toHaveBeenCalledWith(100, "SIGTERM");
    expect(fixture.signal).not.toHaveBeenCalledWith(100, "SIGKILL");
  });

  it("does not treat socket closure as exact process death", async () => {
    const fixture = handoffFixture();
    fixture.stop.mockImplementation(async () => {
      fixture.listening = false;
      return {
        schemaVersion: "0.11.0" as const,
        stopped: true,
        at: "2026-07-12T12:00:00.000Z",
      };
    });
    fixture.signal.mockImplementation((_pid, signal) => {
      if (signal === "SIGTERM") fixture.startToken = undefined;
      return signal === 0 && fixture.startToken === undefined ? "absent" : "sent";
    });

    await expect(runNegotiation(fixture)).resolves.toMatchObject({ action: "replaced" });
    expect(fixture.signal).toHaveBeenCalledWith(100, "SIGTERM");
  });

  it("waits passively when shutdown removes signal evidence before exact process exit", async () => {
    const fixture = handoffFixture();
    let identityReads = 0;
    fixture.evidence.readProcessIdentity = async () => {
      identityReads += 1;
      return identityReads > 4 ? undefined : { ...fixture.identity };
    };
    fixture.stop.mockImplementation(async () => {
      fixture.listening = false;
      return {
        schemaVersion: "0.11.0" as const,
        stopped: true,
        at: "2026-07-12T12:00:00.000Z",
      };
    });
    fixture.sleep.mockImplementation(async (ms) => {
      fixture.time += ms;
      if (fixture.time >= 30) fixture.startToken = undefined;
    });

    await expect(runNegotiation(fixture)).resolves.toMatchObject({ action: "replaced" });
    expect(fixture.signal).not.toHaveBeenCalledWith(100, "SIGTERM");
  });

  it("does not treat exact process death as socket closure", async () => {
    const fixture = handoffFixture();
    fixture.stop.mockImplementation(async () => {
      fixture.startToken = undefined;
      return {
        schemaVersion: "0.11.0" as const,
        stopped: true,
        at: "2026-07-12T12:00:00.000Z",
      };
    });

    await expect(runNegotiation(fixture)).rejects.toMatchObject({
      code: "OBSERVER_HANDOFF_REFUSED",
    });
    expect(fixture.signal).not.toHaveBeenCalledWith(100, "SIGTERM");
  });

  it("refuses an inaccessible exit probe before absence or termination signals", async () => {
    const fixture = handoffFixture();
    fixture.lifecycle.socketListening = async () => {
      throw { code: "OBSERVER_SOCKET_INACCESSIBLE" };
    };

    await expect(runNegotiation(fixture)).rejects.toMatchObject({
      code: "OBSERVER_HANDOFF_REFUSED",
    });
    expect(fixture.signal).not.toHaveBeenCalled();
  });

  it("proves incumbent absence without enumerating the live successor", async () => {
    const fixture = handoffFixture();
    fixture.stop.mockImplementation(async () => {
      fixture.listening = false;
      fixture.startToken = undefined;
      fixture.evidence.readObserverProcess = () => {
        throw new Error("successor process evidence is unavailable");
      };
      return {
        schemaVersion: "0.11.0" as const,
        stopped: true,
        at: "2026-07-12T12:00:00.000Z",
      };
    });

    await expect(runNegotiation(fixture)).resolves.toMatchObject({ action: "replaced" });
    expect(fixture.signal).toHaveBeenCalledWith(100, 0);
    expect(fixture.signal).not.toHaveBeenCalledWith(100, "SIGTERM");
  });

  it("does not treat unreadable process identity as exact death", async () => {
    const fixture = handoffFixture();
    fixture.stop.mockImplementation(async () => {
      fixture.listening = false;
      fixture.startToken = undefined;
      return {
        schemaVersion: "0.11.0" as const,
        stopped: true,
        at: "2026-07-12T12:00:00.000Z",
      };
    });
    fixture.signal.mockImplementation((_pid, signal) => (signal === 0 ? "refused" : "sent"));

    await expect(runNegotiation(fixture)).rejects.toMatchObject({
      code: "OBSERVER_HANDOFF_REFUSED",
    });
    expect(fixture.signal).toHaveBeenCalledWith(100, 0);
    expect(fixture.signal).not.toHaveBeenCalledWith(100, "SIGTERM");
  });

  it("refuses a wedged incumbent after the one allowed SIGTERM", async () => {
    const fixture = handoffFixture();

    await expect(runNegotiation(fixture)).rejects.toMatchObject({
      code: "OBSERVER_HANDOFF_REFUSED",
    });
    expect(fixture.signal).toHaveBeenCalledTimes(1);
    expect(fixture.signal).toHaveBeenCalledWith(100, "SIGTERM");
  });
});

function precedenceFor(candidateSelector: string, incumbentSelector: string | undefined) {
  return classifyObserverBuildPrecedence({ candidateSelector, incumbentSelector });
}

function observerBuildVersion(version: string, buildIdentity: string): string {
  return `${version}${version.includes("+") ? "." : "+"}station.${buildIdentity}`;
}

function handoffFixture() {
  const incumbentHealth: ObserverHealth = {
    schemaVersion: "0.11.0",
    status: "healthy",
    pid: 100,
    startedAt: "2026-07-12T11:00:00.000Z",
    version: "1.0.0",
    socketPath,
  };
  const identity: ObserverProcessIdentity = {
    pid: 100,
    osStartTime: "Sat Jul 12 11:00:00 2026",
    processToken: "00000000-0000-4000-8000-000000000001",
    version: "1.0.0",
    socketPath,
  };
  const fixture = {
    time: 0,
    listening: true,
    startToken: identity.osStartTime as string | undefined,
    holders: [identity.pid],
    incumbentHealth,
    health: vi.fn(async (_socketPath: string, _request: { timeoutMs: number }) => incumbentHealth),
    stop: vi.fn(async (_socketPath: string, _request: { timeoutMs: number }) => ({
      schemaVersion: "0.11.0" as const,
      stopped: true,
      at: "2026-07-12T12:00:00.000Z",
    })),
    signal: vi.fn(
      (_pid: number, requestedSignal: NodeJS.Signals | 0): ObserverProcessSignalResult =>
        requestedSignal === 0 ? "absent" : "sent",
    ),
    sleep: vi.fn(async (ms: number) => {
      fixture.time += ms;
    }),
  };
  const lifecycle: ObserverIncumbentLifecycle = {
    health: fixture.health,
    stop: fixture.stop,
    socketListening: async () => fixture.listening,
  };
  const evidence: ObserverProcessEvidenceSource = {
    readObserverProcess: (pid) =>
      pid === identity.pid
        ? {
            pid: identity.pid,
            argv: ["/opt/station/stn", "__observer", "--socket", socketPath],
            executablePath: "/opt/station/stn",
            startToken: identity.osStartTime,
            processToken: identity.processToken,
            buildVersion: identity.version,
            socketPath,
          }
        : undefined,
    socketHolders: () => fixture.holders,
    processStartToken: () => fixture.startToken,
    readProcessIdentity: async () => ({ ...identity }),
    signal: fixture.signal,
  };
  return Object.assign(fixture, { lifecycle, evidence, identity });
}

function runNegotiation(
  fixture: ReturnType<typeof handoffFixture>,
  timeoutMs = 40,
  deps: {
    prepareReplacement?: (request: { timeoutMs: number }) => Promise<void>;
    commitReplacement?: () => void;
  } = {},
) {
  return negotiateObserverIncumbent(
    { socketPath, candidate, timeoutMs },
    {
      lifecycle: fixture.lifecycle,
      evidence: fixture.evidence,
      now: () => fixture.time,
      sleep: fixture.sleep,
      pollIntervalMs: 10,
      ...deps,
    },
  );
}
