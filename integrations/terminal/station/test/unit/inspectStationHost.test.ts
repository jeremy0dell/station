import { HOST_PROTOCOL_VERSION } from "@station/contracts";
import {
  openStationHostLifecycleSession,
  type StationHostLifecycleSession,
  serveHostConnection,
} from "@station/host";
import { inMemoryNdjsonConnectionPair } from "@station/protocol";
import { type InspectStationHostDeps, inspectStationHost } from "@station/terminal";
import { describe, expect, it, vi } from "vitest";

const socketPath = "/state/station-host.sock";
const endpoint = { socketPath, ino: 11n, birthtimeNs: 22n };
const runningBuildVersion = "0.9.0+incumbent";
const health = {
  ok: true as const,
  protocolVersion: HOST_PROTOCOL_VERSION,
  buildVersion: runningBuildVersion,
};
const terminal = {
  kind: "agent" as const,
  terminalTargetId: "target-a",
  ptyId: "pty-a",
  ptyInstanceId: "instance-a",
  worktreeId: "worktree-a",
  projectId: "project-a",
  sessionId: "session-a",
  worktreePath: "/repo/a",
  harnessProvider: "codex",
  pid: 42,
  alive: true,
  cols: 80,
  rows: 24,
  handoffSupport: { kind: "bridge-releasable" as const },
};
const inventory = { buildIdentity: "a".repeat(64), ptys: [terminal] };

function exactDeps(
  calls: string[],
  overrides: {
    probes?: Array<unknown>;
    discoveryHealth?: unknown;
    exactHealth?: Array<unknown>;
    inventory?: unknown;
  } = {},
): InspectStationHostDeps {
  const probes = overrides.probes ?? [
    { status: "listening", endpoint },
    { status: "listening", endpoint },
  ];
  let probeIndex = 0;
  let sessionIndex = 0;
  return {
    probeEndpoint: vi.fn(async (path) => {
      calls.push(`probe:${path}`);
      return probes[probeIndex++] as Awaited<
        ReturnType<NonNullable<InspectStationHostDeps["probeEndpoint"]>>
      >;
    }),
    openSession: async ({ socketPath: path, expectedBuildVersion }) => {
      const index = sessionIndex++;
      calls.push(`factory:${index}:${path}:${expectedBuildVersion}`);
      let healthIndex = 0;
      return {
        health: async () => {
          calls.push(`health:${index}`);
          const value =
            index === 0
              ? (overrides.discoveryHealth ?? health)
              : (overrides.exactHealth?.[healthIndex++] ?? health);
          if (value instanceof Error) throw value;
          return value as typeof health;
        },
        recoveryInventory: async () => {
          calls.push(`inventory:${index}`);
          const value = overrides.inventory ?? inventory;
          if (value instanceof Error) throw value;
          return value as typeof inventory;
        },
        dispose: () => calls.push(`dispose:${index}`),
      } as unknown as StationHostLifecycleSession;
    },
  };
}

describe("inspectStationHost", () => {
  it("discovers an old display build, then reads one exact identity-bound inventory", async () => {
    const calls: string[] = [];
    await expect(
      inspectStationHost({ socketPath, expectedBuildVersion: "1.0.0+requester" }, exactDeps(calls)),
    ).resolves.toEqual({
      status: "exact",
      evidence: { endpoint, health, buildIdentity: "a".repeat(64), terminals: [terminal] },
    });
    expect(calls).toEqual([
      `probe:${socketPath}`,
      `factory:0:${socketPath}:1.0.0+requester`,
      "health:0",
      "dispose:0",
      `factory:1:${socketPath}:${runningBuildVersion}`,
      "health:1",
      "inventory:1",
      "health:1",
      `probe:${socketPath}`,
      "dispose:1",
    ]);
  });

  it("binds recovery inventory to the incumbent build at the real server boundary", async () => {
    const factoryBuilds: string[] = [];
    let inventoryReads = 0;
    const result = await inspectStationHost(
      { socketPath, expectedBuildVersion: "1.0.0+requester" },
      {
        probeEndpoint: async () => ({ status: "listening", endpoint }),
        openSession: async ({ socketPath: path, expectedBuildVersion, deadlineMs }) => {
          factoryBuilds.push(expectedBuildVersion);
          const pair = inMemoryNdjsonConnectionPair();
          void serveHostConnection(pair.server, {
            hostCompatibility: {
              protocolVersion: HOST_PROTOCOL_VERSION,
              buildVersion: runningBuildVersion,
            },
            unary: {
              "host.health": () => health,
              "host.recoveryInventory": () => {
                inventoryReads += 1;
                return inventory;
              },
            },
          });
          return openStationHostLifecycleSession({
            socketPath: path,
            expectedBuildVersion,
            deadlineMs,
            connect: async () => pair.client,
          });
        },
      },
    );

    expect(result).toMatchObject({ status: "exact" });
    expect(factoryBuilds).toEqual(["1.0.0+requester", runningBuildVersion]);
    expect(inventoryReads).toBe(1);
  });

  it("strictly rejects invalid options before probing", async () => {
    const probeEndpoint = vi.fn();
    await expect(inspectStationHost({ socketPath: "" }, { probeEndpoint })).rejects.toThrow();
    await expect(
      inspectStationHost({ socketPath, unexpected: true } as never, { probeEndpoint }),
    ).rejects.toThrow();
    expect(probeEndpoint).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: "absent" }, { status: "absent" }],
    [
      { status: "stale", endpoint },
      { status: "stale", endpoint },
    ],
    [
      { status: "inaccessible", error: { tag: "HostError", code: "DENIED", message: "no" } },
      { status: "inaccessible", error: { tag: "HostError", code: "DENIED", message: "no" } },
    ],
  ])("returns initial non-listening evidence without creating a client", async (probe, expected) => {
    const openSession = vi.fn();
    await expect(
      inspectStationHost(
        { socketPath, expectedBuildVersion: "requester" },
        { probeEndpoint: async () => probe as never, openSession },
      ),
    ).resolves.toEqual(expected);
    expect(openSession).not.toHaveBeenCalled();
  });

  it("rejects socket-path substitution before opening a client", async () => {
    const openSession = vi.fn();
    await expect(
      inspectStationHost(
        { socketPath, expectedBuildVersion: "requester" },
        {
          probeEndpoint: async () => ({
            status: "listening",
            endpoint: { ...endpoint, socketPath: "/state/substituted.sock" },
          }),
          openSession,
        },
      ),
    ).resolves.toMatchObject({ status: "unknown", reason: "endpoint-drift" });
    expect(openSession).not.toHaveBeenCalled();
  });

  it.each([
    { ...endpoint, socketPath: "/state/substituted.sock" },
    { ...endpoint, ino: 12n },
    { ...endpoint, birthtimeNs: 23n },
  ])("rejects final endpoint substitution or physical drift", async (finalEndpoint) => {
    const calls: string[] = [];
    await expect(
      inspectStationHost(
        { socketPath, expectedBuildVersion: "requester" },
        exactDeps(calls, {
          probes: [
            { status: "listening", endpoint },
            { status: "listening", endpoint: finalEndpoint },
          ],
        }),
      ),
    ).resolves.toMatchObject({ status: "unknown", reason: "endpoint-drift" });
    expect(calls.filter((call) => call === "inventory:1")).toHaveLength(1);
    expect(calls).toContain("dispose:0");
    expect(calls).toContain("dispose:1");
  });

  it("rejects wrong-protocol discovery before inventory and disposes the client", async () => {
    const calls: string[] = [];
    await expect(
      inspectStationHost(
        { socketPath, expectedBuildVersion: "requester" },
        exactDeps(calls, { discoveryHealth: { ...health, protocolVersion: 7 } }),
      ),
    ).resolves.toMatchObject({ status: "unknown", reason: "health-failed" });
    expect(calls).toContain("dispose:0");
    expect(calls.some((call) => call.startsWith("factory:1"))).toBe(false);
  });

  it.each([
    { exactHealth: [{ ...health, buildVersion: "different" }] },
    { exactHealth: [health, { ...health, buildVersion: "different" }] },
  ])("rejects health drift around the single inventory read", async (overrides) => {
    const calls: string[] = [];
    await expect(
      inspectStationHost(
        { socketPath, expectedBuildVersion: "requester" },
        exactDeps(calls, overrides),
      ),
    ).resolves.toMatchObject({ status: "unknown", reason: "health-drift" });
    expect(calls.filter((call) => call === "inventory:1")).toHaveLength(
      overrides.exactHealth[0]?.buildVersion === runningBuildVersion ? 1 : 0,
    );
  });

  it("rejects invalid immutable inventory identity after both strict health reads", async () => {
    const calls: string[] = [];
    await expect(
      inspectStationHost(
        { socketPath, expectedBuildVersion: "requester" },
        exactDeps(calls, { inventory: { ...inventory, buildIdentity: "A".repeat(64) } }),
      ),
    ).resolves.toMatchObject({ status: "unknown", reason: "inventory-failed" });
    expect(calls.filter((call) => call === "health:1")).toHaveLength(2);
    expect(calls).toContain("dispose:1");
  });

  it("final-correlates health and endpoint after an inventory request failure", async () => {
    const calls: string[] = [];
    await expect(
      inspectStationHost(
        { socketPath, expectedBuildVersion: "requester" },
        exactDeps(calls, { inventory: new Error("malformed inventory") }),
      ),
    ).resolves.toMatchObject({ status: "unknown", reason: "inventory-failed" });
    expect(calls.filter((call) => call === "health:1")).toHaveLength(2);
    expect(calls.at(-2)).toBe(`probe:${socketPath}`);
    expect(calls.at(-1)).toBe("dispose:1");
  });
});
