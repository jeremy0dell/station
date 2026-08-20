import type { StationHostClient } from "@station/host";
import { describe, expect, it, vi } from "vitest";
import {
  createLocalRepairRuntimeEvidence,
  parseProcessTopologies,
} from "../../src/commands/repair/localRuntimeEvidence";

const socketIdentity = { ino: 10n, birthtimeNs: 20n };
const started = "Thu Aug 20 08:00:00 2026";

describe("local repair runtime evidence", () => {
  it("parses complete process topology and rejects malformed lines", () => {
    expect(
      parseProcessTopologies(
        `  201  200  200 ttys001 ${started}\n  200  200  200 ttys001 ${started}\n`,
      ),
    ).toEqual([
      { pid: 200, processGroupId: 200, sessionId: 200, tty: "ttys001", startToken: started },
      { pid: 201, processGroupId: 200, sessionId: 200, tty: "ttys001", startToken: started },
    ]);
    expect(() => parseProcessTopologies("truncated\n")).toThrow("malformed");
  });

  it("verifies one Host socket lifetime, exact PTY reference, and stable process group", async () => {
    const client = hostClient();
    const evidence = createLocalRepairRuntimeEvidence({
      probeSocket: async () => ({ status: "listening", identity: socketIdentity }),
      socketHolders: () => [50],
      hostClientFactory: () => client,
      readProcessCommand: () => ({
        startToken: started,
        executablePath: "bun",
        argv: ["bun", "/host.ts", "--socket", "/state/host.sock", "--state-dir", "/state"],
      }),
      readProcessTopologies: () => [
        { pid: 200, processGroupId: 200, sessionId: 200, tty: "ttys001", startToken: started },
        { pid: 201, processGroupId: 200, sessionId: 200, tty: "ttys001", startToken: started },
      ],
    });

    const result = await evidence.inspectHost({
      socketPath: "/state/host.sock",
      stateDir: "/state",
      expectedHostCommand: ["bun", "/host.ts"],
    });

    expect(result.ownership).toMatchObject({
      status: "verified",
      holderPids: [50],
      socketIdentity: { inode: "10", birthtimeNs: "20" },
    });
    expect(result.terminalGroups).toEqual([
      expect.objectContaining({
        disposition: "verified",
        ptyId: "pty-1",
        ptyInstanceId: "instance-1",
        childPid: 200,
        processGroupId: 200,
        members: [expect.objectContaining({ pid: 200 }), expect.objectContaining({ pid: 201 })],
      }),
    ]);
    expect(client.list).toHaveBeenCalledTimes(2);
    expect(client.close).not.toHaveBeenCalled();
    expect(client.beginHandoff).not.toHaveBeenCalled();
  });

  it("ties Observer ownership to stable holders and exact process identity", async () => {
    const processEntry = {
      pid: 40,
      startToken: started,
      processToken: "00000000-0000-4000-8000-000000000001",
      buildVersion: "build-1",
      socketPath: "/state/observer.sock",
      executablePath: "/opt/stn",
      argv: ["/opt/stn", "__observer"],
    };
    let holderRead = 0;
    const evidence = createLocalRepairRuntimeEvidence({
      probeSocket: async () => ({ status: "listening", identity: socketIdentity }),
      observerEvidence: {
        readObserverProcess: () => processEntry,
        processStartToken: () => started,
        socketHolders: () => {
          holderRead += 1;
          return holderRead === 1 ? [40] : [41];
        },
      } as never,
    });
    const result = await evidence.inspectObserver({
      socketPath: "/state/observer.sock",
      status: {
        status: "running",
        paths: { socketPath: "/state/observer.sock", stateDir: "/state" },
        health: {
          schemaVersion: "0.11.0",
          status: "healthy",
          pid: 40,
          startedAt: new Date(started).toISOString(),
          version: "build-1",
          socketPath: "/state/observer.sock",
        },
      },
    });

    expect(result).toMatchObject({
      status: "uncertain",
      refusalCode: "OBSERVER_IDENTITY_CHANGED",
      holderPids: [40],
    });
  });

  it("refuses legacy Host health and mismatched executable provenance", async () => {
    const legacyClient = hostClient();
    vi.mocked(legacyClient.health).mockResolvedValueOnce({ ok: true, protocolVersion: 8 });
    const legacy = createLocalRepairRuntimeEvidence({
      probeSocket: async () => ({ status: "listening", identity: socketIdentity }),
      socketHolders: () => [50],
      hostClientFactory: () => legacyClient,
      readProcessCommand: () => ({
        startToken: started,
        executablePath: "bun",
        argv: ["bun", "/host.ts", "--socket", "/state/host.sock", "--state-dir", "/state"],
      }),
    });
    await expect(
      legacy.inspectHost({
        socketPath: "/state/host.sock",
        stateDir: "/state",
        expectedHostCommand: ["bun", "/host.ts"],
      }),
    ).resolves.toMatchObject({
      ownership: { status: "uncertain", refusalCode: "HOST_PROTOCOL_INCOMPATIBLE" },
    });

    const mismatchClient = hostClient();
    const mismatch = createLocalRepairRuntimeEvidence({
      probeSocket: async () => ({ status: "listening", identity: socketIdentity }),
      socketHolders: () => [50],
      hostClientFactory: () => mismatchClient,
      readProcessCommand: () => ({
        startToken: started,
        executablePath: "other",
        argv: ["bun", "/host.ts", "--socket", "/state/host.sock", "--state-dir", "/state"],
      }),
    });
    await expect(
      mismatch.inspectHost({
        socketPath: "/state/host.sock",
        stateDir: "/state",
        expectedHostCommand: ["bun", "/host.ts"],
      }),
    ).resolves.toMatchObject({
      ownership: { status: "uncertain", refusalCode: "HOST_PROCESS_PROVENANCE_UNVERIFIED" },
    });
    expect(mismatchClient.health).not.toHaveBeenCalled();
  });

  it("refuses ambiguous holders and topology changes without calling Host mutations", async () => {
    const ambiguousClient = hostClient();
    const ambiguous = createLocalRepairRuntimeEvidence({
      probeSocket: async () => ({ status: "listening", identity: socketIdentity }),
      socketHolders: () => [50, 51],
      hostClientFactory: () => ambiguousClient,
    });
    await expect(
      ambiguous.inspectHost({
        socketPath: "/state/host.sock",
        stateDir: "/state",
        expectedHostCommand: ["bun", "/host.ts"],
      }),
    ).resolves.toMatchObject({
      ownership: { status: "uncertain", refusalCode: "HOST_HOLDER_AMBIGUOUS" },
    });
    expect(ambiguousClient.health).not.toHaveBeenCalled();

    const changedClient = hostClient();
    let topologyRead = 0;
    const changed = createLocalRepairRuntimeEvidence({
      probeSocket: async () => ({ status: "listening", identity: socketIdentity }),
      socketHolders: () => [50],
      hostClientFactory: () => changedClient,
      readProcessCommand: () => ({
        startToken: started,
        executablePath: "bun",
        argv: ["bun", "/host.ts", "--socket", "/state/host.sock", "--state-dir", "/state"],
      }),
      readProcessTopologies: () => {
        topologyRead += 1;
        return [
          {
            pid: 200,
            processGroupId: topologyRead === 1 ? 200 : 999,
            sessionId: 200,
            tty: "ttys001",
            startToken: started,
          },
        ];
      },
    });
    const result = await changed.inspectHost({
      socketPath: "/state/host.sock",
      stateDir: "/state",
      expectedHostCommand: ["bun", "/host.ts"],
    });
    expect(result.terminalGroups[0]).toMatchObject({
      disposition: "refused",
      refusalCode: "PROCESS_TOPOLOGY_UNVERIFIED",
    });
    expect(changedClient.close).not.toHaveBeenCalled();
    expect(changedClient.beginHandoff).not.toHaveBeenCalled();
  });
});

function hostClient(): StationHostClient {
  return {
    health: vi.fn(async () => ({ ok: true, protocolVersion: 8, buildVersion: "build-1" })),
    list: vi.fn(async () => [
      {
        kind: "agent" as const,
        terminalTargetId: "terminal-1",
        ptyId: "pty-1",
        ptyInstanceId: "instance-1",
        worktreeId: "worktree-1",
        projectId: "project-1",
        sessionId: "session-1",
        worktreePath: "/private/worktree",
        harnessProvider: "codex",
        pid: 200,
        alive: true,
        cols: 80,
        rows: 24,
      },
    ]),
    close: vi.fn(),
    beginHandoff: vi.fn(),
    stopIfIdle: vi.fn(),
    completeHandoff: vi.fn(),
    abortHandoff: vi.fn(),
    adoptRegistry: vi.fn(),
    spawn: vi.fn(),
    focus: vi.fn(),
    attach: vi.fn(),
    dispose: vi.fn(),
  } as unknown as StationHostClient;
}
