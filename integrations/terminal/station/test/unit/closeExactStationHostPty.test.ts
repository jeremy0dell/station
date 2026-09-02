import { HOST_PROTOCOL_VERSION, type StationHostExactEvidence } from "@station/contracts";
import type { StationHostLifecycleSession } from "@station/host";
import { describe, expect, it, vi } from "vitest";
import { closeExactStationHostPty } from "../../src/host/closeExactStationHostPty.js";

const terminal = {
  kind: "agent" as const,
  terminalTargetId: "native:wt-1",
  ptyId: "pty-1",
  ptyInstanceId: "ptyi_1",
  worktreeId: "wt-1",
  projectId: "project-1",
  sessionId: "session-1",
  worktreePath: "/repo/wt-1",
  harnessProvider: "codex",
  pid: 42,
  alive: true,
  cols: 80,
  rows: 24,
  handoffSupport: { kind: "bridge-releasable" as const },
};

const evidence: StationHostExactEvidence = {
  endpoint: { socketPath: "/tmp/station-host.sock", ino: 11n, birthtimeNs: 12n },
  health: { ok: true, protocolVersion: HOST_PROTOCOL_VERSION, buildVersion: "test" },
  buildIdentity: "a".repeat(64),
  terminals: [terminal],
};

describe("closeExactStationHostPty", () => {
  it("closes and proves absence on one physical lifecycle session", async () => {
    let closed = false;
    const session = fakeSession({
      inventory: () => ({
        buildIdentity: evidence.buildIdentity,
        ptys: closed ? [] : [terminal],
      }),
      close: async () => {
        closed = true;
        return { closed: true };
      },
    });
    const openSession = vi.fn(async () => session);

    await expect(
      closeExactStationHostPty(
        { expectedHost: evidence, expectedPty: terminal },
        {
          openSession,
          probeEndpoint: async () => ({ status: "listening", endpoint: evidence.endpoint }),
        },
      ),
    ).resolves.toEqual({ status: "released" });
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(session.close).toHaveBeenCalledWith("pty-1");
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it("refuses cleanup when the Host endpoint generation drifts", async () => {
    const session = fakeSession({
      inventory: () => ({ buildIdentity: evidence.buildIdentity, ptys: [terminal] }),
      close: async () => ({ closed: true }),
    });

    await expect(
      closeExactStationHostPty(
        { expectedHost: evidence, expectedPty: terminal },
        {
          openSession: async () => session,
          probeEndpoint: async () => ({
            status: "listening",
            endpoint: { ...evidence.endpoint, ino: 99n },
          }),
        },
      ),
    ).rejects.toMatchObject({ code: "TERMINAL_CLEANUP_UNCERTAIN" });
    expect(session.close).not.toHaveBeenCalled();
  });

  it("reports uncertainty when the Host refuses the exact close", async () => {
    const session = fakeSession({
      inventory: async () => ({ buildIdentity: evidence.buildIdentity, ptys: [terminal] }),
      close: async () => ({ closed: false }),
    });

    await expect(
      closeExactStationHostPty(
        { expectedHost: evidence, expectedPty: terminal },
        {
          openSession: async () => session,
          probeEndpoint: async () => ({ status: "listening", endpoint: evidence.endpoint }),
        },
      ),
    ).rejects.toMatchObject({ code: "TERMINAL_CLEANUP_UNCERTAIN" });
    expect(session.close).toHaveBeenCalledWith("pty-1");
  });

  it("reports uncertainty when the exact PTY remains after close", async () => {
    const session = fakeSession({
      inventory: async () => ({ buildIdentity: evidence.buildIdentity, ptys: [terminal] }),
      close: async () => ({ closed: true }),
    });

    await expect(
      closeExactStationHostPty(
        { expectedHost: evidence, expectedPty: terminal },
        {
          openSession: async () => session,
          probeEndpoint: async () => ({ status: "listening", endpoint: evidence.endpoint }),
        },
      ),
    ).rejects.toMatchObject({ code: "TERMINAL_CLEANUP_UNCERTAIN" });
    expect(session.recoveryInventory).toHaveBeenCalledTimes(2);
  });
});

function fakeSession(input: {
  inventory: StationHostLifecycleSession["recoveryInventory"];
  close: StationHostLifecycleSession["close"];
}): StationHostLifecycleSession {
  return {
    health: vi.fn(async () => evidence.health),
    recoveryInventory: vi.fn(input.inventory),
    close: vi.fn(input.close),
    stopIfIdle: vi.fn(),
    beginHandoff: vi.fn(),
    completeHandoff: vi.fn(),
    abortHandoff: vi.fn(),
    adoptRegistry: vi.fn(),
    dispose: vi.fn(),
  };
}
