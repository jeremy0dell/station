import type { ObserverHealth, ObserverProcessIdentity } from "@station/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  classifyObserverIncumbent,
  negotiateObserverIncumbent,
  type ObserverIncumbentLifecycle,
  type ObserverProcessEvidenceSource,
} from "../../src/runtime/observerHandoff.js";

const socketPath = "/tmp/station/observer.sock";
const candidate = {
  version: "2.0.0",
  startedAt: "2026-07-12T12:00:00.000Z",
  pid: 200,
};
const lowerBuildIdentity = "1".repeat(64);
const higherBuildIdentity = "e".repeat(64);

describe("classifyObserverIncumbent", () => {
  it("attaches to an exact build", () => {
    const buildVersion = observerBuildVersion("2.0.0", lowerBuildIdentity);
    expect(
      classifyObserverIncumbent({
        candidate: { ...candidate, version: buildVersion },
        incumbent: { version: buildVersion },
      }),
    ).toEqual({ action: "attach", reason: "exact-build" });
  });

  it("replaces only in the winning direction for different same-version builds", () => {
    const lower = observerBuildVersion("2.0.0", lowerBuildIdentity);
    const higher = observerBuildVersion("2.0.0", higherBuildIdentity);

    expect(decisionFor(higher, lower)).toEqual({
      action: "replace",
      reason: "candidate-wins",
    });
    expect(decisionFor(lower, higher)).toMatchObject({ action: "refuse" });
  });

  it("refuses same-version handoff when only one contender has build identity", () => {
    const identified = observerBuildVersion("2.0.0", higherBuildIdentity);

    expect(decisionFor(identified, "2.0.0")).toMatchObject({ action: "refuse" });
    expect(decisionFor("2.0.0", identified)).toMatchObject({ action: "refuse" });
  });

  it.each([
    `2.0.0+station.${"A".repeat(64)}`,
    `2.0.0+station.${"a".repeat(63)}`,
    `2.0.0+station.${"a".repeat(65)}`,
    `2.0.0+station.${"g".repeat(64)}`,
    `2.0.0+station.${lowerBuildIdentity}.station.${higherBuildIdentity}`,
  ])("refuses malformed reserved build identity %s", (malformed) => {
    const identified = observerBuildVersion("2.0.0", higherBuildIdentity);
    expect(decisionFor(identified, malformed)).toMatchObject({ action: "refuse" });
    expect(decisionFor(malformed, identified)).toMatchObject({ action: "refuse" });
  });

  it("refuses exact legacy reuse while retaining cross-version SemVer handoff", () => {
    expect(decisionFor("2.0.0", "2.0.0")).toMatchObject({ action: "refuse" });
    expect(
      decisionFor(
        observerBuildVersion("2.0.0", lowerBuildIdentity),
        observerBuildVersion("1.9.9", higherBuildIdentity),
      ),
    ).toEqual({ action: "replace", reason: "candidate-wins" });
    expect(
      decisionFor(
        observerBuildVersion("1.9.9", higherBuildIdentity),
        observerBuildVersion("2.0.0", lowerBuildIdentity),
      ),
    ).toEqual({ action: "attach", reason: "incumbent-wins" });
  });

  it("uses strict SemVer precedence without numeric truncation", () => {
    expect(decisionFor("100000000000000000000.0.0", "99999999999999999999.0.0")).toEqual({
      action: "replace",
      reason: "candidate-wins",
    });
    expect(decisionFor("2.0.0-rc.10", "2.0.0-rc.2")).toEqual({
      action: "replace",
      reason: "candidate-wins",
    });
    expect(decisionFor("1.9.9", "2.0.0")).toEqual({
      action: "attach",
      reason: "incumbent-wins",
    });
  });

  it("attaches to a valid higher incumbent without mutation-only identity fields", () => {
    expect(
      classifyObserverIncumbent({
        candidate: { ...candidate, version: "1.0.0" },
        incumbent: { version: "2.0.0" },
      }),
    ).toEqual({ action: "attach", reason: "incumbent-wins" });
  });

  it("uses the exact build string as a stable equal-precedence tiebreak", () => {
    expect(
      classifyObserverIncumbent({
        candidate: { ...candidate, version: "2.0.0+candidate", pid: 20 },
        incumbent: {
          version: "2.0.0+incumbent",
          startedAt: candidate.startedAt,
          pid: 30,
        },
      }),
    ).toEqual({ action: "attach", reason: "incumbent-wins" });
    expect(
      classifyObserverIncumbent({
        candidate: { ...candidate, version: "2.0.0+incumbent", pid: 30 },
        incumbent: {
          version: "2.0.0+candidate",
          startedAt: "2026-07-12T11:59:59.000Z",
          pid: 20,
        },
      }),
    ).toEqual({ action: "replace", reason: "candidate-wins" });
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

  it.each([
    { version: undefined, startedAt: candidate.startedAt, pid: 100 },
    { version: "v1.0.0", startedAt: candidate.startedAt, pid: 100 },
    { version: "1.0.0", startedAt: undefined, pid: 100 },
    { version: "1.0.0", startedAt: candidate.startedAt, pid: undefined },
  ])("refuses invalid or incomplete replacement identity %#", (incumbent) => {
    expect(classifyObserverIncumbent({ candidate, incumbent }).action).toBe("refuse");
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
        schemaVersion: "0.8.0" as const,
        stopped: true,
        at: "2026-07-12T12:00:00.000Z",
      };
    });

    await expect(runNegotiation(fixture)).resolves.toMatchObject({ action: "replaced" });
    expect(healthTimeouts).toEqual([40, 35]);
    expect(stopTimeouts).toEqual([30]);
    expect(fixture.stop).toHaveBeenCalledWith(socketPath, {
      timeoutMs: 30,
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
        schemaVersion: "0.8.0" as const,
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

  it("does not treat exact process death as socket closure", async () => {
    const fixture = handoffFixture();
    fixture.stop.mockImplementation(async () => {
      fixture.startToken = undefined;
      return {
        schemaVersion: "0.8.0" as const,
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

  it("does not treat unreadable process identity as exact death", async () => {
    const fixture = handoffFixture();
    fixture.stop.mockImplementation(async () => {
      fixture.listening = false;
      fixture.startToken = undefined;
      return {
        schemaVersion: "0.8.0" as const,
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

function decisionFor(candidateVersion: string, incumbentVersion: string) {
  return classifyObserverIncumbent({
    candidate: { ...candidate, version: candidateVersion },
    incumbent: {
      version: incumbentVersion,
      startedAt: "2026-07-12T11:00:00.000Z",
      pid: 100,
    },
  });
}

function observerBuildVersion(version: string, buildIdentity: string): string {
  return `${version}${version.includes("+") ? "." : "+"}station.${buildIdentity}`;
}

function handoffFixture() {
  const incumbentHealth: ObserverHealth = {
    schemaVersion: "0.8.0",
    status: "healthy",
    pid: 100,
    startedAt: "2026-07-12T11:00:00.000Z",
    version: "1.0.0",
    socketPath,
  };
  const identity: ObserverProcessIdentity = {
    pid: 100,
    osStartTime: "Sat Jul 12 11:00:00 2026",
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
      schemaVersion: "0.8.0" as const,
      stopped: true,
      at: "2026-07-12T12:00:00.000Z",
    })),
    signal: vi.fn((_pid: number, requestedSignal: NodeJS.Signals | 0) =>
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
    listObserverProcesses: () => [
      {
        pid: identity.pid,
        argv: ["stn", "__observer", "--socket", socketPath],
        startToken: identity.osStartTime,
        socketPath,
      },
    ],
    socketHolders: () => fixture.holders,
    processStartToken: () => fixture.startToken,
    readProcessIdentity: async () => ({ ...identity }),
    signal: fixture.signal,
  };
  return Object.assign(fixture, { lifecycle, evidence, identity });
}

function runNegotiation(fixture: ReturnType<typeof handoffFixture>) {
  return negotiateObserverIncumbent(
    { socketPath, candidate, timeoutMs: 40 },
    {
      lifecycle: fixture.lifecycle,
      evidence: fixture.evidence,
      now: () => fixture.time,
      sleep: fixture.sleep,
      pollIntervalMs: 10,
    },
  );
}
