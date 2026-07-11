import type {
  OpenWorkspaceRequest,
  ProviderProjectConfig,
  WorktreeObservation,
} from "@station/contracts";
import {
  HOST_PROTOCOL_VERSION,
  type HostListEntry,
  type StationHostClient,
  StationHostProviderError,
  stationHostSafeError,
} from "@station/host";
import type { RuntimeClock } from "@station/runtime";
import { describe, expect, it, vi } from "vitest";
import { StationTerminalProviderError } from "../../src/errors";
import {
  createStationHostController,
  type StationHostController,
} from "../../src/host/hostController";
import { StationTerminalProvider, stationTargetId } from "../../src/provider";

const now = "2026-05-21T12:00:00.000Z";
const expectedBuildVersion = "test-build";
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
    await expect(provider.attachmentForTarget("native:web-feature")).resolves.toBeUndefined();
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

  it("releaseTarget drops the target so reconcile stops observing it", async () => {
    const provider = new StationTerminalProvider({ clock });
    await provider.openWorkspace(openRequest());
    const targetId = stationTargetId(worktree.id);

    await expect(provider.releaseTarget(targetId)).resolves.toBe(true);
    await expect(provider.listTargets()).resolves.toEqual([]);
    // Idempotent: a second exit report for the same target is a no-op.
    await expect(provider.releaseTarget(targetId)).resolves.toBe(false);
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
    health: async () => ({
      ok: true,
      protocolVersion: HOST_PROTOCOL_VERSION,
      buildVersion: expectedBuildVersion,
    }),
    stopIfIdle: async () => ({ stopping: true }),
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
      hostCommand: ["bun", "/tmp/hostMain.ts"],
      expectedBuildVersion,
    },
    { clientFactory: () => client, spawnHost: () => ({ pid: 1, unref: () => undefined }) },
  );
  return new StationTerminalProvider({ clock, host: controller });
}

function providerWithEnsureError(
  client: StationHostClient,
  error: ReturnType<typeof stationHostSafeError>,
): StationTerminalProvider {
  const host: StationHostController = {
    socketPath: "/tmp/station-host-test.sock",
    client: () => client,
    ensure: async () => ({
      status: "unavailable",
      socketPath: "/tmp/station-host-test.sock",
      error,
    }),
  };
  return new StationTerminalProvider({ clock, host });
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
    expect(result).toEqual({
      terminalTargetId: stationTargetId(worktree.id),
      agentEndpointId: stationTargetId(worktree.id),
      started: true,
      attachment: {
        kind: "managed-terminal",
        terminalTargetId: stationTargetId(worktree.id),
      },
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({
      terminalTargetId: stationTargetId(worktree.id),
      worktreePath: worktree.path,
      harnessProvider: "claude",
      sessionId: "ses_web_feature",
    });
  });

  it("keeps generic host unreachability as a UI-hosted launch fallback", async () => {
    const provider = providerWithEnsureError(
      fakeHostClient(),
      stationHostSafeError("HOST_UNREACHABLE", "Station host is unavailable."),
    );
    const opened = await provider.openWorkspace(openRequest());

    await expect(
      provider.launchProcess({
        project,
        worktree,
        terminalTarget: opened.target,
        agentEndpointId: opened.agentEndpointId,
        launchPlan,
      }),
    ).resolves.toMatchObject({ started: false });
  });

  it("propagates a live-PTY upgrade block instead of falling back to a local spawn", async () => {
    const upgradeError = stationHostSafeError(
      "HOST_UPGRADE_BLOCKED",
      "Host build older-build owns 2 live terminals; requested build is test-build.",
      { hint: "Reopen with older-build and finish those terminals." },
    );
    const provider = providerWithEnsureError(fakeHostClient(), upgradeError);
    const opened = await provider.openWorkspace(openRequest());

    await expect(
      provider.launchProcess({
        project,
        worktree,
        terminalTarget: opened.target,
        agentEndpointId: opened.agentEndpointId,
        launchPlan,
      }),
    ).rejects.toMatchObject({
      code: "HOST_UPGRADE_BLOCKED",
      message: upgradeError.message,
      hint: upgradeError.hint,
    });
    await expect(provider.listTargets()).resolves.toEqual([]);
  });

  it("releases the registered target when host spawn fails", async () => {
    const spawnError = new StationHostProviderError(
      "HOST_SPAWN_FAILED",
      "The controlling-terminal helper is unavailable.",
    );
    const provider = hostBackedProvider(
      fakeHostClient({
        spawn: async () => {
          throw spawnError;
        },
      }),
    );
    const opened = await provider.openWorkspace(openRequest());

    await expect(
      provider.launchProcess({
        project,
        worktree,
        terminalTarget: opened.target,
        agentEndpointId: opened.agentEndpointId,
        launchPlan,
      }),
    ).rejects.toBe(spawnError);
    await expect(provider.listTargets()).resolves.toEqual([]);
  });

  it("releaseTarget forgets host-backed bookkeeping without closing the process", async () => {
    const close = vi.fn(async () => ({ closed: true }));
    const provider = hostBackedProvider(fakeHostClient({ close }));
    const opened = await provider.openWorkspace(openRequest());
    await provider.launchProcess({
      project,
      worktree,
      terminalTarget: opened.target,
      agentEndpointId: opened.agentEndpointId,
      launchPlan,
    });

    await expect(provider.releaseTarget(opened.target.targetId)).resolves.toBe(true);
    expect(close).not.toHaveBeenCalled();
    await expect(provider.listTargets()).resolves.toEqual([]);

    await provider.openWorkspace(openRequest({ sessionId: "ses_ui_fallback" }));
    await expect(provider.listTargets()).resolves.toMatchObject([
      { id: opened.target.targetId, sessionId: "ses_ui_fallback" },
    ]);
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

  it("preserves UI-hosted state when a generic host list request is unreachable", async () => {
    const provider = hostBackedProvider(
      fakeHostClient({
        list: async () => {
          throw new Error("host down");
        },
      }),
    );
    const opened = await provider.openWorkspace(openRequest());

    await expect(provider.listTargets()).resolves.toMatchObject([
      { id: opened.target.targetId, focusable: false, closeable: false },
    ]);
    await expect(provider.attachmentForTarget(opened.target.targetId)).resolves.toBeUndefined();
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
    await expect(provider.attachmentForTarget(stationTargetId(worktree.id))).resolves.toEqual({
      kind: "managed-terminal",
      terminalTargetId: stationTargetId(worktree.id),
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

  it("attachmentForTarget returns only opaque target identity for a live host entry", async () => {
    const provider = hostBackedProvider(fakeHostClient({ list: async () => [liveEntry()] }));
    await expect(provider.attachmentForTarget(stationTargetId(worktree.id))).resolves.toEqual({
      kind: "managed-terminal",
      terminalTargetId: stationTargetId(worktree.id),
    });
  });

  it("attachmentForTarget ignores an alive aux entry with the target id", async () => {
    const provider = hostBackedProvider(
      fakeHostClient({ list: async () => [liveEntry({ kind: "aux" })] }),
    );
    await expect(
      provider.attachmentForTarget(stationTargetId(worktree.id)),
    ).resolves.toBeUndefined();
  });

  it("attachmentForTarget omits missing and dead host targets", async () => {
    const provider = hostBackedProvider(
      fakeHostClient({ list: async () => [liveEntry({ alive: false })] }),
    );
    await expect(
      provider.attachmentForTarget(stationTargetId(worktree.id)),
    ).resolves.toBeUndefined();
    await expect(
      provider.attachmentForTarget(stationTargetId("wt_missing")),
    ).resolves.toBeUndefined();
  });

  it("propagates compatibility failures from listing and attachment resolution", async () => {
    const compatibilityError = stationHostSafeError(
      "HOST_VERSION_INCOMPATIBLE",
      "Station host build older-build is incompatible with requested build test-build.",
    );
    const provider = hostBackedProvider(
      fakeHostClient({
        list: async () => {
          throw compatibilityError;
        },
      }),
    );

    await expect(provider.listTargets()).rejects.toMatchObject({
      code: "HOST_VERSION_INCOMPATIBLE",
    });
    await expect(provider.attachmentForTarget(stationTargetId(worktree.id))).rejects.toMatchObject({
      code: "HOST_VERSION_INCOMPATIBLE",
    });
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

  it("doctorChecks retains the actionable host compatibility failure", async () => {
    const compatibilityError = stationHostSafeError(
      "HOST_UPGRADE_BLOCKED",
      "Host build older-build owns 1 live terminal; requested build is test-build.",
      { hint: "Reopen with older-build and finish that terminal." },
    );
    const provider = hostBackedProvider(
      fakeHostClient({
        list: async () => {
          throw compatibilityError;
        },
      }),
    );

    const checks = await provider.doctorChecks?.();
    expect(checks).toMatchObject([
      {
        name: "station-host",
        status: "warn",
        error: {
          code: "HOST_UPGRADE_BLOCKED",
          message: compatibilityError.message,
          hint: compatibilityError.hint,
        },
      },
    ]);
    expect(checks?.[0]?.message).toContain(compatibilityError.message);
  });

  it("doctorChecks is empty without a host injected", async () => {
    const provider = new StationTerminalProvider({ clock });
    await expect(provider.doctorChecks?.()).resolves.toEqual([]);
  });
});
