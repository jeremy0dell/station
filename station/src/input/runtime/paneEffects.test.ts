import type { ObserverService } from "@station/client";
import { describe, expect, it } from "bun:test";
import { manyProjectsSnapshot } from "../../station/fixtures/scenarios.js";
import { makeStationTestRuntime } from "../../station/test/support/makeStationTestRuntime.js";
import { createStationStore } from "../../state/store.js";
import { agentWorktreePaneId, type PaneId } from "../../state/types.js";
import type { PtyRegistry } from "../../terminal/registry/ptyRegistry.js";
import { reportManagedAgentPaneExit } from "./managedAgentPaneCleanup.js";
import { createPaneEffects, nextSplitSeqFromPanes } from "./paneEffects.js";

describe("nextSplitSeqFromPanes", () => {
  it("returns one past the highest pane-split-N", () => {
    expect(
      nextSplitSeqFromPanes([
        { id: "pane-main" },
        { id: "pane-split-2" },
        { id: "pane-split-9" },
        { id: "pane-wt-x" },
      ]),
    ).toBe(10);
  });

  it("returns 0 when there are no split panes", () => {
    expect(nextSplitSeqFromPanes([{ id: "pane-main" }, { id: "pane-agent-wt-1" }])).toBe(0);
  });

  it("ignores non-numeric split suffixes", () => {
    expect(nextSplitSeqFromPanes([{ id: "pane-split-abc" }, { id: "pane-split-3" }])).toBe(4);
  });
});

describe("managed pane close", () => {
  it("releases a local managed target before dropping the pane identity", async () => {
    const store = createStationStore({ boot: "empty" });
    const paneId = agentWorktreePaneId("wt_station_working");
    store.actions.createPane(paneId, { role: "primary-agent" });
    store.actions.setPrimaryAgent(paneId, {
      sessionId: "ses_station_working",
      terminalTargetId: "native:wt_station_working",
      terminalBindingToken: "binding_1",
    });
    let kills = 0;
    const registry = {
      get: () => ({ terminal: {}, exited: false }),
      terminate: async () => {
        kills += 1;
      },
    } as unknown as PtyRegistry;
    const reported: unknown[] = [];
    const effects = createPaneEffects({
      store,
      clientState: undefined,
      registry,
      resolveAuxShellPlacement: undefined,
      autoCloseOverlay: false,
      automations: [],
      writeToTerminal: undefined,
      pasteToTerminal: undefined,
      reportExternalExit: async (params) => {
        reported.push(params);
        return { acknowledged: true, terminalTargetId: params.terminalTargetId };
      },
    });

    effects.closePane(paneId);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reported).toEqual([
      {
        terminalTargetId: "native:wt_station_working",
        expectedSessionId: "ses_station_working",
        expectedBindingToken: "binding_1",
      },
    ]);
    expect(kills).toBe(1);
    expect(store.getState().workspace.panes).toEqual([]);
  });

  it("deduplicates explicit cleanup and the registry exit callback", async () => {
    const store = createStationStore({ boot: "empty" });
    const paneId = agentWorktreePaneId("wt_station_working");
    store.actions.createPane(paneId, {
      role: "primary-agent",
      worktreeId: "wt_station_working",
    });
    store.actions.setPrimaryAgent(paneId, {
      sessionId: "ses_station_working",
      terminalTargetId: "native:wt_station_working",
      terminalBindingToken: "binding_1",
    });
    let calls = 0;
    let acknowledge!: () => void;
    const gate = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const reportExternalExit: ObserverService["reportExternalExit"] = async (params) => {
      calls += 1;
      await gate;
      return { acknowledged: true, terminalTargetId: params.terminalTargetId };
    };
    const deps = { store, reportExternalExit };

    const fromExit = reportManagedAgentPaneExit(deps, paneId);
    const fromCleanup = reportManagedAgentPaneExit(deps, paneId);
    expect(calls).toBe(1);
    acknowledge();
    await expect(Promise.all([fromExit, fromCleanup])).resolves.toEqual([true, true]);
  });
});

describe("split cwd resolution along the anchor chain", () => {
  // Regression: the walk to the worktree-owning pane must follow the full split-anchor chain.
  // A row-count-bounded guard wrongly returned undefined for a restored chain deeper than the
  // snapshot's row count, spawning splits in the default cwd instead of the worktree root.
  it("resolves the worktree root for a restored split chain deeper than the row count", () => {
    const worktreeId = "wt_station_working";
    const worktreeRoot = "/wt/deep/root";
    const baseSnapshot = manyProjectsSnapshot();
    const worktree = baseSnapshot.rows.find((row) => row.id === worktreeId);
    if (worktree === undefined) {
      throw new Error(`Fixture row ${worktreeId} must exist.`);
    }
    const snapshot = {
      ...baseSnapshot,
      rows: [{ ...worktree, path: worktreeRoot }],
    };
    const clientState = makeStationTestRuntime({ snapshot }).source;
    const store = createStationStore({ boot: "empty" });
    const agentPaneId = agentWorktreePaneId(worktreeId);
    store.actions.createPane(agentPaneId, { role: "primary-agent" });
    // Three nested splits (chain depth 3) anchored back to the worktree's agent pane, against a
    // single-row snapshot — the exact shape the old `depth > rows.length + 1` guard tripped on.
    store.actions.createPane("pane-split-0" as PaneId, {
      split: { anchorPaneId: agentPaneId, direction: "right" },
    });
    store.actions.createPane("pane-split-1" as PaneId, {
      split: { anchorPaneId: "pane-split-0" as PaneId, direction: "right" },
    });
    store.actions.createPane("pane-split-2" as PaneId, {
      split: { anchorPaneId: "pane-split-1" as PaneId, direction: "right" },
    });

    const ensured: Array<{ id: PaneId; options: { cwd?: string } | undefined }> = [];
    const registry = {
      get: () => undefined,
      ensure: (id: PaneId, options: { cwd?: string } | undefined) => {
        ensured.push({ id, options });
      },
    } as unknown as PtyRegistry;

    const effects = createPaneEffects({
      store,
      clientState,
      registry,
      resolveAuxShellPlacement: undefined,
      autoCloseOverlay: false,
      automations: [],
      writeToTerminal: undefined,
      pasteToTerminal: undefined,
    });

    effects.splitPane("pane-split-2" as PaneId, "right");

    expect(ensured).toHaveLength(1);
    expect(ensured[0]?.options).toEqual({ cwd: worktreeRoot });
  });
});
