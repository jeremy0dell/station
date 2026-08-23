import { stationHostSocketPath } from "@station/config";
import { HOST_PROTOCOL_VERSION, stationHostSafeError } from "@station/host";
import { listenUnixSocket } from "@station/protocol";
import { describe, expect, it, vi } from "vitest";
import { createTempState } from "../../../../tests/support/temp-projects";
import { runHostCommand } from "../../src/commands/host/index.js";

const requestingBuild = "0.0.0-cli-request";

describe("runHostCommand", () => {
  it("reports status health, compatibility, and handoff eligibility", async () => {
    const fixture = await createTempState();
    const socketPath = stationHostSocketPath(fixture.config);
    const server = await listenUnixSocket({
      socketPath,
      onConnection: () => undefined,
    });
    const dispose = vi.fn();
    const requestedBuilds: string[] = [];
    try {
      const result = await runHostCommand(
        ["status"],
        { config: fixture.config },
        {
          expectedBuildVersion: requestingBuild,
          clientFactory: (_socketPath, expectedBuildVersion) => {
            requestedBuilds.push(expectedBuildVersion);
            return {
              health: async () => ({
                ok: true,
                protocolVersion: HOST_PROTOCOL_VERSION,
                buildVersion: "older-build",
              }),
              list: async () => {
                if (expectedBuildVersion !== "older-build") {
                  throw new Error("wrong inventory identity");
                }
                return [{ ptyId: "pty-1", pid: 42, alive: true }];
              },
              recoveryInventory: async () => ({
                buildIdentity: "older-build-identity",
                ptys: [
                  {
                    ptyId: "pty-1",
                    pid: 42,
                    alive: true,
                    handoffSupport: { kind: "bridge-releasable" },
                  },
                ],
              }),
              dispose,
            } as never;
          },
        },
      );

      expect(result).toMatchObject({
        action: "status",
        probe: "listening",
        livePtyCount: 1,
        handoffEligible: true,
        compatibility: { action: "replace" },
        buildIdentity: "older-build-identity",
        ptys: [{ handoffSupport: { kind: "bridge-releasable" } }],
      });
      expect(requestedBuilds).toEqual([requestingBuild, "older-build"]);
      expect(dispose).toHaveBeenCalledTimes(2);
    } finally {
      await server.close();
    }
  });

  it("falls back to protocol-v8 host.list when recovery inventory is unavailable", async () => {
    const fixture = await createTempState();
    const socketPath = stationHostSocketPath(fixture.config);
    const server = await listenUnixSocket({ socketPath, onConnection: () => undefined });
    const list = vi.fn(async () => [{ ptyId: "pty-legacy", pid: 42, alive: true }]);
    try {
      const result = await runHostCommand(
        ["status"],
        { config: fixture.config },
        {
          expectedBuildVersion: requestingBuild,
          clientFactory: () =>
            ({
              health: async () => ({
                ok: true,
                protocolVersion: HOST_PROTOCOL_VERSION,
                buildVersion: requestingBuild,
              }),
              recoveryInventory: async () => {
                throw stationHostSafeError("HOST_BAD_REQUEST", "unknown method");
              },
              list,
              dispose: () => undefined,
            }) as never,
        },
      );

      expect(result).toMatchObject({
        action: "status",
        probe: "listening",
        livePtyCount: 1,
        ptys: [{ ptyId: "pty-legacy" }],
      });
      expect(result).not.toHaveProperty("buildIdentity");
      expect(list).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });

  it("dry-run plans handoff without calling ensure/begin", async () => {
    const fixture = await createTempState();
    const ensureHost = vi.fn();
    const beginHandoff = vi.fn();
    const completeHandoff = vi.fn();
    const result = await runHostCommand(
      ["handoff", "--dry-run", "--fidelity", "screen"],
      { config: fixture.config },
      {
        expectedBuildVersion: requestingBuild,
        ensureHost,
        clientFactory: () =>
          ({
            health: async () => ({
              ok: true,
              protocolVersion: HOST_PROTOCOL_VERSION,
              buildVersion: "older-build",
            }),
            list: async () => [{ ptyId: "pty-1", pid: 42, alive: true }],
            beginHandoff,
            completeHandoff,
            dispose: () => undefined,
          }) as never,
      },
    );

    expect(result).toMatchObject({
      action: "handoff",
      dryRun: true,
      fidelity: "screen",
      status: "planned",
      livePtyCount: 1,
    });
    expect(ensureHost).not.toHaveBeenCalled();
    expect(beginHandoff).not.toHaveBeenCalled();
    expect(completeHandoff).not.toHaveBeenCalled();
  });

  it("dry-run refuses when the host already matches this build", async () => {
    const fixture = await createTempState();
    const ensureHost = vi.fn();
    const result = await runHostCommand(
      ["handoff", "--dry-run"],
      { config: fixture.config },
      {
        expectedBuildVersion: requestingBuild,
        ensureHost,
        clientFactory: () =>
          ({
            health: async () => ({
              ok: true,
              protocolVersion: HOST_PROTOCOL_VERSION,
              buildVersion: requestingBuild,
            }),
            list: async () => [{ ptyId: "pty-1", pid: 42, alive: true }],
            dispose: () => undefined,
          }) as never,
      },
    );

    expect(result).toMatchObject({
      action: "handoff",
      status: "refused",
    });
    expect(String((result as { message: string }).message)).toMatch(/unnecessary/i);
    expect(ensureHost).not.toHaveBeenCalled();
  });

  it("dry-run refuses handoff on protocol major mismatch", async () => {
    const fixture = await createTempState();
    const ensureHost = vi.fn();
    const result = await runHostCommand(
      ["handoff", "--dry-run", "--fidelity", "processes"],
      { config: fixture.config },
      {
        expectedBuildVersion: requestingBuild,
        ensureHost,
        clientFactory: () =>
          ({
            health: async () => ({
              ok: true,
              protocolVersion: HOST_PROTOCOL_VERSION + 100,
              buildVersion: "other-build",
            }),
            list: async () => [{ ptyId: "pty-1", pid: 42, alive: true }],
            dispose: () => undefined,
          }) as never,
      },
    );

    expect(result).toMatchObject({
      action: "handoff",
      status: "refused",
    });
    expect(String((result as { message: string }).message)).toMatch(/incompatible/i);
    expect(ensureHost).not.toHaveBeenCalled();
  });

  it("dry-run refuses handoff when the host is idle", async () => {
    const fixture = await createTempState();
    const ensureHost = vi.fn();
    const result = await runHostCommand(
      ["handoff", "--dry-run"],
      { config: fixture.config },
      {
        expectedBuildVersion: requestingBuild,
        ensureHost,
        clientFactory: () =>
          ({
            health: async () => ({
              ok: true,
              protocolVersion: HOST_PROTOCOL_VERSION,
              buildVersion: "older-build",
            }),
            list: async () => [],
            dispose: () => undefined,
          }) as never,
      },
    );

    expect(result).toMatchObject({
      action: "handoff",
      status: "refused",
      livePtyCount: 0,
    });
    expect(ensureHost).not.toHaveBeenCalled();
  });

  it("live handoff opts into ensure and projects the adopt report", async () => {
    const fixture = await createTempState();
    const dispose = vi.fn();
    const ensureHost = vi.fn(async () => ({
      status: "running" as const,
      socketPath: stationHostSocketPath(fixture.config),
      ensuredBy: "handoff" as const,
      handoffAdopt: {
        adopted: ["pty-1"],
        failed: [],
        receipt: {
          terminals: [
            {
              terminalTargetId: "native:wt-1",
              ptyId: "pty-1",
              ptyInstanceId: "instance-pty-1",
            },
          ],
        },
      },
      client: {
        list: async () => [{ ptyId: "pty-1", pid: 99, alive: true }],
        dispose,
      },
    }));
    const result = await runHostCommand(
      ["handoff", "--fidelity", "screen"],
      { config: fixture.config },
      {
        expectedBuildVersion: requestingBuild,
        ensureHost: ensureHost as never,
        clientFactory: () =>
          ({
            health: async () => ({
              ok: true,
              protocolVersion: HOST_PROTOCOL_VERSION,
              buildVersion: "older-build",
            }),
            list: async () => [{ ptyId: "pty-1", pid: 42, alive: true }],
            dispose: () => undefined,
          }) as never,
      },
    );

    expect(result).toMatchObject({
      action: "handoff",
      status: "completed",
      fidelity: "screen",
      livePtyCount: 1,
      receipt: {
        terminals: [
          {
            terminalTargetId: "native:wt-1",
            ptyId: "pty-1",
            ptyInstanceId: "instance-pty-1",
          },
        ],
      },
    });
    expect(ensureHost).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedBuildVersion: requestingBuild,
        handoff: { fidelity: "screen" },
      }),
      expect.anything(),
    );
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("projects ensure reuse as refused without claiming handoff", async () => {
    const fixture = await createTempState();
    const ensureHost = vi.fn(async () => ({
      status: "running" as const,
      socketPath: stationHostSocketPath(fixture.config),
      ensuredBy: "reuse" as const,
      client: { dispose: () => undefined },
    }));
    const result = await runHostCommand(
      ["handoff"],
      { config: fixture.config },
      {
        expectedBuildVersion: requestingBuild,
        ensureHost: ensureHost as never,
      },
    );

    expect(result).toMatchObject({
      action: "handoff",
      status: "refused",
    });
    expect(String((result as { message: string }).message)).toMatch(/unnecessary/i);
  });

  it("surfaces ensure failure as unavailable without claiming completion", async () => {
    const fixture = await createTempState();
    const ensureHost = vi.fn(async () => ({
      status: "unavailable" as const,
      socketPath: stationHostSocketPath(fixture.config),
      error: {
        code: "HOST_HANDOFF_INVALID_STATE",
        message: "handoff could not complete",
      },
    }));
    const result = await runHostCommand(
      ["handoff"],
      { config: fixture.config },
      {
        expectedBuildVersion: requestingBuild,
        ensureHost: ensureHost as never,
      },
    );

    expect(result).toMatchObject({
      action: "handoff",
      status: "unavailable",
      message: "handoff could not complete",
    });
  });
});
