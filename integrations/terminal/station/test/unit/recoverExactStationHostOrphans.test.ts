import {
  HOST_PROTOCOL_VERSION,
  type PtyHandoffManifest,
  type StationHostExactEvidence,
} from "@station/contracts";
import type { StationHostLifecycleSession } from "@station/host";
import { describe, expect, it, vi } from "vitest";
import { recoverExactStationHostOrphans } from "../../src/host/recoverExactStationHostOrphans.js";

const socketPath = "/state/station-host.sock";
const targetBuild = { buildVersion: "2.0.0", buildIdentity: "b".repeat(64) };
const endpoint = { socketPath, ino: 21n, birthtimeNs: 22n };
const manifest: PtyHandoffManifest = {
  "pty-1": {
    bridgeProtocolVersion: 2,
    bridgePid: 41,
    controlSocket: "/state/run/pty-bridges/pty-1.sock",
    command: "codex",
    cols: 80,
    rows: 24,
    ptyInstanceId: "instance-1",
    identity: {
      kind: "agent",
      terminalTargetId: "target-1",
      worktreeId: "worktree-1",
      projectId: "project-1",
      sessionId: "session-1",
      worktreePath: "/repo/one",
      harnessProvider: "codex",
    },
  },
};
const recoveredTerminal: StationHostExactEvidence["terminals"][number] = {
  kind: "agent",
  terminalTargetId: "target-1",
  ptyId: "pty-1",
  ptyInstanceId: "instance-1",
  worktreeId: "worktree-1",
  projectId: "project-1",
  sessionId: "session-1",
  worktreePath: "/repo/one",
  harnessProvider: "codex",
  pid: 42,
  alive: true,
  cols: 80,
  rows: 24,
  handoffSupport: { kind: "bridge-releasable" },
};

describe("recoverExactStationHostOrphans", () => {
  it("rejects a fresh non-target Host even when no parked manifest remains", async () => {
    await expect(
      recoverExactStationHostOrphans(
        {
          socketPath,
          stateDir: "/state",
          hostCommand: ["station-host"],
          targetBuild,
          deadlineMs: 20_000,
        },
        {
          now: () => 1_000,
          loadRecoveryEvidence: async () => ({ manifest: {}, payloadPids: {} }),
          inspect: async () => ({
            status: "exact",
            evidence: { ...evidence([]), buildIdentity: "a".repeat(64) },
          }),
        },
      ),
    ).rejects.toMatchObject({ code: "HOST_HANDOFF_MANIFEST_INVALID" });
  });

  it("adopts durable parks only after pinning the exact target and independently verifies them", async () => {
    const before = evidence([]);
    const after = evidence([recoveredTerminal]);
    const inspect = vi
      .fn()
      .mockResolvedValueOnce({ status: "exact", evidence: before })
      .mockResolvedValueOnce({ status: "exact", evidence: after });
    const adoptRegistry = vi.fn(async () => ({
      adopted: ["pty-1"],
      failed: [],
    }));
    const session = lifecycle({ adoptRegistry });
    const readEvidence = vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after);

    await expect(
      recoverExactStationHostOrphans(
        {
          socketPath,
          stateDir: "/state",
          hostCommand: ["station-host"],
          targetBuild,
          deadlineMs: 20_000,
        },
        {
          now: () => 1_000,
          loadRecoveryEvidence: async () => ({
            manifest,
            payloadPids: { "pty-1": 42 },
          }),
          inspect,
          openSession: async () => session,
          readEvidence,
        },
      ),
    ).resolves.toEqual({ recoveredPtyIds: ["pty-1"] });

    expect(adoptRegistry).toHaveBeenCalledWith(manifest);
    expect(readEvidence).toHaveBeenNthCalledWith(1, session, endpoint, 20_000);
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("recovers only the missing parks after partial successor adoption", async () => {
    const firstEntry = manifest["pty-1"];
    if (firstEntry === undefined) throw new Error("Missing first manifest entry.");
    const secondEntry = {
      ...firstEntry,
      controlSocket: "/state/run/pty-bridges/pty-2.sock",
      ptyInstanceId: "instance-2",
      identity: {
        ...firstEntry.identity,
        terminalTargetId: "target-2",
        sessionId: "session-2",
      },
    };
    const partialManifest = { ...manifest, "pty-2": secondEntry };
    const secondTerminal = {
      ...recoveredTerminal,
      terminalTargetId: "target-2",
      ptyId: "pty-2",
      ptyInstanceId: "instance-2",
      sessionId: "session-2",
      pid: 43,
    };
    const before = evidence([recoveredTerminal]);
    const after = evidence([recoveredTerminal, secondTerminal]);
    const adoptRegistry = vi.fn(async () => ({
      adopted: ["pty-2"],
      failed: [],
    }));
    const session = lifecycle({ adoptRegistry });

    await expect(
      recoverExactStationHostOrphans(
        {
          socketPath,
          stateDir: "/state",
          hostCommand: ["station-host"],
          targetBuild,
          deadlineMs: 20_000,
        },
        {
          now: () => 1_000,
          loadRecoveryEvidence: async () => ({
            manifest: partialManifest,
            payloadPids: { "pty-1": 42, "pty-2": 43 },
          }),
          inspect: vi
            .fn()
            .mockResolvedValueOnce({ status: "exact", evidence: before })
            .mockResolvedValueOnce({ status: "exact", evidence: after }),
          openSession: async () => session,
          readEvidence: vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after),
        },
      ),
    ).resolves.toEqual({ recoveredPtyIds: ["pty-2"] });
    expect(adoptRegistry).toHaveBeenCalledWith({ "pty-2": secondEntry });
  });

  it("rejects a combined Host and unowned-park identity conflict before adoption", async () => {
    const conflictingHostTerminal = {
      ...recoveredTerminal,
      ptyId: "host-pty",
      ptyInstanceId: "host-instance",
      pid: 84,
    };
    const before = evidence([conflictingHostTerminal]);
    const adoptRegistry = vi.fn();
    const session = lifecycle({ adoptRegistry });

    await expect(
      recoverExactStationHostOrphans(
        {
          socketPath,
          stateDir: "/state",
          hostCommand: ["station-host"],
          targetBuild,
          deadlineMs: 20_000,
        },
        {
          now: () => 1_000,
          loadRecoveryEvidence: async () => ({
            manifest,
            payloadPids: { "pty-1": 42 },
          }),
          inspect: async () => ({ status: "exact", evidence: before }),
          openSession: async () => session,
          readEvidence: async () => before,
        },
      ),
    ).rejects.toMatchObject({ code: "HOST_HANDOFF_MANIFEST_INVALID" });
    expect(adoptRegistry).not.toHaveBeenCalled();
  });

  it("reloads durable parks after starting the target and ignores records reaped by startup", async () => {
    const loadRecoveryEvidence = vi
      .fn()
      .mockResolvedValueOnce({ manifest, payloadPids: { "pty-1": 42 } })
      .mockResolvedValueOnce({ manifest: {}, payloadPids: {} });
    const startedSession = lifecycle();
    const startTarget = vi.fn(async (input) => {
      await input.validate?.(startedSession);
      return {
        status: "transferred" as const,
        endpoint,
        health: evidence([]).health,
        session: startedSession,
      };
    });
    const openSession = vi.fn();

    await expect(
      recoverExactStationHostOrphans(
        {
          socketPath,
          stateDir: "/state",
          hostCommand: ["station-host"],
          targetBuild,
          deadlineMs: 20_000,
        },
        {
          now: () => 1_000,
          loadRecoveryEvidence,
          inspect: async () => ({ status: "absent" }),
          startTarget: startTarget as never,
          openSession,
        },
      ),
    ).resolves.toEqual({ recoveredPtyIds: [] });

    expect(loadRecoveryEvidence).toHaveBeenCalledTimes(2);
    expect(startTarget).toHaveBeenCalledOnce();
    expect(openSession).not.toHaveBeenCalled();
  });

  it("rejects a non-target replacement after a transferred target reaps the final park", async () => {
    const dispose = vi.fn();
    const startedSession = lifecycle({ dispose });
    const inspect = vi
      .fn()
      .mockResolvedValueOnce({ status: "absent" })
      .mockResolvedValueOnce({
        status: "exact",
        evidence: { ...evidence([]), buildIdentity: "a".repeat(64) },
      });

    await expect(
      recoverExactStationHostOrphans(
        {
          socketPath,
          stateDir: "/state",
          hostCommand: ["station-host"],
          targetBuild,
          deadlineMs: 20_000,
        },
        {
          now: () => 1_000,
          loadRecoveryEvidence: vi
            .fn()
            .mockResolvedValueOnce({ manifest, payloadPids: { "pty-1": 42 } })
            .mockResolvedValueOnce({ manifest: {}, payloadPids: {} }),
          inspect,
          startTarget: (async (input) => {
            await input.validate?.(startedSession);
            return {
              status: "transferred" as const,
              endpoint,
              health: evidence([]).health,
              session: startedSession,
            };
          }) as never,
        },
      ),
    ).rejects.toMatchObject({ code: "HOST_HANDOFF_MANIFEST_INVALID" });
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("rejects a non-target replacement after a concurrent exact target reaps the final park", async () => {
    const exactConcurrentTarget = evidence([]);
    const inspect = vi
      .fn()
      .mockResolvedValueOnce({ status: "absent" })
      .mockResolvedValueOnce({ status: "exact", evidence: exactConcurrentTarget })
      .mockResolvedValueOnce({
        status: "exact",
        evidence: { ...exactConcurrentTarget, buildIdentity: "a".repeat(64) },
      });

    await expect(
      recoverExactStationHostOrphans(
        {
          socketPath,
          stateDir: "/state",
          hostCommand: ["station-host"],
          targetBuild,
          deadlineMs: 20_000,
        },
        {
          now: () => 1_000,
          loadRecoveryEvidence: vi
            .fn()
            .mockResolvedValueOnce({ manifest, payloadPids: { "pty-1": 42 } })
            .mockResolvedValueOnce({ manifest: {}, payloadPids: {} }),
          inspect,
          startTarget: async () => ({
            status: "failed",
            error: new Error("child lost the socket race"),
            childDisposition: "settled",
          }),
        },
      ),
    ).rejects.toMatchObject({ code: "HOST_HANDOFF_MANIFEST_INVALID" });
    expect(inspect).toHaveBeenCalledTimes(3);
  });

  it("disposes a transferred startup session when post-start park evidence is invalid", async () => {
    const dispose = vi.fn();
    const startedSession = lifecycle({ dispose });
    const loadRecoveryEvidence = vi
      .fn()
      .mockResolvedValueOnce({ manifest, payloadPids: { "pty-1": 42 } })
      .mockRejectedValueOnce({
        tag: "TerminalProviderError",
        code: "HOST_HANDOFF_MANIFEST_INVALID",
        message: "Park evidence changed.",
      });
    const startTarget = vi.fn(async (input) => {
      await input.validate?.(startedSession);
      return {
        status: "transferred" as const,
        endpoint,
        health: evidence([]).health,
        session: startedSession,
      };
    });

    await expect(
      recoverExactStationHostOrphans(
        {
          socketPath,
          stateDir: "/state",
          hostCommand: ["station-host"],
          targetBuild,
          deadlineMs: 20_000,
        },
        {
          now: () => 1_000,
          loadRecoveryEvidence,
          inspect: async () => ({ status: "absent" }),
          startTarget: startTarget as never,
        },
      ),
    ).rejects.toMatchObject({ code: "HOST_HANDOFF_MANIFEST_INVALID" });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("admits a concurrent exact target after the directly started child settles", async () => {
    const before = evidence([]);
    const after = evidence([recoveredTerminal]);
    const inspect = vi
      .fn()
      .mockResolvedValueOnce({ status: "absent" })
      .mockResolvedValueOnce({ status: "exact", evidence: before })
      .mockResolvedValueOnce({ status: "exact", evidence: after });
    const adoptRegistry = vi.fn(async () => ({
      adopted: ["pty-1"],
      failed: [],
    }));
    const session = lifecycle({ adoptRegistry });

    await expect(
      recoverExactStationHostOrphans(
        {
          socketPath,
          stateDir: "/state",
          hostCommand: ["station-host"],
          targetBuild,
          deadlineMs: 20_000,
        },
        {
          now: () => 1_000,
          loadRecoveryEvidence: async () => ({
            manifest,
            payloadPids: { "pty-1": 42 },
          }),
          inspect,
          startTarget: async () => ({
            status: "failed",
            error: new Error("child lost the socket race"),
            childDisposition: "settled",
          }),
          openSession: async () => session,
          readEvidence: vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after),
        },
      ),
    ).resolves.toEqual({ recoveredPtyIds: ["pty-1"] });
    expect(adoptRegistry).toHaveBeenCalledOnce();
  });

  it.each([
    "settled",
    "unproven",
  ] as const)("does not admit a %s startup failure without an exact concurrent target", async (childDisposition) => {
    const startupError = {
      tag: "TerminalProviderError",
      code: "HOST_TARGET_CONFLICT",
      message: "The direct child did not own the target socket.",
    };
    const inspect = vi
      .fn()
      .mockResolvedValueOnce({ status: "absent" })
      .mockResolvedValueOnce({
        status: "exact",
        evidence: { ...evidence([]), buildIdentity: "a".repeat(64) },
      });
    await expect(
      recoverExactStationHostOrphans(
        {
          socketPath,
          stateDir: "/state",
          hostCommand: ["station-host"],
          targetBuild,
          deadlineMs: 20_000,
        },
        {
          now: () => 1_000,
          loadRecoveryEvidence: async () => ({
            manifest,
            payloadPids: { "pty-1": 42 },
          }),
          inspect,
          startTarget: async () => ({
            status: "failed",
            error: startupError,
            childDisposition,
          }),
        },
      ),
    ).rejects.toBe(startupError);
    expect(inspect).toHaveBeenCalledTimes(childDisposition === "settled" ? 2 : 1);
  });

  it("refuses expired startup authority without spawning a recovery Host", async () => {
    const startTarget = vi.fn();
    await expect(
      recoverExactStationHostOrphans(
        {
          socketPath,
          stateDir: "/state",
          hostCommand: ["station-host"],
          targetBuild,
          deadlineMs: 3_000,
        },
        {
          now: () => 1_000,
          loadRecoveryEvidence: async () => ({
            manifest,
            payloadPids: { "pty-1": 42 },
          }),
          inspect: async () => ({ status: "absent" }),
          startTarget,
        },
      ),
    ).rejects.toMatchObject({ code: "HOST_UNREACHABLE" });
    expect(startTarget).not.toHaveBeenCalled();
  });

  it("refuses a directly started child whose immutable identity is not the target", async () => {
    const adoptRegistry = vi.fn();
    const wrongSession = lifecycle({
      recoveryInventory: async () => ({
        buildIdentity: "a".repeat(64),
        ptys: [],
      }),
      adoptRegistry,
    });
    const startTarget = vi.fn(async (input) => {
      try {
        await input.validate?.(wrongSession);
        throw new Error("validation unexpectedly succeeded");
      } catch (error) {
        return {
          status: "failed" as const,
          error,
          childDisposition: "settled" as const,
        };
      }
    });

    await expect(
      recoverExactStationHostOrphans(
        {
          socketPath,
          stateDir: "/state",
          hostCommand: ["station-host"],
          targetBuild,
          deadlineMs: 20_000,
        },
        {
          now: () => 1_000,
          loadRecoveryEvidence: async () => ({
            manifest,
            payloadPids: { "pty-1": 42 },
          }),
          inspect: async () => ({ status: "absent" }),
          startTarget: startTarget as never,
        },
      ),
    ).rejects.toMatchObject({ code: "HOST_HANDOFF_MANIFEST_INVALID" });
    expect(adoptRegistry).not.toHaveBeenCalled();
  });

  it("refuses target identity substitution before adopting a park", async () => {
    const adoptRegistry = vi.fn();
    await expect(
      recoverExactStationHostOrphans(
        {
          socketPath,
          stateDir: "/state",
          hostCommand: ["station-host"],
          targetBuild,
          deadlineMs: 20_000,
        },
        {
          now: () => 1_000,
          loadRecoveryEvidence: async () => ({
            manifest,
            payloadPids: { "pty-1": 42 },
          }),
          inspect: async () => ({
            status: "exact",
            evidence: { ...evidence([]), buildIdentity: "a".repeat(64) },
          }),
          openSession: async () => lifecycle({ adoptRegistry }),
        },
      ),
    ).rejects.toMatchObject({ code: "HOST_HANDOFF_MANIFEST_INVALID" });
    expect(adoptRegistry).not.toHaveBeenCalled();
  });

  it("accepts an adoption conflict only when the pinned session proves a concurrent winner", async () => {
    const before = evidence([]);
    const after = evidence([recoveredTerminal]);
    const adoptRegistry = vi.fn(async () => ({
      adopted: [],
      failed: [{ ptyId: "pty-1", reason: "already adopted" }],
    }));
    const session = lifecycle({ adoptRegistry });

    await expect(
      recoverExactStationHostOrphans(
        {
          socketPath,
          stateDir: "/state",
          hostCommand: ["station-host"],
          targetBuild,
          deadlineMs: 20_000,
        },
        {
          now: () => 1_000,
          loadRecoveryEvidence: async () => ({
            manifest,
            payloadPids: { "pty-1": 42 },
          }),
          inspect: vi
            .fn()
            .mockResolvedValueOnce({ status: "exact", evidence: before })
            .mockResolvedValueOnce({ status: "exact", evidence: after }),
          openSession: async () => session,
          readEvidence: vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after),
        },
      ),
    ).resolves.toEqual({ recoveredPtyIds: ["pty-1"] });
  });

  it("preserves adoption failure when concurrent recovery does not prove the full manifest", async () => {
    const before = evidence([]);
    const adoptRegistry = vi.fn(async () => ({
      adopted: [],
      failed: [{ ptyId: "pty-1", reason: "identity conflict" }],
    }));
    await expect(
      recoverExactStationHostOrphans(
        {
          socketPath,
          stateDir: "/state",
          hostCommand: ["station-host"],
          targetBuild,
          deadlineMs: 20_000,
        },
        {
          now: () => 1_000,
          loadRecoveryEvidence: async () => ({
            manifest,
            payloadPids: { "pty-1": 42 },
          }),
          inspect: async () => ({ status: "exact", evidence: before }),
          openSession: async () => lifecycle({ adoptRegistry }),
          readEvidence: async () => before,
        },
      ),
    ).rejects.toMatchObject({ code: "HOST_HANDOFF_MANIFEST_INVALID" });
  });
});

function evidence(terminals: StationHostExactEvidence["terminals"]): StationHostExactEvidence {
  return {
    endpoint,
    health: {
      ok: true,
      protocolVersion: HOST_PROTOCOL_VERSION,
      buildVersion: targetBuild.buildVersion,
    },
    buildIdentity: targetBuild.buildIdentity,
    terminals,
  };
}

function lifecycle(
  overrides: Partial<StationHostLifecycleSession> = {},
): StationHostLifecycleSession {
  return {
    health: async () => evidence([]).health,
    recoveryInventory: async () => ({
      buildIdentity: targetBuild.buildIdentity,
      ptys: [],
    }),
    stopIfIdle: async () => ({ stopping: true }),
    beginHandoff: async () => ({
      status: "refused",
      error: { tag: "HostError", code: "NOT_USED", message: "not used" },
    }),
    completeHandoff: async () => ({ stopping: true }),
    abortHandoff: async () => ({ adopted: [], failed: [] }),
    adoptRegistry: async () => ({ adopted: [], failed: [] }),
    dispose: () => undefined,
    ...overrides,
  };
}
