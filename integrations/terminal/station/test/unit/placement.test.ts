import { mkdtemp, rm } from "node:fs/promises";
import { basename } from "node:path";
import type {
  ManagedOpenWorkspaceResult,
  OpenPlacedWorkspaceRequest,
  ProviderProjectConfig,
  StationHostExactEvidence,
  WorktreeObservation,
} from "@station/contracts";
import { HOST_PROTOCOL_VERSION } from "@station/contracts";
import { OneShotAuthorityStore, type ProcessEvidence } from "@station/runtime";
import {
  nativePlacementSocketPath,
  requestNativePlacement,
  startNativePlacementProtocolServer,
} from "@station/terminal";
import { describe, expect, it, vi } from "vitest";
import { captureNativeCallerClaims } from "../../src/placement/claims.js";
import { StationPlacementService } from "../../src/placement/service.js";

const project: ProviderProjectConfig = {
  id: "web",
  label: "web",
  root: "/repo/web",
  defaults: { harness: "codex", terminal: "native", layout: "agent-only" },
  worktrunk: { enabled: true, base: "main" },
};
const worktree: WorktreeObservation = {
  id: "wt-feature",
  provider: "worktrunk",
  projectId: "web",
  branch: "feature",
  path: "/repo/web/feature",
  state: "exists",
  source: "worktrunk",
  observedAt: "2026-09-01T12:00:00.000Z",
};

describe("StationPlacementService", () => {
  it("keeps the representative native socket path within Darwin's limit", () => {
    const socketPath = nativePlacementSocketPath(
      "/Users/station-user/.local/state/station",
      "ui_11111111-1111-4111-8111-111111111111",
    );

    expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(103);
    expect(basename(socketPath)).toMatch(/^[a-f0-9]{24}\.sock$/u);
    expect(socketPath).not.toContain("ui_11111111");
  });

  it("proves one native caller, reserves once, and rejects stale renderer generation", async () => {
    const stateDir = await mkdtemp("/tmp/stn-placement-");
    const socketPath = nativePlacementSocketPath(stateDir, "ui-1");
    let handlerGeneration = "renderer-1";
    let holderEvidenceFails = false;
    const requests: string[] = [];
    const server = await startNativePlacementProtocolServer({
      socketPath,
      handle: async (request) => {
        requests.push(request.type);
        if (request.type === "snapshot") {
          return {
            type: "snapshot",
            snapshot: {
              uiRunId: "ui-1",
              handlerGeneration,
              rendererPid: 10,
              panes: [
                {
                  paneId: "pane-main",
                  entryGeneration: "entry-1",
                  terminalPid: 20,
                  terminalTargetId: "native:source",
                },
              ],
            },
          };
        }
        if (request.type === "reserve") {
          return { type: "reserved", paneId: "pane-agent-wt-wt-feature" };
        }
        if (request.type === "commit") {
          return {
            type: "committed",
            paneId: "pane-agent-wt-wt-feature",
            entryGeneration: "entry-destination",
            terminalPid: 40,
          };
        }
        if (request.type === "finalize") {
          return { type: "finalized", status: "finalized" };
        }
        return { type: "released", status: "released" };
      },
    });
    const opened: ManagedOpenWorkspaceResult = {
      target: {
        provider: "native",
        targetId: "native:wt-feature",
        projectId: "web",
        worktreeId: "wt-feature",
        sessionId: "session-feature",
      },
      agentEndpointId: "native:wt-feature",
      bindingToken: "binding-1",
    };
    const owner = {
      openManagedWorkspace: vi.fn(async () => opened),
      releaseTarget: vi.fn(async () => true),
    };
    const processEvidence: ProcessEvidence = {
      read: (pid) =>
        new Map([
          [10, { pid: 10, parentPid: 1, startToken: "renderer" }],
          [20, { pid: 20, parentPid: 1, startToken: "terminal" }],
          [30, { pid: 30, parentPid: 20, startToken: "caller" }],
        ]).get(pid),
    };
    const service = new StationPlacementService({
      stateDir,
      owner,
      processEvidence,
      socketHolders: async () => {
        if (holderEvidenceFails) throw new Error("lsof overloaded");
        return [10];
      },
    });
    try {
      const caller = {
        process: { pid: 30, startToken: "caller" },
        claims: { STATION_PANE: "1" },
      };
      const source = await service.resolveCurrentPlacement(caller);
      expect(source).toMatchObject({ provider: "native", targetId: "native:source" });
      if (source === undefined) throw new Error("expected source");
      await expect(
        service.validatePlacement({ intent: "sibling", source }),
      ).resolves.toBeUndefined();

      const request: OpenPlacedWorkspaceRequest = {
        project,
        worktree,
        harness: "codex",
        layout: "agent-only",
        sessionId: "session-feature",
        placement: { intent: "sibling", source },
      };
      const placed = await service.openPlacedWorkspace(request);
      expect(placed).toMatchObject({
        bindingToken: "binding-1",
        placement: { provider: "native", intent: "sibling", presentation: "presented" },
      });
      await expect(service.openPlacedWorkspace(request)).rejects.toMatchObject({
        code: "TERMINAL_PLACEMENT_REJECTED",
      });
      expect(requests).toContain("reserve");

      await expect(
        service.commitPlacedProcess({
          project,
          worktree,
          terminalTarget: opened.target,
          agentEndpointId: opened.agentEndpointId,
          bindingToken: opened.bindingToken,
          launchPlan: {
            provider: "codex",
            command: "codex",
            args: [],
            mode: "interactive",
          },
        }),
      ).resolves.toBe(true);
      expect(service.hasPendingBinding(opened.bindingToken)).toBe(true);
      await expect(
        service.releasePlacedTarget({
          targetId: opened.target.targetId,
          sessionId: "session-replaced",
          generation: placed.placement.generation,
          bindingToken: opened.bindingToken,
        }),
      ).rejects.toMatchObject({ code: "TERMINAL_CLEANUP_UNCERTAIN" });
      expect(owner.releaseTarget).not.toHaveBeenCalled();
      expect(service.hasPendingBinding(opened.bindingToken)).toBe(true);
      await expect(
        service.releasePlacedTarget({
          targetId: opened.target.targetId,
          sessionId: "session-feature",
          generation: placed.placement.generation,
          bindingToken: opened.bindingToken,
        }),
      ).resolves.toEqual({ status: "released" });
      expect(service.hasPendingBinding(opened.bindingToken)).toBe(false);
      expect(requests).toContain("commit");
      expect(requests).toContain("release");
      expect(owner.releaseTarget).toHaveBeenCalledWith({
        targetId: opened.target.targetId,
        expectedSessionId: "session-feature",
        expectedBindingToken: opened.bindingToken,
      });

      const finalSource = await service.resolveCurrentPlacement(caller);
      if (finalSource === undefined) throw new Error("expected final source");
      const finalized = await service.openPlacedWorkspace({
        ...request,
        placement: { intent: "sibling", source: finalSource },
      });
      await service.commitPlacedProcess({
        project,
        worktree,
        terminalTarget: opened.target,
        agentEndpointId: opened.agentEndpointId,
        bindingToken: opened.bindingToken,
        launchPlan: {
          provider: "codex",
          command: "codex",
          args: [],
          mode: "interactive",
        },
      });
      await expect(
        service.finalizePlacedTarget({
          targetId: opened.target.targetId,
          sessionId: "session-feature",
          generation: finalized.placement.generation,
          bindingToken: opened.bindingToken,
        }),
      ).resolves.toBeUndefined();
      expect(service.hasPendingBinding(opened.bindingToken)).toBe(false);
      expect(requests).toContain("finalize");

      const fresh = await service.resolveCurrentPlacement(caller);
      if (fresh === undefined) throw new Error("expected fresh source");
      handlerGeneration = "renderer-2";
      await expect(
        service.validatePlacement({ intent: "sibling", source: fresh }),
      ).rejects.toMatchObject({
        code: "TERMINAL_PLACEMENT_REJECTED",
      });

      handlerGeneration = "renderer-1";
      const unavailable = await service.resolveCurrentPlacement(caller);
      if (unavailable === undefined) throw new Error("expected current source");
      holderEvidenceFails = true;
      await expect(
        service.validatePlacement({ intent: "sibling", source: unavailable }),
      ).rejects.toMatchObject({
        code: "TERMINAL_PLACEMENT_EVIDENCE_UNAVAILABLE",
      });
    } finally {
      await server.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("captures only the native marker and bounds one-shot authority storage", () => {
    expect(captureNativeCallerClaims({ STATION_PANE: "1", TMUX: "ignored" })).toEqual({
      STATION_PANE: "1",
    });
    expect(captureNativeCallerClaims({})).toEqual({});
    expect(() => new OneShotAuthorityStore({ capacity: 0 })).toThrow(/positive integer/u);
    expect(
      () =>
        new StationPlacementService({
          stateDir: "/tmp/station-placement",
          owner: {
            openManagedWorkspace: async () => {
              throw new Error("unused");
            },
            releaseTarget: async () => true,
          },
          pendingCapacity: 0,
        }),
    ).toThrow(/positive integer/u);
  });

  it("retains cleanup uncertainty when an unconfirmed reserve cannot be rolled back", async () => {
    const stateDir = await mkdtemp("/tmp/stn-placement-");
    const socketPath = nativePlacementSocketPath(stateDir, "ui-reserve-loss");
    let reserved = false;
    const server = await startNativePlacementProtocolServer({
      socketPath,
      handle: async (request) => {
        if (request.type === "snapshot") {
          return nativeSnapshot({ uiRunId: "ui-reserve-loss", rendererPid: 10 });
        }
        if (request.type === "reserve") {
          reserved = true;
          return { type: "reserved", paneId: "pane-agent-wt-wt-feature" };
        }
        if (request.type === "release") {
          reserved = false;
          return { type: "released", status: "released" };
        }
        throw new Error("unexpected placement request");
      },
    });
    const opened: ManagedOpenWorkspaceResult = {
      target: {
        provider: "native",
        targetId: "native:wt-feature",
        projectId: "web",
        worktreeId: "wt-feature",
        sessionId: "session-feature",
      },
      agentEndpointId: "native:wt-feature",
      bindingToken: "binding-reserve-loss",
    };
    const owner = {
      openManagedWorkspace: vi.fn(async () => opened),
      releaseTarget: vi.fn(async () => true),
    };
    const request: typeof requestNativePlacement = async (path, message, timeoutMs) => {
      if (message.type === "release") throw new Error("renderer became unreachable");
      const value = await requestNativePlacement(path, message, timeoutMs);
      if (message.type === "reserve") {
        throw {
          tag: "TerminalProviderError",
          code: "TERMINAL_PLACEMENT_REJECTED",
          message: "Native placement request failed after reservation.",
          provider: "native",
        };
      }
      return value;
    };
    const service = new StationPlacementService({
      stateDir,
      owner,
      request,
      processEvidence: nativeProcessEvidence(),
      socketHolders: async () => [10],
    });
    try {
      const source = await service.resolveCurrentPlacement(nativeCaller());
      if (source === undefined) throw new Error("expected native source");

      await expect(
        service.openPlacedWorkspace({
          project,
          worktree,
          harness: "codex",
          layout: "agent-only",
          sessionId: "session-feature",
          placement: { intent: "sibling", source },
        }),
      ).rejects.toMatchObject({ code: "TERMINAL_CLEANUP_UNCERTAIN" });
      expect(reserved).toBe(true);
      expect(owner.releaseTarget).toHaveBeenCalledWith({
        targetId: opened.target.targetId,
        expectedSessionId: "session-feature",
        expectedBindingToken: opened.bindingToken,
      });
    } finally {
      await server.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("skips an abandoned no-holder socket before requesting a live renderer", async () => {
    const stateDir = await mkdtemp("/tmp/stn-placement-");
    const stalePath = nativePlacementSocketPath(stateDir, "ui-stale");
    const livePath = nativePlacementSocketPath(stateDir, "ui-live");
    const stale = await startNativePlacementProtocolServer({
      socketPath: stalePath,
      handle: async () => {
        throw new Error("abandoned endpoint must not be requested");
      },
    });
    const live = await startNativePlacementProtocolServer({
      socketPath: livePath,
      handle: async (request) => {
        if (request.type !== "snapshot") throw new Error("unexpected request");
        return nativeSnapshot({ uiRunId: "ui-live", rendererPid: 10 });
      },
    });
    const request = vi.fn(async (...args: Parameters<typeof requestNativePlacement>) =>
      requestNativePlacement(...args),
    );
    const service = placementService({
      stateDir,
      request,
      socketHolders: async (socketPath) => (socketPath === stalePath ? [] : [10]),
    });
    try {
      await expect(service.resolveCurrentPlacement(nativeCaller())).resolves.toMatchObject({
        provider: "native",
        targetId: "native:source",
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0]?.[0]).toBe(livePath);
    } finally {
      await stale.close();
      await live.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("fails closed on live renderer request failure or ambiguous socket ownership", async () => {
    const stateDir = await mkdtemp("/tmp/stn-placement-");
    const socketPath = nativePlacementSocketPath(stateDir, "ui-live-failure");
    const server = await startNativePlacementProtocolServer({
      socketPath,
      handle: async () => nativeSnapshot({ uiRunId: "ui-live-failure", rendererPid: 10 }),
    });
    const failedRequest = vi.fn(async () => {
      throw new Error("renderer did not answer");
    });
    try {
      await expect(
        placementService({
          stateDir,
          request: failedRequest,
          socketHolders: async () => [10],
        }).resolveCurrentPlacement(nativeCaller()),
      ).rejects.toMatchObject({ code: "TERMINAL_PLACEMENT_EVIDENCE_UNAVAILABLE" });
      expect(failedRequest).toHaveBeenCalledTimes(1);

      const ambiguousRequest = vi.fn();
      await expect(
        placementService({
          stateDir,
          request: ambiguousRequest,
          socketHolders: async () => [10, 11],
        }).resolveCurrentPlacement(nativeCaller()),
      ).rejects.toMatchObject({ code: "TERMINAL_PLACEMENT_EVIDENCE_UNAVAILABLE" });
      expect(ambiguousRequest).not.toHaveBeenCalled();
    } finally {
      await server.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects more than one live renderer matching the caller", async () => {
    const stateDir = await mkdtemp("/tmp/stn-placement-");
    const firstPath = nativePlacementSocketPath(stateDir, "ui-first");
    const secondPath = nativePlacementSocketPath(stateDir, "ui-second");
    const first = await startNativePlacementProtocolServer({
      socketPath: firstPath,
      handle: async () => nativeSnapshot({ uiRunId: "ui-first", rendererPid: 10 }),
    });
    const second = await startNativePlacementProtocolServer({
      socketPath: secondPath,
      handle: async () => nativeSnapshot({ uiRunId: "ui-second", rendererPid: 11 }),
    });
    const processEvidence: ProcessEvidence = {
      read: (pid) =>
        new Map([
          [10, { pid: 10, parentPid: 1, startToken: "renderer-first" }],
          [11, { pid: 11, parentPid: 1, startToken: "renderer-second" }],
          [20, { pid: 20, parentPid: 1, startToken: "terminal" }],
          [30, { pid: 30, parentPid: 20, startToken: "caller" }],
        ]).get(pid),
    };
    try {
      await expect(
        placementService({
          stateDir,
          processEvidence,
          socketHolders: async (socketPath) => (socketPath === firstPath ? [10] : [11]),
        }).resolveCurrentPlacement(nativeCaller()),
      ).rejects.toMatchObject({ code: "TERMINAL_CALLER_CONTEXT_REJECTED" });
    } finally {
      await first.close();
      await second.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("binds authority to Host lifetime without freezing unrelated terminal inventory", async () => {
    const stateDir = await mkdtemp("/tmp/stn-placement-");
    const socketPath = nativePlacementSocketPath(stateDir, "ui-host");
    const hostTerminal = stationHostTerminal({ terminalTargetId: "native:source", pid: 20 });
    let hostEvidence = stationHostEvidence([hostTerminal]);
    const server = await startNativePlacementProtocolServer({
      socketPath,
      handle: async () =>
        nativeSnapshot({
          uiRunId: "ui-host",
          rendererPid: 10,
          hostPtyRef: hostPtyExpectation(hostTerminal),
        }),
    });
    const service = placementService({
      stateDir,
      hostSocketPath: hostEvidence.endpoint.socketPath,
      inspectHost: async () => ({ status: "exact", evidence: hostEvidence }),
      socketHolders: async () => [10],
    });
    try {
      const source = await service.resolveCurrentPlacement(nativeCaller());
      if (source === undefined) throw new Error("expected native source");
      hostEvidence = stationHostEvidence([
        hostTerminal,
        stationHostTerminal({ terminalTargetId: "native:unrelated", pid: 99 }),
      ]);
      await expect(
        service.validatePlacement({ intent: "sibling", source }),
      ).resolves.toBeUndefined();

      const changedSource = await service.resolveCurrentPlacement(nativeCaller());
      if (changedSource === undefined) throw new Error("expected native source");
      hostEvidence = { ...hostEvidence, buildIdentity: "b".repeat(64) };
      await expect(
        service.validatePlacement({ intent: "sibling", source: changedSource }),
      ).rejects.toMatchObject({ code: "TERMINAL_PLACEMENT_REJECTED" });

      hostEvidence = stationHostEvidence([]);
      await expect(service.resolveCurrentPlacement(nativeCaller())).rejects.toMatchObject({
        code: "TERMINAL_PLACEMENT_EVIDENCE_UNAVAILABLE",
      });
    } finally {
      await server.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rolls back the exact Host PTY, renderer pane, and owner binding after commit refusal", async () => {
    const stateDir = await mkdtemp("/tmp/stn-placement-");
    const socketPath = nativePlacementSocketPath(stateDir, "ui-host-rollback");
    const requests: string[] = [];
    const server = await startNativePlacementProtocolServer({
      socketPath,
      handle: async (request) => {
        requests.push(request.type);
        if (request.type === "snapshot") {
          return nativeSnapshot({ uiRunId: "ui-host-rollback", rendererPid: 10 });
        }
        if (request.type === "reserve") {
          return { type: "reserved", paneId: "pane-agent-wt-wt-feature" };
        }
        if (request.type === "commit") {
          return { type: "reserved", paneId: "unexpected" };
        }
        return { type: "released", status: "released" };
      },
    });
    const opened: ManagedOpenWorkspaceResult = {
      target: {
        provider: "native",
        targetId: "native:wt-feature",
        projectId: "web",
        worktreeId: "wt-feature",
        sessionId: "session-feature",
      },
      agentEndpointId: "native:wt-feature",
      bindingToken: "binding-host-rollback",
    };
    const owner = {
      openManagedWorkspace: vi.fn(async () => opened),
      releaseTarget: vi.fn(async () => true),
    };
    const destinationTerminal = stationHostTerminal({
      terminalTargetId: opened.target.targetId,
      pid: 42,
    });
    const destinationEvidence = stationHostEvidence([destinationTerminal]);
    const closeHostPty = vi.fn(async () => ({ status: "released" as const }));
    const service = new StationPlacementService({
      stateDir,
      owner,
      processEvidence: nativeProcessEvidence(),
      socketHolders: async () => [10],
      inspectHost: async () => ({ status: "exact", evidence: destinationEvidence }),
      closeHostPty,
    });
    try {
      const source = await service.resolveCurrentPlacement(nativeCaller());
      if (source === undefined) throw new Error("expected native source");
      const placed = await service.openPlacedWorkspace({
        project,
        worktree,
        harness: "codex",
        layout: "agent-only",
        sessionId: "session-feature",
        placement: { intent: "sibling", source },
      });
      const ptyRef = hostPtyExpectation(destinationTerminal);

      await expect(
        service.commitPlacedProcess(
          {
            project,
            worktree,
            terminalTarget: opened.target,
            agentEndpointId: opened.agentEndpointId,
            bindingToken: opened.bindingToken,
            launchPlan: {
              provider: "codex",
              command: "codex",
              args: [],
              mode: "interactive",
            },
          },
          {
            host: {
              socketPath: destinationEvidence.endpoint.socketPath,
              ptyRef,
              spawned: {
                terminalTargetId: ptyRef.terminalTargetId,
                ptyId: ptyRef.ptyId,
                ptyInstanceId: ptyRef.ptyInstanceId,
                pid: destinationTerminal.pid,
              },
            },
          },
        ),
      ).rejects.toMatchObject({ code: "TERMINAL_CLEANUP_UNCERTAIN" });
      expect(service.hasPendingBinding(opened.bindingToken)).toBe(true);

      await expect(
        service.releasePlacedTarget({
          targetId: opened.target.targetId,
          sessionId: "session-feature",
          generation: placed.placement.generation,
          bindingToken: opened.bindingToken,
        }),
      ).resolves.toEqual({ status: "released" });
      expect(closeHostPty).toHaveBeenCalledWith({
        expectedHost: destinationEvidence,
        expectedPty: destinationTerminal,
      });
      expect(owner.releaseTarget).toHaveBeenCalledWith({
        targetId: opened.target.targetId,
        expectedSessionId: "session-feature",
        expectedBindingToken: opened.bindingToken,
      });
      expect(requests).toEqual(["snapshot", "snapshot", "reserve", "commit", "release"]);
      expect(service.hasPendingBinding(opened.bindingToken)).toBe(false);
    } finally {
      await server.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("refuses pending cleanup overflow without consuming the next authority", async () => {
    const stateDir = await mkdtemp("/tmp/stn-placement-");
    const socketPath = nativePlacementSocketPath(stateDir, "ui-capacity");
    const server = await startNativePlacementProtocolServer({
      socketPath,
      handle: async (request) => {
        if (request.type === "snapshot") {
          return nativeSnapshot({ uiRunId: "ui-capacity", rendererPid: 10 });
        }
        if (request.type === "reserve") {
          return { type: "reserved", paneId: `pane-${request.bindingToken}` };
        }
        if (request.type === "release") return { type: "released", status: "released" };
        throw new Error("commit was not expected");
      },
    });
    let sequence = 0;
    const owner = {
      openManagedWorkspace: vi.fn(async (request: OpenPlacedWorkspaceRequest) => {
        sequence += 1;
        return {
          target: {
            provider: "native",
            targetId: `native:capacity-${sequence}`,
            projectId: request.project.id,
            worktreeId: request.worktree.id,
            sessionId: request.sessionId,
          },
          agentEndpointId: `native:capacity-${sequence}`,
          bindingToken: `binding-capacity-${sequence}`,
        } satisfies ManagedOpenWorkspaceResult;
      }),
      releaseTarget: vi.fn(async () => true),
    };
    const service = new StationPlacementService({
      stateDir,
      owner,
      processEvidence: nativeProcessEvidence(),
      socketHolders: async () => [10],
      pendingCapacity: 1,
    });
    const requestFor = (
      source: NonNullable<Awaited<ReturnType<typeof service.resolveCurrentPlacement>>>,
    ) =>
      ({
        project,
        worktree,
        harness: "codex",
        layout: "agent-only",
        sessionId: "session-feature",
        placement: { intent: "sibling" as const, source },
      }) satisfies OpenPlacedWorkspaceRequest;
    try {
      const firstSource = await service.resolveCurrentPlacement(nativeCaller());
      if (firstSource === undefined) throw new Error("expected first source");
      const first = await service.openPlacedWorkspace(requestFor(firstSource));
      const secondSource = await service.resolveCurrentPlacement(nativeCaller());
      if (secondSource === undefined) throw new Error("expected second source");

      await expect(service.openPlacedWorkspace(requestFor(secondSource))).rejects.toMatchObject({
        code: "TERMINAL_PLACEMENT_REJECTED",
      });
      expect(owner.openManagedWorkspace).toHaveBeenCalledTimes(1);

      await service.releasePlacedTarget({
        targetId: first.target.targetId,
        sessionId: "session-feature",
        generation: first.placement.generation,
        bindingToken: first.bindingToken,
      });
      await expect(service.openPlacedWorkspace(requestFor(secondSource))).resolves.toMatchObject({
        bindingToken: "binding-capacity-2",
      });
      expect(owner.openManagedWorkspace).toHaveBeenCalledTimes(2);
    } finally {
      await server.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

function placementService(
  options: Omit<ConstructorParameters<typeof StationPlacementService>[0], "owner">,
): StationPlacementService {
  return new StationPlacementService({
    processEvidence: nativeProcessEvidence(),
    ...options,
    owner: {
      openManagedWorkspace: async () => {
        throw new Error("workspace open was not expected");
      },
      releaseTarget: async () => true,
    },
  });
}

function nativeProcessEvidence(): ProcessEvidence {
  return {
    read: (pid) =>
      new Map([
        [10, { pid: 10, parentPid: 1, startToken: "renderer" }],
        [20, { pid: 20, parentPid: 1, startToken: "terminal" }],
        [30, { pid: 30, parentPid: 20, startToken: "caller" }],
      ]).get(pid),
  };
}

function nativeCaller() {
  return {
    process: { pid: 30, startToken: "caller" },
    claims: { STATION_PANE: "1" },
  };
}

function nativeSnapshot(options: {
  uiRunId: string;
  rendererPid: number;
  hostPtyRef?: ReturnType<typeof hostPtyExpectation>;
}) {
  return {
    type: "snapshot" as const,
    snapshot: {
      uiRunId: options.uiRunId,
      handlerGeneration: "renderer-generation",
      rendererPid: options.rendererPid,
      panes: [
        {
          paneId: "pane-main",
          entryGeneration: "entry-generation",
          terminalPid: 20,
          terminalTargetId: "native:source" as const,
          ...(options.hostPtyRef === undefined ? {} : { hostPtyRef: options.hostPtyRef }),
        },
      ],
    },
  };
}

function stationHostTerminal(options: { terminalTargetId: string; pid: number }) {
  return {
    kind: "agent" as const,
    terminalTargetId: options.terminalTargetId,
    ptyId: `pty-${options.pid}`,
    ptyInstanceId: `ptyi_${options.pid}`,
    worktreeId: `wt-${options.pid}`,
    projectId: "web",
    sessionId: `session-${options.pid}`,
    worktreePath: `/repo/wt-${options.pid}`,
    harnessProvider: "codex",
    pid: options.pid,
    alive: true,
    cols: 80,
    rows: 24,
    handoffSupport: { kind: "bridge-releasable" as const },
  };
}

function hostPtyExpectation(terminal: ReturnType<typeof stationHostTerminal>) {
  return {
    kind: terminal.kind,
    terminalTargetId: terminal.terminalTargetId,
    ptyId: terminal.ptyId,
    ptyInstanceId: terminal.ptyInstanceId,
    worktreeId: terminal.worktreeId,
    projectId: terminal.projectId,
    sessionId: terminal.sessionId,
    worktreePath: terminal.worktreePath,
    harnessProvider: terminal.harnessProvider,
  };
}

function stationHostEvidence(
  terminals: ReturnType<typeof stationHostTerminal>[],
): StationHostExactEvidence {
  return {
    endpoint: { socketPath: "/tmp/station-host.sock", ino: 11n, birthtimeNs: 12n },
    health: { ok: true, protocolVersion: HOST_PROTOCOL_VERSION, buildVersion: "test" },
    buildIdentity: "a".repeat(64),
    terminals,
  };
}
