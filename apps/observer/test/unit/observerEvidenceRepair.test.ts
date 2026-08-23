import type { ObserverProcessIdentity } from "@station/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  type ObserverRepairableSocketProbe,
  type ObserverStaleEvidenceRepairDeps,
  repairStaleObserverEvidence,
} from "../../src/runtime/observerEvidenceRepair.js";
import type { ObserverProcessEntry } from "../../src/runtime/observerProcessIdentity.js";

const socketPath = "/tmp/station/observer.sock";
const identity: ObserverProcessIdentity = {
  pid: 42,
  osStartTime: "Sat Jul  4 17:45:33 2026",
  processToken: "00000000-0000-4000-8000-000000000001",
  version: "1.2.3",
  socketPath,
};
const processEntry: ObserverProcessEntry = {
  pid: identity.pid,
  argv: ["/opt/station/stn", "__observer", "--socket", socketPath],
  executablePath: "/opt/station/stn",
  executableProvenance: "exact",
  startToken: identity.osStartTime,
  processToken: identity.processToken,
  buildVersion: identity.version,
  socketPath,
  startupTimeoutMs: 10_000,
};
const absentProbe: ObserverRepairableSocketProbe = { status: "absent" };
const staleProbe: ObserverRepairableSocketProbe = {
  status: "stale",
  identity: { ino: 10n, birthtimeNs: 20n },
};

function repairInput(socketProbe: ObserverRepairableSocketProbe = absentProbe) {
  return { socketPath, socketProbe, deadlineMs: 1_000 };
}

function repairDeps(
  options: {
    identity?: ObserverProcessIdentity;
    existence?: ReturnType<
      ObserverStaleEvidenceRepairDeps["processEvidence"]["readProcessExistence"]
    >;
    process?: ObserverProcessEntry;
    probe?: ObserverStaleEvidenceRepairDeps["probeSocket"];
    remove?: ObserverStaleEvidenceRepairDeps["identityRepair"]["removeIfExact"];
  } = {},
) {
  const removeIfExact = vi.fn(options.remove ?? (async () => true));
  const deps: ObserverStaleEvidenceRepairDeps = {
    processEvidence: {
      readProcessExistence: () =>
        options.existence ?? { status: "running", osStartTime: identity.osStartTime },
      processStartToken: () => (options.process ?? processEntry).startToken,
      readObserverProcess: () => options.process ?? processEntry,
    },
    identityRepair: {
      read: async () => options.identity,
      removeIfExact,
    },
    probeSocket: options.probe ?? (async () => absentProbe),
    now: () => 0,
  };
  return { deps, removeIfExact };
}

describe("stale Observer evidence repair", () => {
  it("returns an idempotent clean result when no pidfile exists", async () => {
    const { deps, removeIfExact } = repairDeps();
    await expect(repairStaleObserverEvidence(repairInput(), deps)).resolves.toEqual({
      socket: "absent",
      pidfile: "absent",
    });
    expect(removeIfExact).not.toHaveBeenCalled();
  });

  it("removes a dead process pidfile without any signal capability", async () => {
    const { deps, removeIfExact } = repairDeps({
      identity,
      existence: { status: "absent" },
      probe: async () => staleProbe,
    });
    await expect(repairStaleObserverEvidence(repairInput(staleProbe), deps)).resolves.toEqual({
      socket: "stale",
      pidfile: "removed",
      reason: "process-missing",
    });
    expect(removeIfExact).toHaveBeenCalledTimes(1);
    expect(removeIfExact).toHaveBeenCalledWith(identity);
  });

  it.each([
    ["os-start-token-drift", { startToken: "replacement-start" }],
    ["process-token-drift", { processToken: "00000000-0000-4000-8000-000000000002" }],
    ["build-version-drift", { buildVersion: "1.2.4" }],
    ["socket-argv-drift", { socketPath: "/tmp/station/replacement.sock" }],
  ] as const)("removes pidfile evidence after exact %s revalidation", async (reason, change) => {
    const current = { ...processEntry, ...change };
    const { deps } = repairDeps({ identity, process: current });
    await expect(repairStaleObserverEvidence(repairInput(), deps)).resolves.toEqual({
      socket: "absent",
      pidfile: "removed",
      reason,
    });
  });

  it("fails closed for an exact live process", async () => {
    const { deps, removeIfExact } = repairDeps({ identity });
    await expect(repairStaleObserverEvidence(repairInput(), deps)).rejects.toMatchObject({
      code: "OBSERVER_STALE_EVIDENCE_UNCERTAIN",
      message: "The recorded Observer process still has exact live identity.",
    });
    expect(removeIfExact).not.toHaveBeenCalled();
  });

  it("repairs a typed executable or argv mismatch from the shared verifier", async () => {
    const { deps } = repairDeps({ identity });
    deps.processEvidence.readObserverProcess = () => {
      throw Object.assign(new Error("exact argv mismatch"), {
        tag: "ObserverProcessEvidenceError",
        code: "OBSERVER_PROCESS_EXECUTABLE_ARGV_MISMATCH",
        message: "Observer process evidence did not match the exact executable and argv.",
      });
    };
    await expect(repairStaleObserverEvidence(repairInput(), deps)).resolves.toEqual({
      socket: "absent",
      pidfile: "removed",
      reason: "executable-argv-drift",
    });
  });

  it("fails closed when process evidence is unavailable", async () => {
    const cause = new Error("ps timed out");
    const { deps, removeIfExact } = repairDeps({
      identity,
      existence: { status: "unavailable", cause },
    });
    const repair = repairStaleObserverEvidence(repairInput(), deps);
    await expect(repair).rejects.toMatchObject({
      code: "OBSERVER_STALE_EVIDENCE_UNCERTAIN",
    });
    await expect(repair).rejects.not.toHaveProperty("cause");
    expect(removeIfExact).not.toHaveBeenCalled();
  });

  it("preserves evidence when a listener appears before commit", async () => {
    const { deps, removeIfExact } = repairDeps({
      identity,
      existence: { status: "absent" },
      probe: async () => ({
        status: "listening",
        identity: { ino: 11n, birthtimeNs: 21n },
      }),
    });
    await expect(repairStaleObserverEvidence(repairInput(), deps)).rejects.toMatchObject({
      code: "OBSERVER_STALE_EVIDENCE_OWNER_CHANGED",
    });
    expect(removeIfExact).not.toHaveBeenCalled();
  });

  it("preserves evidence when the stale socket path is replaced before commit", async () => {
    const { deps, removeIfExact } = repairDeps({
      identity,
      existence: { status: "absent" },
      probe: async () => ({
        status: "stale",
        identity: { ino: 11n, birthtimeNs: 21n },
      }),
    });
    await expect(repairStaleObserverEvidence(repairInput(staleProbe), deps)).rejects.toMatchObject({
      code: "OBSERVER_STALE_EVIDENCE_OWNER_CHANGED",
    });
    expect(removeIfExact).not.toHaveBeenCalled();
  });

  it("bounds compare/remove races and preserves a successor", async () => {
    const successor = { ...identity, pid: 43, osStartTime: "successor-start" };
    let reads = 0;
    const removeIfExact = vi.fn(async () => false);
    const { deps } = repairDeps({
      identity,
      existence: { status: "absent" },
      remove: removeIfExact,
    });
    deps.identityRepair.read = async () => (reads++ < 2 ? identity : successor);
    await expect(repairStaleObserverEvidence(repairInput(), deps)).rejects.toMatchObject({
      code: "OBSERVER_STALE_EVIDENCE_OWNER_CHANGED",
    });
    expect(removeIfExact).toHaveBeenCalledTimes(1);
  });

  it("honors cancellation before the pidfile commit", async () => {
    const controller = new AbortController();
    controller.abort();
    const { deps, removeIfExact } = repairDeps({
      identity,
      existence: { status: "absent" },
    });
    await expect(
      repairStaleObserverEvidence({ ...repairInput(), signal: controller.signal }, deps),
    ).rejects.toMatchObject({ code: "OBSERVER_STALE_EVIDENCE_UNCERTAIN" });
    expect(removeIfExact).not.toHaveBeenCalled();
  });
});
