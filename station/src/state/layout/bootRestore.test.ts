import { describe, expect, it } from "bun:test";
import type { HostListEntry } from "@station/host";
import { buildBootRestorePlan } from "./bootRestore.js";
import { buildLayoutSnapshot } from "./layoutSnapshot.js";
import type { StationTerminalProcess } from "../../terminal/types.js";
import type { WorkspaceSlice } from "../types.js";

function snapshot() {
  const workspace: WorkspaceSlice = {
    panes: [{ id: "pane-agent-wt-42", split: null, role: "primary-agent" }],
    activePaneId: "pane-agent-wt-42",
  };
  return buildLayoutSnapshot(workspace, () => "/work", () => "native:wt-42");
}

const makeHostTerminal = () => () => ({}) as StationTerminalProcess;

function agentEntry(): HostListEntry {
  return {
    kind: "agent",
    ptyId: "pty-1",
    terminalTargetId: "native:wt-42",
    worktreeId: "wt-42",
    projectId: "proj-1",
    sessionId: "ses-1",
    worktreePath: "/work",
    harnessProvider: "claude",
    pid: 1,
    alive: true,
    cols: 80,
    rows: 24,
  };
}

describe("buildBootRestorePlan (warm-vs-cold fork)", () => {
  it("cold-restores (fresh shells, drop agents) when no host lister is provided", async () => {
    const plan = await buildBootRestorePlan(snapshot(), { makeHostTerminal });
    expect(plan.workspace.panes).toHaveLength(0); // the sole agent pane is dropped
  });

  it("cold-restores when the host list is undefined (no host) or empty", async () => {
    const none = await buildBootRestorePlan(snapshot(), { listHost: async () => undefined, makeHostTerminal });
    expect(none.workspace.panes).toHaveLength(0);
    const empty = await buildBootRestorePlan(snapshot(), { listHost: async () => [], makeHostTerminal });
    expect(empty.workspace.panes).toHaveLength(0);
  });

  it("warm-restores (reattach to the live host PTY) when the host reports the agent alive", async () => {
    const plan = await buildBootRestorePlan(snapshot(), {
      listHost: async () => [agentEntry()],
      makeHostTerminal,
    });
    expect(plan.workspace.panes.map((p) => p.id)).toEqual(["pane-agent-wt-42"]);
    expect(plan.seeds[0]?.createTerminalOverride).toBeDefined();
    // The reattached agent's identity is seated on its record for exit reporting.
    expect(plan.workspace.panes[0]?.agentIdentity).toEqual({
      sessionId: "ses-1",
      terminalTargetId: "native:wt-42",
      harnessProvider: "claude",
    });
  });
});
