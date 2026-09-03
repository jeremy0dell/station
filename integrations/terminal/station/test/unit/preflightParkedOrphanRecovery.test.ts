import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  HOST_PROTOCOL_VERSION,
  type PtyBridgeParkState,
  type StationHostExactEvidence,
} from "@station/contracts";
import { describe, expect, it } from "vitest";
import {
  parkedOrphanTerminalEvidence,
  preflightParkedOrphanRecovery,
} from "../../src/host/preflightParkedOrphanRecovery.js";

describe("preflightParkedOrphanRecovery", () => {
  it.each([
    false,
    true,
  ])("admits strict reachable parks without requesting adoption (evicted=%s)", async (parkedEvicted) => {
    const park = parkRecord("/state/run/pty-bridges/pty-1.sock");
    const result = await preflightParkedOrphanRecovery(
      { stateDir: "/state", deadlineMs: 10_000 },
      {
        now: () => 1_000,
        loadRecoveryEvidence: async () => ({
          manifest: {
            "pty-1": {
              bridgeProtocolVersion: 2,
              bridgePid: park.bridgePid,
              controlSocket: park.controlSocket,
              command: park.command,
              cols: park.cols,
              rows: park.rows,
              ptyInstanceId: park.ptyInstanceId,
              identity: park.identity,
            },
          },
          payloadPids: { "pty-1": park.pid },
        }),
        readBridgeStatus: async () => ({
          type: "status",
          bridgeProtocol: 2,
          ptyInstanceId: park.ptyInstanceId,
          pid: park.pid,
          bridgePid: park.bridgePid,
          cols: park.cols,
          rows: park.rows,
          adopted: false,
          exited: false,
          parkedEvicted,
        }),
      },
    );
    expect(result).toEqual({
      totalParkedCount: 1,
      unownedParkedCount: 1,
      adoptionRequiredCount: 1,
    });
    expect(parkedOrphanTerminalEvidence(result)).toEqual([
      {
        kind: "agent",
        terminalTargetId: "target-1",
        ptyId: "pty-1",
        ptyInstanceId: "instance-1",
        projectId: "project-1",
        worktreeId: "worktree-1",
        sessionId: "session-1",
        harnessProvider: "codex",
        alive: true,
        handoffSupport: "bridge-releasable",
      },
    ]);
  });

  it("admits a bridge adopted by the fully matching current Host on a successive update", async () => {
    const park = parkRecord("/state/run/pty-bridges/pty-1.sock");
    await expect(
      preflightParkedOrphanRecovery(
        {
          stateDir: "/state",
          currentHostEvidence: currentHostEvidence(park),
          deadlineMs: 10_000,
        },
        {
          now: () => 1_000,
          loadRecoveryEvidence: async () => recoveryEvidence(park),
          readBridgeStatus: async () => bridgeStatus(park, true),
        },
      ),
    ).resolves.toEqual({ totalParkedCount: 1, unownedParkedCount: 0, adoptionRequiredCount: 0 });
  });

  it("admits an unowned park whose lifetime identities are disjoint from the current Host", async () => {
    const park = parkRecord("/state/run/pty-bridges/pty-1.sock");
    await expect(
      preflightParkedOrphanRecovery(
        {
          stateDir: "/state",
          currentHostEvidence: currentHostEvidence(park, {
            ptyId: "host-pty",
            terminalTargetId: "host-target",
            ptyInstanceId: "host-instance",
          }),
          deadlineMs: 10_000,
        },
        {
          now: () => 1_000,
          loadRecoveryEvidence: async () => recoveryEvidence(park),
          readBridgeStatus: async () => bridgeStatus(park, false),
        },
      ),
    ).resolves.toEqual({ totalParkedCount: 1, unownedParkedCount: 1, adoptionRequiredCount: 1 });
  });

  it.each([
    ["ptyId", { ptyId: "pty-1" }],
    ["terminalTargetId", { terminalTargetId: "target-1" }],
    ["ptyInstanceId", { ptyInstanceId: "instance-1" }],
  ] as const)("rejects an unowned park whose %s collides with the current Host", async (_, collision) => {
    const park = parkRecord("/state/run/pty-bridges/pty-1.sock");
    await expect(
      preflightParkedOrphanRecovery(
        {
          stateDir: "/state",
          currentHostEvidence: currentHostEvidence(park, {
            ptyId: "host-pty",
            terminalTargetId: "host-target",
            ptyInstanceId: "host-instance",
            ...collision,
          }),
          deadlineMs: 10_000,
        },
        {
          now: () => 1_000,
          loadRecoveryEvidence: async () => recoveryEvidence(park),
          readBridgeStatus: async () => bridgeStatus(park, false),
        },
      ),
    ).rejects.toMatchObject({ code: "HOST_HANDOFF_MANIFEST_INVALID" });
  });

  it.each([
    ["absent", undefined],
    [
      "nonmatching",
      currentHostEvidence(parkRecord("/state/run/pty-bridges/pty-1.sock"), {
        ptyInstanceId: "replacement-instance",
      }),
    ],
  ] as const)("rejects an adopted bridge when current Host ownership is %s", async (_, hostEvidence) => {
    const park = parkRecord("/state/run/pty-bridges/pty-1.sock");
    await expect(
      preflightParkedOrphanRecovery(
        {
          stateDir: "/state",
          ...(hostEvidence === undefined ? {} : { currentHostEvidence: hostEvidence }),
          deadlineMs: 10_000,
        },
        {
          now: () => 1_000,
          loadRecoveryEvidence: async () => recoveryEvidence(park),
          readBridgeStatus: async () => bridgeStatus(park, true),
        },
      ),
    ).rejects.toMatchObject({ code: "HOST_HANDOFF_MANIFEST_INVALID" });
  });

  it("fails closed on malformed or aggregate-duplicate park files", async () => {
    const malformed = await stateDirectory("station-park-preflight-malformed-");
    await writeFile(path.join(malformed.directory, "pty-1.park.json"), "{}\n");
    await expect(
      preflightParkedOrphanRecovery({ stateDir: malformed.stateDir }),
    ).rejects.toMatchObject({ code: "HOST_HANDOFF_MANIFEST_INVALID" });

    const duplicate = await stateDirectory("station-park-preflight-duplicate-");
    const first = parkRecord(path.join(duplicate.directory, "pty-1.sock"));
    const second = {
      ...parkRecord(path.join(duplicate.directory, "pty-2.sock")),
      ptyInstanceId: first.ptyInstanceId,
      bridgePid: 13,
      identity: {
        ...first.identity,
        terminalTargetId: "target-2",
        sessionId: "session-2",
      },
    };
    await writeFile(path.join(duplicate.directory, "pty-1.park.json"), JSON.stringify(first));
    await writeFile(path.join(duplicate.directory, "pty-2.park.json"), JSON.stringify(second));
    await expect(
      preflightParkedOrphanRecovery({ stateDir: duplicate.stateDir }),
    ).rejects.toMatchObject({ code: "HOST_HANDOFF_MANIFEST_INVALID" });
  });

  it("blocks an unreachable live park before update mutation", async () => {
    const fixture = await stateDirectory("station-park-preflight-unreachable-");
    const park = parkRecord(path.join(fixture.directory, "pty-1.sock"));
    await writeFile(path.join(fixture.directory, "pty-1.park.json"), JSON.stringify(park));

    await expect(
      preflightParkedOrphanRecovery({
        stateDir: fixture.stateDir,
        deadlineMs: Date.now() + 1_000,
      }),
    ).rejects.toMatchObject({ code: "HOST_HANDOFF_MANIFEST_INVALID" });
  });

  it("rejects recovery evidence whose read exhausted the absolute preflight deadline", async () => {
    let currentMs = 1_000;
    await expect(
      preflightParkedOrphanRecovery(
        { stateDir: "/state", deadlineMs: 2_000 },
        {
          now: () => currentMs,
          loadRecoveryEvidence: async () => {
            currentMs = 2_000;
            return { manifest: {}, payloadPids: {} };
          },
        },
      ),
    ).rejects.toMatchObject({ code: "HOST_HANDOFF_MANIFEST_INVALID" });
  });
});

async function stateDirectory(prefix: string) {
  const stateDir = await mkdtemp(path.join(tmpdir(), prefix));
  const directory = path.join(stateDir, "run", "pty-bridges");
  await mkdir(directory, { recursive: true });
  return { stateDir, directory };
}

function parkRecord(controlSocket: string): PtyBridgeParkState {
  return {
    v: 2,
    bridgePid: 12,
    pid: 34,
    controlSocket,
    command: "codex",
    cols: 100,
    rows: 30,
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
    orphanedAtMs: 1,
    ttlMs: 60_000,
    heartbeatAtMs: 2,
    exited: false,
  };
}

function recoveryEvidence(park: PtyBridgeParkState) {
  return {
    manifest: {
      "pty-1": {
        bridgeProtocolVersion: 2 as const,
        bridgePid: park.bridgePid,
        controlSocket: park.controlSocket,
        command: park.command,
        cols: park.cols,
        rows: park.rows,
        ptyInstanceId: park.ptyInstanceId,
        identity: park.identity,
      },
    },
    payloadPids: { "pty-1": park.pid },
  };
}

function bridgeStatus(park: PtyBridgeParkState, adopted: boolean) {
  return {
    type: "status" as const,
    bridgeProtocol: 2 as const,
    ptyInstanceId: park.ptyInstanceId,
    pid: park.pid,
    bridgePid: park.bridgePid,
    cols: park.cols,
    rows: park.rows,
    adopted,
    exited: false,
    parkedEvicted: false,
  };
}

function currentHostEvidence(
  park: PtyBridgeParkState,
  terminalOverrides: Partial<StationHostExactEvidence["terminals"][number]> = {},
): StationHostExactEvidence {
  return {
    endpoint: {
      socketPath: "/state/station-host.sock",
      ino: 1n,
      birthtimeNs: 2n,
    },
    health: {
      ok: true,
      protocolVersion: HOST_PROTOCOL_VERSION,
      buildVersion: "1.0.0",
    },
    buildIdentity: "a".repeat(64),
    terminals: [
      {
        ...park.identity,
        ptyId: "pty-1",
        ptyInstanceId: park.ptyInstanceId,
        pid: park.pid,
        alive: true,
        cols: park.cols,
        rows: park.rows,
        handoffSupport: { kind: "bridge-releasable" },
        ...terminalOverrides,
      },
    ],
  };
}
