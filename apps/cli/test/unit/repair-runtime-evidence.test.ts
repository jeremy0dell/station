import type { HostListEntry, StationHostClient } from "@station/host";
import { describe, expect, it, vi } from "vitest";
import {
  createLocalRepairRuntimeEvidence,
  parseProcessTopologies,
} from "../../src/commands/repair/localRuntimeEvidence";

const socketIdentity = { ino: 10n, birthtimeNs: 20n };
const started = "Thu Aug 20 08:00:00 2026";
const processToken = "00000000-0000-4000-8000-000000000001";

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
    const hostClientFactory = vi.fn(() => client);
    const evidence = createLocalRepairRuntimeEvidence({
      probeSocket: async () => ({ status: "listening", identity: socketIdentity }),
      socketHolders: () => [50],
      hostClientFactory,
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
    expect(hostClientFactory).toHaveBeenNthCalledWith(1, "/state/host.sock");
    expect(hostClientFactory).toHaveBeenNthCalledWith(2, "/state/host.sock", "build-1");
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
        readProcessIdentity: async () => observerIdentity(),
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

  it("verifies Observer identity when health becomes ready in a later second", async () => {
    const evidence = createLocalRepairRuntimeEvidence({
      probeSocket: async () => ({ status: "listening", identity: socketIdentity }),
      observerEvidence: {
        readObserverProcess: () => observerProcess(),
        readProcessIdentity: async () => observerIdentity(),
        processStartToken: () => started,
        socketHolders: () => [40],
      } as never,
    });

    await expect(
      evidence.inspectObserver({
        socketPath: "/state/observer.sock",
        status: {
          status: "running",
          paths: { socketPath: "/state/observer.sock", stateDir: "/state" },
          health: {
            schemaVersion: "0.11.0",
            status: "healthy",
            pid: 40,
            startedAt: new Date(Date.parse(started) + 1_500).toISOString(),
            version: "build-1",
            socketPath: "/state/observer.sock",
          },
        },
      }),
    ).resolves.toMatchObject({
      status: "verified",
      holderPids: [40],
      process: { pid: 40, startToken: started },
      buildVersion: "build-1",
    });
  });

  it("refuses Observer health that names another socket or process build", async () => {
    const observerEvidence = {
      readObserverProcess: vi.fn(() => observerProcess({ buildVersion: "old-build" })),
      readProcessIdentity: vi.fn(async () => observerIdentity({ version: "old-build" })),
      processStartToken: vi.fn(() => started),
      socketHolders: vi.fn(() => [40]),
    };
    const evidence = createLocalRepairRuntimeEvidence({
      probeSocket: async () => ({ status: "listening", identity: socketIdentity }),
      observerEvidence: observerEvidence as never,
    });
    const baseStatus = {
      status: "running" as const,
      paths: { socketPath: "/state/observer.sock", stateDir: "/state" },
      health: {
        schemaVersion: "0.11.0" as const,
        status: "healthy" as const,
        pid: 40,
        startedAt: new Date(started).toISOString(),
        version: "new-build",
        socketPath: "/state/observer.sock",
      },
    };

    await expect(
      evidence.inspectObserver({
        socketPath: "/state/observer.sock",
        status: { ...baseStatus, health: { ...baseStatus.health, socketPath: "/other.sock" } },
      }),
    ).resolves.toMatchObject({
      status: "uncertain",
      refusalCode: "OBSERVER_IDENTITY_CHANGED",
    });
    expect(observerEvidence.readObserverProcess).not.toHaveBeenCalled();

    await expect(
      evidence.inspectObserver({ socketPath: "/state/observer.sock", status: baseStatus }),
    ).resolves.toMatchObject({
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

  it("refuses a replaced Host binary before making any Host RPC", async () => {
    const hostClientFactory = vi.fn(() => hostClient());
    const evidence = createLocalRepairRuntimeEvidence({
      probeSocket: async () => ({ status: "listening", identity: socketIdentity }),
      socketHolders: () => [50],
      hostClientFactory,
      // A same-path binary replacement makes the running text inode differ from the current file.
      readProcessCommand: () => undefined,
    });

    await expect(
      evidence.inspectHost({
        socketPath: "/state/host.sock",
        stateDir: "/state",
        expectedHostCommand: ["/opt/stn", "__station-host"],
      }),
    ).resolves.toMatchObject({
      ownership: { status: "uncertain", refusalCode: "HOST_PROCESS_PROVENANCE_UNVERIFIED" },
      terminalGroups: [],
    });
    expect(hostClientFactory).not.toHaveBeenCalled();
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

  it("refuses Host socket, holder, process, and PTY-instance changes across the read", async () => {
    const scenarios = [
      {
        name: "socket lifetime",
        configure: (_client: StationHostClient) => {
          let reads = 0;
          return {
            probeSocket: async () => ({
              status: "listening" as const,
              identity: reads++ === 0 ? socketIdentity : { ino: 11n, birthtimeNs: 21n },
            }),
          };
        },
      },
      {
        name: "holder PID",
        configure: (_client: StationHostClient) => {
          let reads = 0;
          return { socketHolders: () => (reads++ === 0 ? [50] : [51]) };
        },
      },
      {
        name: "process start token",
        configure: (_client: StationHostClient) => {
          let reads = 0;
          return {
            readProcessCommand: () => ({
              startToken: reads++ === 0 ? started : "Thu Aug 20 09:00:00 2026",
              executablePath: "bun",
              argv: ["bun", "/host.ts", "--socket", "/state/host.sock", "--state-dir", "/state"],
            }),
          };
        },
      },
      {
        name: "PTY instance",
        configure: (client: StationHostClient) => {
          vi.mocked(client.list)
            .mockResolvedValueOnce([hostPty()])
            .mockResolvedValueOnce([hostPty({ ptyInstanceId: "instance-2" })]);
          return {};
        },
      },
    ];

    for (const scenario of scenarios) {
      const client = hostClient();
      const overrides = scenario.configure(client);
      const evidence = createLocalRepairRuntimeEvidence({
        probeSocket: async () => ({ status: "listening", identity: socketIdentity }),
        socketHolders: () => [50],
        hostClientFactory: () => client,
        readProcessCommand: () => hostProcess(),
        readProcessTopologies: () => stableTopologies(),
        ...overrides,
      });

      await expect(
        evidence.inspectHost({
          socketPath: "/state/host.sock",
          stateDir: "/state",
          expectedHostCommand: ["bun", "/host.ts"],
        }),
        scenario.name,
      ).resolves.toMatchObject({
        ownership: { status: "uncertain", refusalCode: "HOST_INVENTORY_CHANGED" },
        terminalGroups: [],
      });
      expect(client.close, scenario.name).not.toHaveBeenCalled();
      expect(client.beginHandoff, scenario.name).not.toHaveBeenCalled();
    }
  });

  it("refuses dead agents, PID reuse, and unavailable topology tools", async () => {
    const deadClient = hostClient();
    vi.mocked(deadClient.list).mockResolvedValue([hostPty({ alive: false })]);
    const dead = createLocalRepairRuntimeEvidence({
      probeSocket: async () => ({ status: "listening", identity: socketIdentity }),
      socketHolders: () => [50],
      hostClientFactory: () => deadClient,
      readProcessCommand: () => hostProcess(),
      readProcessTopologies: () => stableTopologies(),
    });
    await expect(
      dead.inspectHost({
        socketPath: "/state/host.sock",
        stateDir: "/state",
        expectedHostCommand: ["bun", "/host.ts"],
      }),
    ).resolves.toMatchObject({
      ownership: { status: "verified" },
      terminalGroups: [{ disposition: "refused", refusalCode: "PROCESS_TOPOLOGY_UNVERIFIED" }],
    });

    let topologyRead = 0;
    const reusedClient = hostClient();
    const reused = createLocalRepairRuntimeEvidence({
      probeSocket: async () => ({ status: "listening", identity: socketIdentity }),
      socketHolders: () => [50],
      hostClientFactory: () => reusedClient,
      readProcessCommand: () => hostProcess(),
      readProcessTopologies: () => {
        topologyRead += 1;
        return stableTopologies(topologyRead === 1 ? started : "Thu Aug 20 09:00:00 2026");
      },
    });
    await expect(
      reused.inspectHost({
        socketPath: "/state/host.sock",
        stateDir: "/state",
        expectedHostCommand: ["bun", "/host.ts"],
      }),
    ).resolves.toMatchObject({
      terminalGroups: [{ disposition: "refused", refusalCode: "PROCESS_TOPOLOGY_UNVERIFIED" }],
    });

    const unavailableClient = hostClient();
    const unavailable = createLocalRepairRuntimeEvidence({
      probeSocket: async () => ({ status: "listening", identity: socketIdentity }),
      socketHolders: () => [50],
      hostClientFactory: () => unavailableClient,
      readProcessCommand: () => hostProcess(),
      readProcessTopologies: () => {
        throw new Error("ps unavailable");
      },
    });
    await expect(
      unavailable.inspectHost({
        socketPath: "/state/host.sock",
        stateDir: "/state",
        expectedHostCommand: ["bun", "/host.ts"],
      }),
    ).resolves.toMatchObject({
      ownership: { status: "uncertain", refusalCode: "HOST_EVIDENCE_UNAVAILABLE" },
      terminalGroups: [],
    });
  });

  it("keeps auxiliary PTYs visible but never recoverable", async () => {
    const client = hostClient();
    vi.mocked(client.list).mockResolvedValue([hostPty({ kind: "aux" })]);
    const evidence = createLocalRepairRuntimeEvidence({
      probeSocket: async () => ({ status: "listening", identity: socketIdentity }),
      socketHolders: () => [50],
      hostClientFactory: () => client,
      readProcessCommand: () => hostProcess(),
      readProcessTopologies: () => stableTopologies(),
    });

    await expect(
      evidence.inspectHost({
        socketPath: "/state/host.sock",
        stateDir: "/state",
        expectedHostCommand: ["bun", "/host.ts"],
      }),
    ).resolves.toMatchObject({
      ownership: { status: "verified" },
      terminalGroups: [{ kind: "aux", disposition: "non-recoverable" }],
    });
  });
});

function hostProcess() {
  return {
    startToken: started,
    executablePath: "bun",
    argv: ["bun", "/host.ts", "--socket", "/state/host.sock", "--state-dir", "/state"],
  };
}

function observerProcess(overrides: Record<string, unknown> = {}) {
  return {
    pid: 40,
    startToken: started,
    processToken,
    buildVersion: "build-1",
    socketPath: "/state/observer.sock",
    executablePath: "/opt/stn",
    argv: ["/opt/stn", "__observer"],
    ...overrides,
  };
}

function observerIdentity(overrides: Record<string, unknown> = {}) {
  return {
    pid: 40,
    osStartTime: started,
    processToken,
    version: "build-1",
    socketPath: "/state/observer.sock",
    ...overrides,
  };
}

function stableTopologies(startToken = started) {
  return [
    { pid: 200, processGroupId: 200, sessionId: 200, tty: "ttys001", startToken },
    { pid: 201, processGroupId: 200, sessionId: 200, tty: "ttys001", startToken },
  ];
}

function hostPty(overrides: Partial<HostListEntry> = {}): HostListEntry {
  return {
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
    ...overrides,
  };
}

function hostClient(): StationHostClient {
  return {
    health: vi.fn(async () => ({ ok: true, protocolVersion: 8, buildVersion: "build-1" })),
    list: vi.fn(async () => [hostPty()]),
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
