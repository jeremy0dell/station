import { describe, expect, it } from "bun:test";
import type { StoreApi } from "zustand/vanilla";
import type { TuiStore } from "@station/dashboard-core";
import { createStationStore } from "../../state/store.js";
import { agentWorktreePaneId, type PaneId } from "../../state/types.js";
import type { PtyRegistry } from "../../terminal/registry/ptyRegistry.js";
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

describe("split cwd resolution along the anchor chain", () => {
  // Regression: the walk to the worktree-owning pane must follow the full split-anchor chain.
  // A row-count-bounded guard wrongly returned undefined for a restored chain deeper than the
  // snapshot's row count, spawning splits in the default cwd instead of the worktree root.
  it("resolves the worktree root for a restored split chain deeper than the row count", () => {
    const worktreeId = "wt_deep";
    const worktreeRoot = "/wt/deep/root";
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

    const stationViewStore = {
      getState: () => ({ snapshot: { rows: [{ id: worktreeId, path: worktreeRoot }] } }),
    } as unknown as StoreApi<TuiStore>;

    const ensured: Array<{ id: PaneId; options: { cwd?: string } | undefined }> = [];
    const registry = {
      get: () => undefined,
      ensure: (id: PaneId, options: { cwd?: string } | undefined) => {
        ensured.push({ id, options });
      },
    } as unknown as PtyRegistry;

    const effects = createPaneEffects({
      store,
      stationViewStore,
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
