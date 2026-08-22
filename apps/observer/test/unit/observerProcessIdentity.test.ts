import type { ObserverProcessIdentity } from "@station/contracts";
import { describe, expect, it } from "vitest";
import {
  type ObserverProcessEntry,
  observerProcessEntriesMatch,
  verifyObserverProcessIdentity,
} from "../../src/runtime/observerProcessIdentity.js";

const socketPath = "/tmp/station/observer.sock";
const process: ObserverProcessEntry = {
  pid: 42,
  argv: ["/opt/station/stn", "__observer", "--socket", socketPath],
  executablePath: "/opt/station/stn",
  startToken: "Sat Jul  4 17:45:33 2026",
  processToken: "00000000-0000-4000-8000-000000000001",
  buildVersion: "1.2.3",
  socketPath,
  startupTimeoutMs: 10_000,
};
const identity: ObserverProcessIdentity = {
  pid: process.pid,
  osStartTime: process.startToken,
  processToken: process.processToken,
  version: process.buildVersion,
  socketPath,
};

function evidence(current: ObserverProcessEntry | undefined) {
  return {
    readObserverProcess: () => current,
    processStartToken: () => current?.startToken,
  };
}

describe("Observer process identity verification", () => {
  it("verifies one exact pidfile-bound Observer process generation", () => {
    expect(
      verifyObserverProcessIdentity({ source: "pidfile", identity }, evidence(process)),
    ).toEqual({ status: "exact", process });
  });

  it("verifies the complete captured process evidence used by reap", () => {
    expect(
      verifyObserverProcessIdentity({ source: "process", process }, evidence(process)),
    ).toEqual({ status: "exact", process });
    expect(observerProcessEntriesMatch(process, { ...process, argv: [...process.argv] })).toBe(
      true,
    );
  });

  it.each([
    ["os-start-token-drift", { startToken: "replacement-start" }],
    ["process-token-drift", { processToken: "00000000-0000-4000-8000-000000000002" }],
    ["build-version-drift", { buildVersion: "1.2.4" }],
    ["socket-argv-drift", { socketPath: "/tmp/station/replacement.sock" }],
  ] as const)("classifies %s without creating signal authority", (reason, change) => {
    const current = { ...process, ...change };
    expect(
      verifyObserverProcessIdentity(
        { source: "pidfile", identity },
        {
          readObserverProcess: () => current,
          processStartToken: () => current.startToken,
        },
      ),
    ).toEqual({ status: "mismatch", reason });
  });

  it("classifies complete argv or executable drift for a captured process", () => {
    expect(
      verifyObserverProcessIdentity(
        { source: "process", process },
        evidence({ ...process, executablePath: "/opt/station/replacement" }),
      ),
    ).toEqual({ status: "mismatch", reason: "executable-argv-drift" });
  });

  it("keeps missing or failed process evidence unavailable", () => {
    expect(
      verifyObserverProcessIdentity({ source: "pidfile", identity }, evidence(undefined)),
    ).toEqual({ status: "unavailable" });
    const cause = new Error("evidence failed");
    expect(
      verifyObserverProcessIdentity(
        { source: "pidfile", identity },
        {
          readObserverProcess: () => process,
          processStartToken: () => {
            throw cause;
          },
        },
      ),
    ).toEqual({ status: "unavailable", cause });
  });
});
