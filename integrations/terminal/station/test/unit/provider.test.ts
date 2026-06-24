import type {
  OpenWorkspaceRequest,
  ProviderProjectConfig,
  WorktreeObservation,
} from "@station/contracts";
import type { HostListEntry, StationHostClient } from "@station/host";
import type { RuntimeClock } from "@station/runtime";
import { describe, expect, it, vi } from "vitest";
import { StationTerminalProviderError } from "../../src/errors";
import { createStationHostController } from "../../src/host/hostController";
import { StationTerminalProvider, stationTargetId } from "../../src/provider";

const now = "2026-05-21T12:00:00.000Z";
const clock: RuntimeClock = { now: () => new Date(now) };

const project: ProviderProjectConfig = {
  id: "web",
  label: "web",
  root: "/tmp/station/web",
  defaults: {
    harness: "claude",
    terminal: "native",
    layout: "agent-shell",
  },
  worktrunk: {
    enabled: true,
    base: "main",
  },
};

const worktree: WorktreeObservation = {
  id: "wt_web_feature",
  provider: "worktrunk",
  projectId: "web",
  branch: "feature/login",
  path: "/tmp/station/web/feature",
  state: "exists",
  source: "worktrunk",
  observedAt: now,
};

function openRequest(overrides: Partial<OpenWorkspaceRequest> = {}): OpenWorkspaceRequest {
  return {
    project,
    worktree,
    harness: "claude",
    layout: "agent-shell",
    sessionId: "ses_web_feature",
    ...overrides,
  };
}

describe("StationTerminalProvider", () => {
  it("identifies as the station provider with externally-hosted capabilities", () => {
    const provider = new StationTerminalProvider({ clock });
    expect(provider.id).toBe("native");
    expect(provider.capabilities()).toMatchObject({
      canOpenWorkspace: true,
      // No host injected: focus/close cannot be driven observer-side.
      canFocusTarget: false,
      canCloseTarget: false,
      canCaptureOutput: false,
      canSendInput: false,
      canPersistIdentityBinding: true,
    });
  });

  it("launchProcess does not spawn without a host (the UI owns the PTY)", async () => {
    const provider = new StationTerminalProvider({ clock });
    const result = await provider.launchProcess({
      project,
      worktree,
      terminalTarget: (await provider.openWorkspace(openRequest())).target,
      agentEndpointId: "native:web-feature",
      launchPlan: {
        provider: "claude",
        command: "claude",
        args: [],
        mode: "interactive",
      },
    });
    expect(result.started).toBe(false);
    await expect(provider.reattachInfo?.("native:web-feature")).resolves.toBeUndefined();
  });

  it("reports healthy", async () => {
    const provider = new StationTerminalProvider({ clock });
    await expect(provider.health()).resolves.toMatchObject({
      providerId: "native",
      providerType: "terminal",
      status: "healthy",
      lastCheckedAt: now,
    });
  });

  it("registers an in-memory target with a main-agent binding on openWorkspace", async () => {
    const provider = new StationTerminalProvider({ clock });
    const opened = await provider.openWorkspace(openRequest());

    expect(opened.agentEndpointId).toBe(stationTargetId(worktree.id));
    expect(opened.target).toMatchObject({
      provider: "native",
      targetId: stationTargetId(worktree.id),
      projectId: "web",
      worktreeId: "wt_web_feature",
      sessionId: "ses_web_feature",
      harnessBinding: {
        role: "main-agent",
        harnessProvider: "claude",
        worktreePath: "/tmp/station/web/feature",
      },
    });
  });

  it("surfaces the registered target via listTargets as an open, worktree-bound target", async () => {
    const provider = new StationTerminalProvider({ clock });
    await provider.openWorkspace(openRequest());

    const targets = await provider.listTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      id: stationTargetId(worktree.id),
      provider: "native",
      state: "open",
      focusable: false,
      closeable: false,
      projectId: "web",
      worktreeId: "wt_web_feature",
      sessionId: "ses_web_feature",
      cwd: "/tmp/station/web/feature",
      harnessBinding: { role: "main-agent", harnessProvider: "claude" },
    });
  });

  it("upserts so re-opening the same worktree never accrues two targets", async () => {
    const provider = new StationTerminalProvider({ clock });
    await provider.openWorkspace(openRequest({ sessionId: "ses_one" }));
    await provider.openWorkspace(openRequest({ sessionId: "ses_two" }));

    const targets = await provider.listTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0]?.sessionId).toBe("ses_two");
  });

  it("markExited drops the target so reconcile stops observing it", async () => {
    const provider = new StationTerminalProvider({ clock });
    await provider.openWorkspace(openRequest());
    const targetId = stationTargetId(worktree.id);

    expect(provider.markExited(targetId)).toBe(true);
    await expect(provider.listTargets()).resolves.toEqual([]);
    // Idempotent: a second exit report for the same target is a no-op.
    expect(provider.markExited(targetId)).toBe(false);
  });

  it("rejects focusTarget with a typed station-hosted error (never a crash)", async () => {
    const provider = new StationTerminalProvider({ clock });
    await provider.openWorkspace(openRequest());
    const targetId = stationTargetId(worktree.id);

    await expect(provider.focusTarget(targetId)).rejects.toBeInstanceOf(
      StationTerminalProviderError,
    );
    await expect(provider.focusTarget(targetId)).rejects.toMatchObject({
      tag: "TerminalProviderError",
      code: "TERMINAL_STATION_HOSTED",
      provider: "native",
      worktreeId: "wt_web_feature",
      sessionId: "ses_web_feature",
    });
  });

  it("rejects closeTarget with a typed station-hosted error", async () => {
    const provider = new StationTerminalProvider({ clock });
    await provider.openWorkspace(openRequest());

    await expect(provider.closeTarget(stationTargetId(worktree.id))).rejects.toMatchObject({
      tag: "TerminalProviderError",
      code: "TERMINAL_STATION_HOSTED",
    });
  });
});

function fakeHostClient(overrides: Partial<StationHostClient> = {}): StationHostClient {
  return {
    health: async () => ({ ok: true, protocolVersion: 1 }),
    spawn: async () => ({ ptyId: "pty-1", pid: 99 }),
    write: async () => undefined,
    resize: async () => undefined,
    list: async () => [],
    focus: async () => undefined,
    close: async () => ({ closed: true }),
    attach: async () => {
      throw new Error("unused");
    },
    dispose: () => undefined,
    ...overrides,
  };
}

function liveEntry(overrides: Partial<HostListEntry> = {}): HostListEntry {
  return {
    kind: "agent",
    ptyId: "pty-1",
    terminalTargetId: stationTargetId(worktree.id),
    worktreeId: worktree.id,
    projectId: project.id,
    sessionId: "ses_web_feature",
    worktreePath: worktree.path,
    harnessProvider: "claude",
    pid: 99,
    alive: true,
    cols: 80,
    rows: 24,
    ...overrides,
  };
}

function hostBackedProvider(client: StationHostClient) {
  const controller = createStationHostController(
    {
      socketPath: `/tmp/station-host-${process.pid}-${Math.random().toString(36).slice(2)}.sock`,
      stateDir: "/tmp",
      hostEntry: "/tmp/hostMain.ts",
    },
    { clientFactory: () => client, spawnHost: () => ({ pid: 1, unref: () => undefined }) },
  );
  return new StationTerminalProvider({ clock, host: controller });
}

const launchPlan = {
  provider: "claude" as const,
  command: "claude",
  args: [] as string[],
  mode: "interactive" as const,
};

describe("StationTerminalProvider (host-backed)", () => {
  it("flips focus/close capabilities on when a host is injected", () => {
    const provider = hostBackedProvider(fakeHostClient());
    expect(provider.capabilities()).toMatchObject({ canFocusTarget: true, canCloseTarget: true });
  });

  it("launchProcess spawns into the host and reports started", async () => {
    const spawn = vi.fn(async () => ({ ptyId: "pty-1", pid: 99 }));
    const provider = hostBackedProvider(fakeHostClient({ spawn }));
    const opened = await provider.openWorkspace(openRequest());
    const result = await provider.launchProcess({
      project,
      worktree,
      terminalTarget: opened.target,
      agentEndpointId: opened.agentEndpointId,
      launchPlan,
    });
    expect(result.started).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({
      terminalTargetId: stationTargetId(worktree.id),
      worktreePath: worktree.path,
      harnessProvider: "claude",
      sessionId: "ses_web_feature",
    });
  });

  it("never rebuilds an aux PTY into a terminal target (Station-UI-owned)", async () => {
    // A live aux shell + a live agent share host.list; only the agent surfaces.
    const provider = hostBackedProvider(
      fakeHostClient({
        list: async () => [
          liveEntry({ kind: "aux", terminalTargetId: "aux:wt_web_feature:0", ptyId: "pty-aux" }),
          liveEntry(),
        ],
      }),
    );
    const targets = await provider.listTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0]?.id).toBe(stationTargetId(worktree.id));
    expect(targets.some((target) => target.id === "aux:wt_web_feature:0")).toBe(false);
  });

  it("ignores dead host entries when rebuilding targets", async () => {
    const provider = hostBackedProvider(
      fakeHostClient({ list: async () => [liveEntry({ alive: false })] }),
    );
    await expect(provider.listTargets()).resolves.toEqual([]);
  });

  it("marks UI-hosted fallback targets non-focusable until a host PTY is live", async () => {
    let live: HostListEntry[] = [];
    const provider = hostBackedProvider(fakeHostClient({ list: async () => live }));
    await provider.openWorkspace(openRequest());

    await expect(provider.listTargets()).resolves.toMatchObject([
      { id: stationTargetId(worktree.id), focusable: false, closeable: false },
    ]);

    live = [liveEntry()];
    await expect(provider.listTargets()).resolves.toMatchObject([
      { id: stationTargetId(worktree.id), focusable: true, closeable: true },
    ]);
  });

  it("surfaces multiple live host-backed agent targets independently", async () => {
    const provider = hostBackedProvider(
      fakeHostClient({
        list: async () => [
          liveEntry(),
          liveEntry({
            ptyId: "pty-2",
            terminalTargetId: stationTargetId("wt_web_other"),
            worktreeId: "wt_web_other",
            sessionId: "ses_web_other",
            worktreePath: "/tmp/station/web/other",
            pid: 100,
          }),
        ],
      }),
    );

    const targets = await provider.listTargets();
    expect(targets.map((target) => target.id).sort()).toEqual([
      stationTargetId(worktree.id),
      stationTargetId("wt_web_other"),
    ]);
    expect(targets.find((target) => target.id === stationTargetId("wt_web_other"))).toMatchObject({
      provider: "native",
      state: "open",
      worktreeId: "wt_web_other",
      sessionId: "ses_web_other",
      cwd: "/tmp/station/web/other",
    });
  });

  it("dedupes duplicate host entries for the same target to the first live PTY", async () => {
    const provider = hostBackedProvider(
      fakeHostClient({
        list: async () => [
          liveEntry({ ptyId: "pty-first", sessionId: "ses_first", pid: 101 }),
          liveEntry({ ptyId: "pty-second", sessionId: "ses_second", pid: 102 }),
        ],
      }),
    );

    const targets = await provider.listTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0]?.sessionId).toBe("ses_first");
    await expect(provider.reattachInfo?.(stationTargetId(worktree.id))).resolves.toMatchObject({
      endpointId: "pty-first",
    });
  });

  it("rebuilds a lost target from host.list after a restart (cwd === harnessBinding.worktreePath)", async () => {
    // #targets is empty (observer-restart proxy); host.list is the liveness truth.
    const provider = hostBackedProvider(fakeHostClient({ list: async () => [liveEntry()] }));
    const targets = await provider.listTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      id: stationTargetId(worktree.id),
      provider: "native",
      state: "open",
      focusable: true,
      closeable: true,
      worktreeId: worktree.id,
      sessionId: "ses_web_feature",
      cwd: worktree.path,
      harnessBinding: {
        role: "main-agent",
        harnessProvider: "claude",
        worktreePath: worktree.path,
      },
    });
    // The BLOCKER guard: cwd and harnessBinding.worktreePath must match.
    expect(targets[0]?.cwd).toBe(targets[0]?.harnessBinding?.worktreePath);
  });

  it("drops a host-backed target once its PTY is no longer live", async () => {
    let live = [liveEntry()];
    const provider = hostBackedProvider(fakeHostClient({ list: async () => live }));
    const opened = await provider.openWorkspace(openRequest());
    await provider.launchProcess({
      project,
      worktree,
      terminalTarget: opened.target,
      agentEndpointId: opened.agentEndpointId,
      launchPlan,
    }); // marks the target host-backed
    expect(await provider.listTargets()).toHaveLength(1);
    live = []; // the host PTY died
    await expect(provider.listTargets()).resolves.toEqual([]);
  });

  it("keeps a UI-hosted (non-host-backed) target even when host.list is empty", async () => {
    // The host was unavailable at launch so the PTY is UI-hosted; listTargets must
    // not drop it just because host.list has no PTY for it.
    const provider = hostBackedProvider(fakeHostClient({ list: async () => [] }));
    await provider.openWorkspace(openRequest());
    await expect(provider.listTargets()).resolves.toHaveLength(1);
  });

  it("dedupes to one target when host.list and #targets both have the worktree", async () => {
    const provider = hostBackedProvider(fakeHostClient({ list: async () => [liveEntry()] }));
    await provider.openWorkspace(openRequest());
    await expect(provider.listTargets()).resolves.toHaveLength(1);
  });

  it("reattachInfo returns the live host PTY endpoint and socket", async () => {
    const provider = hostBackedProvider(fakeHostClient({ list: async () => [liveEntry()] }));
    const info = await provider.reattachInfo?.(stationTargetId(worktree.id));
    expect(info).toMatchObject({ endpointId: "pty-1" });
    expect(info?.socketPath).toContain("station-host-");
  });

  it("focus/close resolve the host PTY id and drive the host", async () => {
    const focus = vi.fn(async () => undefined);
    const close = vi.fn(async () => ({ closed: true }));
    const provider = hostBackedProvider(
      fakeHostClient({ list: async () => [liveEntry()], focus, close }),
    );
    await provider.focusTarget(stationTargetId(worktree.id));
    await provider.closeTarget(stationTargetId(worktree.id));
    expect(focus).toHaveBeenCalledWith("pty-1");
    expect(close).toHaveBeenCalledWith("pty-1");
  });

  it("doctorChecks reports ok with the live agent count when the host is reachable", async () => {
    const provider = hostBackedProvider(fakeHostClient({ list: async () => [liveEntry()] }));
    const checks = await provider.doctorChecks?.();
    expect(checks).toMatchObject([{ name: "station-host", status: "ok" }]);
    expect(checks?.[0]?.message).toContain("1 agent");
  });

  it("doctorChecks warns (not errors) when the host is unreachable", async () => {
    const provider = hostBackedProvider(
      fakeHostClient({
        list: async () => {
          throw new Error("down");
        },
      }),
    );
    const checks = await provider.doctorChecks?.();
    expect(checks).toMatchObject([{ name: "station-host", status: "warn" }]);
    expect(checks?.[0]?.error?.code).toBe("HOST_UNREACHABLE");
  });

  it("doctorChecks is empty without a host injected", async () => {
    const provider = new StationTerminalProvider({ clock });
    await expect(provider.doctorChecks?.()).resolves.toEqual([]);
  });
});
