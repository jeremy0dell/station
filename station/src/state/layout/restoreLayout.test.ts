import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLayoutSnapshot } from "./layoutSnapshot.js";
import { readLayoutSnapshotSync, writeLayoutSnapshotSync } from "./layoutPersistence.js";
import {
  applyRestoreSeeds,
  planLayoutRestoreColdShells,
  planLayoutRestoreWarm,
  type WarmRestoreDeps,
} from "./restoreLayout.js";
import type { HostListEntry } from "@station/host";
import type { StationTerminalProcess } from "../../terminal/types.js";
import { createStationStore } from "../store.js";
import type { StationLayoutSnapshot } from "./layoutSnapshot.js";
import type { WorkspaceSlice } from "../types.js";
import { buildPaneForest } from "../paneTree.js";
import { createPtyRegistry } from "../../terminal/registry/ptyRegistry.js";
import { createScriptedTerminal } from "../../terminal/testing/scriptedTerminal.js";

// agent pane "pane-agent-wt-42" with two shells split off it, plus a standalone
// shell rooted on its own — the realistic "3 working panes next to the agent".
function snapshotWithAgentAndShells(): StationLayoutSnapshot {
  const workspace: WorkspaceSlice = {
    panes: [
      { id: "pane-agent-wt-42", split: null, role: "primary-agent" },
      { id: "pane-split-0", split: { anchorPaneId: "pane-agent-wt-42", direction: "right" }, role: "shell" },
      { id: "pane-split-1", split: { anchorPaneId: "pane-split-0", direction: "below" }, role: "shell" },
      { id: "pane-wt-7", split: null, role: "shell" },
    ],
    activePaneId: "pane-split-1",
  };
  const cwd: Record<string, string> = {
    "pane-agent-wt-42": "/work/agent",
    "pane-split-0": "/work/agent/sub",
    "pane-split-1": "/work/agent/sub",
    "pane-wt-7": "/work/seven",
  };
  return buildLayoutSnapshot(workspace, (id) => cwd[id]);
}

describe("planLayoutRestoreColdShells", () => {
  it("drops primary-agent panes and re-roots their orphaned child shells", () => {
    const plan = planLayoutRestoreColdShells(snapshotWithAgentAndShells());

    expect(plan.workspace.panes.map((p) => p.id)).toEqual(["pane-split-0", "pane-split-1", "pane-wt-7"]);
    // pane-split-0 anchored to the dropped agent → re-rooted.
    expect(plan.workspace.panes[0]?.split).toBeNull();
    // pane-split-1 anchored to a surviving shell → keeps its split.
    expect(plan.workspace.panes[1]?.split).toEqual({ anchorPaneId: "pane-split-0", direction: "below" });
    // The whole thing still folds into a coherent forest (no dangling anchors).
    expect(buildPaneForest(plan.workspace.panes)).toHaveLength(2); // pane-split-0 tree + pane-wt-7
  });

  it("keeps the active pane when it survives, else falls back to the first", () => {
    expect(planLayoutRestoreColdShells(snapshotWithAgentAndShells()).workspace.activePaneId).toBe("pane-split-1");

    const agentActive: StationLayoutSnapshot = { ...snapshotWithAgentAndShells(), activePaneId: "pane-agent-wt-42" };
    expect(planLayoutRestoreColdShells(agentActive).workspace.activePaneId).toBe("pane-split-0");
  });

  it("carries each shell's saved cwd into the seeds, none for the dropped agent", () => {
    const plan = planLayoutRestoreColdShells(snapshotWithAgentAndShells());
    expect(plan.seeds).toEqual([
      { paneId: "pane-split-0", cwd: "/work/agent/sub" },
      { paneId: "pane-split-1", cwd: "/work/agent/sub" },
      { paneId: "pane-wt-7", cwd: "/work/seven" },
    ]);
  });

  it("drops shell panes whose saved cwd no longer exists", () => {
    const plan = planLayoutRestoreColdShells(snapshotWithAgentAndShells(), {
      cwdExists: (cwd) => cwd !== "/work/agent/sub",
    });

    expect(plan.workspace.panes.map((p) => p.id)).toEqual(["pane-wt-7"]);
    expect(plan.workspace.activePaneId).toBe("pane-wt-7");
    expect(plan.seeds).toEqual([{ paneId: "pane-wt-7", cwd: "/work/seven" }]);
  });

  it("yields an empty workspace when every pane was an agent", () => {
    const onlyAgents: StationLayoutSnapshot = buildLayoutSnapshot(
      {
        panes: [{ id: "pane-agent-wt-1", split: null, role: "primary-agent" }],
        activePaneId: "pane-agent-wt-1",
      },
      () => "/x",
    );
    const plan = planLayoutRestoreColdShells(onlyAgents);
    expect(plan.workspace.panes).toHaveLength(0);
  });
});

// --- warm-reattach planner ------------------------------------------------

function hostEntry(overrides: Partial<HostListEntry>): HostListEntry {
  return {
    kind: "agent",
    ptyId: "pty-x",
    terminalTargetId: "native:wt-42",
    worktreeId: "wt-42",
    projectId: "proj-1",
    sessionId: "ses-1",
    worktreePath: "/work/agent",
    harnessProvider: "claude",
    pid: 1,
    alive: true,
    cols: 80,
    rows: 24,
    ...overrides,
  };
}

// A snapshot with an agent (host target native:wt-42) + a host-attached aux shell
// (aux:pane-split-0) + a plain local shell (no target).
function warmSnapshot(): StationLayoutSnapshot {
  const workspace: WorkspaceSlice = {
    panes: [
      { id: "pane-agent-wt-42", split: null, role: "primary-agent" },
      { id: "pane-split-0", split: { anchorPaneId: "pane-agent-wt-42", direction: "right" }, role: "shell" },
      { id: "pane-wt-7", split: null, role: "shell" },
    ],
    activePaneId: "pane-agent-wt-42",
  };
  const cwd: Record<string, string> = {
    "pane-agent-wt-42": "/work/agent",
    "pane-split-0": "/work/agent",
    "pane-wt-7": "/work/seven",
  };
  const target: Record<string, string> = {
    "pane-agent-wt-42": "native:wt-42",
    "pane-split-0": "aux:pane-split-0",
  };
  return buildLayoutSnapshot(workspace, (id) => cwd[id], (id) => target[id]);
}

function warmDeps(entries: HostListEntry[]): WarmRestoreDeps & { overrides: string[] } {
  const overrides: string[] = [];
  return {
    overrides,
    liveByTarget: new Map(entries.map((e) => [e.terminalTargetId, e])),
    makeHostTerminal: (entry) => {
      overrides.push(entry.terminalTargetId);
      return () => ({ id: `host:${entry.ptyId}` }) as unknown as StationTerminalProcess;
    },
  };
}

describe("planLayoutRestoreWarm", () => {
  it("warm-reattaches a live agent + live aux, recording the agent identity", () => {
    const deps = warmDeps([
      hostEntry({ terminalTargetId: "native:wt-42", ptyId: "pty-agent" }),
      hostEntry({ kind: "aux", terminalTargetId: "aux:pane-split-0", ptyId: "pty-aux", worktreePath: "/work/agent" }),
    ]);
    const plan = planLayoutRestoreWarm(warmSnapshot(), deps);

    expect(plan.workspace.panes.map((p) => p.id)).toEqual(["pane-agent-wt-42", "pane-split-0", "pane-wt-7"]);
    // Live agent + live aux got host-attached creators; the plain shell did not.
    expect(plan.seeds.find((s) => s.paneId === "pane-agent-wt-42")?.createTerminalOverride).toBeDefined();
    expect(plan.seeds.find((s) => s.paneId === "pane-split-0")?.createTerminalOverride).toBeDefined();
    expect(plan.seeds.find((s) => s.paneId === "pane-wt-7")?.createTerminalOverride).toBeUndefined();
    expect(plan.seeds.find((s) => s.paneId === "pane-wt-7")?.cwd).toBe("/work/seven");
    // The reattached agent's identity is seated on its record (for exit reporting).
    expect(plan.workspace.panes.find((p) => p.id === "pane-agent-wt-42")?.agentIdentity).toEqual({
      sessionId: "ses-1",
      terminalTargetId: "native:wt-42",
      harnessProvider: "claude",
    });
  });

  it("drops a dead agent and re-roots its child shell; cold-respawns dead aux", () => {
    // No live entries at all → every pane respawns fresh / agents drop.
    const plan = planLayoutRestoreWarm(warmSnapshot(), warmDeps([]));
    expect(plan.workspace.panes.map((p) => p.id)).toEqual(["pane-split-0", "pane-wt-7"]);
    expect(plan.workspace.panes[0]?.split).toBeNull(); // re-rooted off the dropped agent
    expect(plan.seeds.every((s) => s.createTerminalOverride === undefined)).toBe(true);
    expect(plan.workspace.panes.some((p) => p.agentIdentity !== undefined)).toBe(false);
    expect(plan.workspace.activePaneId).toBe("pane-split-0"); // active agent gone → first survivor
  });

  it("drops dead shell panes whose saved cwd no longer exists", () => {
    const plan = planLayoutRestoreWarm(warmSnapshot(), {
      ...warmDeps([]),
      cwdExists: (cwd) => cwd !== "/work/agent",
    });

    expect(plan.workspace.panes.map((p) => p.id)).toEqual(["pane-wt-7"]);
    expect(plan.workspace.activePaneId).toBe("pane-wt-7");
    expect(plan.seeds).toEqual([{ paneId: "pane-wt-7", cwd: "/work/seven" }]);
  });

  it("keeps a live host-attached shell even when its saved cwd is gone", () => {
    const deps = warmDeps([
      hostEntry({ kind: "aux", terminalTargetId: "aux:pane-split-0", ptyId: "pty-aux" }),
    ]);
    const plan = planLayoutRestoreWarm(warmSnapshot(), {
      ...deps,
      cwdExists: (cwd) => cwd !== "/work/agent",
    });

    expect(plan.workspace.panes.map((p) => p.id)).toEqual(["pane-split-0", "pane-wt-7"]);
    expect(plan.seeds.find((s) => s.paneId === "pane-split-0")?.createTerminalOverride).toBeDefined();
  });

  it("adopts an orphan live aux PTY as a top-level recovered shell", () => {
    const deps = warmDeps([
      hostEntry({ kind: "aux", terminalTargetId: "aux:pane-split-99", ptyId: "pty-orphan", worktreePath: "/work/orphan" }),
    ]);
    const plan = planLayoutRestoreWarm(warmSnapshot(), deps);

    // The orphan (no persisted slot) recovers its pane id and roots itself.
    const orphan = plan.workspace.panes.find((p) => p.id === "pane-split-99");
    expect(orphan).toEqual({ id: "pane-split-99", split: null, role: "shell" });
    expect(plan.seeds.find((s) => s.paneId === "pane-split-99")?.createTerminalOverride).toBeDefined();
    expect(plan.seeds.find((s) => s.paneId === "pane-split-99")?.cwd).toBe("/work/orphan");
  });

  it("never double-attaches: a claimed target is not also adopted as an orphan", () => {
    const deps = warmDeps([
      hostEntry({ kind: "aux", terminalTargetId: "aux:pane-split-0", ptyId: "pty-aux" }),
    ]);
    planLayoutRestoreWarm(warmSnapshot(), deps);
    // makeHostTerminal called exactly once for the claimed aux target — not again as an orphan.
    expect(deps.overrides.filter((t) => t === "aux:pane-split-0")).toHaveLength(1);
  });

  it("reattaches a shell with no persisted target via its derived aux id", () => {
    // Production aux shells do NOT persist their target — warm restore recomputes
    // `aux:<paneId>` from the pane id and matches it against host.list.
    const snapshot = buildLayoutSnapshot(
      { panes: [{ id: "pane-split-0", split: null, role: "shell" }], activePaneId: "pane-split-0" },
      () => "/work",
    );
    const deps = warmDeps([
      hostEntry({ kind: "aux", terminalTargetId: "aux:pane-split-0", ptyId: "pty-aux" }),
    ]);
    const plan = planLayoutRestoreWarm(snapshot, deps);

    expect(plan.workspace.panes.map((p) => p.id)).toEqual(["pane-split-0"]);
    expect(plan.seeds.find((s) => s.paneId === "pane-split-0")?.createTerminalOverride).toBeDefined();
    // Reattached by the derived id — not also adopted as a separate orphan.
    expect(deps.overrides).toEqual(["aux:pane-split-0"]);
  });

  it("respawns a dead shell back into the host via shell placement", () => {
    const fresh: string[] = [];
    const deps: WarmRestoreDeps = {
      liveByTarget: new Map(), // host is up, but this shell's PTY is gone
      makeHostTerminal: () => () => ({ id: "x" }) as unknown as StationTerminalProcess,
      resolveAuxShellPlacement: (paneId) => {
        fresh.push(paneId);
        return () => ({ id: `fresh:${paneId}` }) as unknown as StationTerminalProcess;
      },
    };
    const snapshot = buildLayoutSnapshot(
      { panes: [{ id: "pane-split-0", split: null, role: "shell" }], activePaneId: "pane-split-0" },
      () => "/work",
    );
    const plan = planLayoutRestoreWarm(snapshot, deps);

    expect(fresh).toEqual(["pane-split-0"]); // re-spawned into the host
    expect(plan.seeds[0]?.createTerminalOverride).toBeDefined();
  });
});

describe("cold-respawn restore round-trip (disk → store + registry → spawn at cwd)", () => {
  it("restores geometry, active pane, and cold-respawns each shell in its saved cwd", () => {
    const dir = mkdtempSync(join(tmpdir(), "station-restore-"));
    try {
      const path = join(dir, "layout.json");
      writeLayoutSnapshotSync(path, snapshotWithAgentAndShells());

      // --- second boot ---
      const loaded = readLayoutSnapshotSync(path);
      expect(loaded).not.toBeUndefined();
      const plan = planLayoutRestoreColdShells(loaded!);

      const store = createStationStore({ initialWorkspace: plan.workspace });
      const spawns: Array<{ cwd: string | undefined }> = [];
      const scripted = createScriptedTerminal();
      const registry = createPtyRegistry({
        createTerminal: (options) => {
          spawns.push({ cwd: options.cwd });
          return scripted.terminal;
        },
      });
      // Seed cwds before the reconciler-equivalent no-option ensure.
      applyRestoreSeeds(registry, plan.seeds);
      // Mirror StationApp.reconcilePanes (no-option ensure must preserve the cwd).
      for (const pane of store.getState().workspace.panes) {
        registry.ensure(pane.id);
      }

      // Geometry + active pane restored, agent dropped.
      expect(store.getState().workspace.panes.map((p) => p.id)).toEqual([
        "pane-split-0",
        "pane-split-1",
        "pane-wt-7",
      ]);
      expect(store.getState().workspace.activePaneId).toBe("pane-split-1");
      expect(store.getState().input.focus).toEqual({ kind: "pane", paneId: "pane-split-1" });

      // Lazy spawn-on-first-resize: each shell starts at its saved cwd.
      registry.resize("pane-split-1", { cols: 80, rows: 24 });
      expect(spawns).toEqual([{ cwd: "/work/agent/sub" }]);
      registry.resize("pane-wt-7", { cols: 80, rows: 24 });
      expect(spawns.at(-1)).toEqual({ cwd: "/work/seven" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
