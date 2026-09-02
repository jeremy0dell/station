import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type {
  ManagedOpenWorkspaceResult,
  OpenPlacedWorkspaceRequest,
  ProviderProjectConfig,
  WorktreeObservation,
} from "@station/contracts";
import type { ProcessEvidence } from "@station/runtime";
import { nativePlacementSocketPath, startNativePlacementProtocolServer } from "@station/terminal";
import { describe, expect, it, vi } from "vitest";
import { NativePlacementAuthorityStore } from "../../src/placement/authority.js";
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
    const stateDir = await mkdtemp(join(tmpdir(), "station-placement-service-"));
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
                  viewport: { cols: 80, rows: 24 },
                  terminalTargetId: "native:source",
                  sessionId: "session-source",
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
    expect(() => new NativePlacementAuthorityStore({ capacity: 0 })).toThrow(/positive integer/u);
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
});
