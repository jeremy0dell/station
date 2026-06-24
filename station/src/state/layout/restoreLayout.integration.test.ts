import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { buildLayoutSnapshot } from "./layoutSnapshot.js";
import { readLayoutSnapshotSync, writeLayoutSnapshotSync } from "./layoutPersistence.js";
import { applyRestoreSeeds, planLayoutRestoreColdShells } from "./restoreLayout.js";
import { savedCwdExists } from "./savedCwdExists.js";
import { createStationStore } from "../store.js";
import type { WorkspaceSlice } from "../types.js";
import { createPtyRegistry, type PtyRegistry } from "../../terminal/registry/ptyRegistry.js";
import type { StationVtScreen } from "../../terminal/vt/screen.js";

// Real node-pty shells + real disk: the highest-fidelity check short of the TTY
// renderer. Proves the production restore functions (used verbatim by main.tsx)
// bring a saved layout back as real shells in their saved directories.

const dirs: string[] = [];
const registries: PtyRegistry[] = [];

afterEach(() => {
  for (const registry of registries.splice(0)) {
    registry.disposeAll();
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function screenText(screen: StationVtScreen): string {
  return screen.buildRows().map((row) => row.spans.map((span) => span.text).join("")).join("\n");
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("waitFor timed out");
}

describe("cold-respawn restore with real shells (disk → restore → pwd at saved cwd)", () => {
  it("cold-respawns each restored shell in its saved working directory", async () => {
    const stateDir = tmp("station-state-");
    const layoutPath = join(stateDir, "layout.json");
    const cwdA = tmp("station-cwdA-");
    const cwdB = tmp("station-cwdB-");

    // --- first session: persist a two-shell split layout with distinct cwds ---
    const session1: WorkspaceSlice = {
      panes: [
        { id: "pane-main", split: null, role: "shell" },
        { id: "pane-split-0", split: { anchorPaneId: "pane-main", direction: "right" }, role: "shell" },
      ],
      activePaneId: "pane-split-0",
    };
    writeLayoutSnapshotSync(
      layoutPath,
      buildLayoutSnapshot(session1, (id) => (id === "pane-main" ? cwdA : id === "pane-split-0" ? cwdB : undefined)),
    );

    // --- second session (cold restart): run the real production restore path ---
    const restored = readLayoutSnapshotSync(layoutPath);
    expect(restored).not.toBeUndefined();
    const plan = planLayoutRestoreColdShells(restored!);

    const store = createStationStore({ initialWorkspace: plan.workspace });
    const registry = createPtyRegistry(); // default = real node-pty
    registries.push(registry);
    applyRestoreSeeds(registry, plan.seeds);
    // Mirror StationApp.reconcilePanes: no-option ensure must preserve the cwd.
    for (const pane of store.getState().workspace.panes) {
      registry.ensure(pane.id);
    }

    // Lazy spawn-on-first-resize: real shells start in their saved cwd.
    registry.resize("pane-main", { cols: 80, rows: 24 });
    registry.resize("pane-split-0", { cols: 80, rows: 24 });

    registry.write("pane-main", "pwd\n");
    registry.write("pane-split-0", "pwd\n");

    const mainScreen = registry.get("pane-main")?.screen;
    const splitScreen = registry.get("pane-split-0")?.screen;
    expect(mainScreen).not.toBeNull();
    expect(splitScreen).not.toBeNull();

    // pwd prints the resolved path; assert on the unique mkdtemp basenames so the
    // macOS /var → /private symlink can't make the comparison flaky.
    const baseA = basename(realpathSync(cwdA));
    const baseB = basename(realpathSync(cwdB));
    await waitFor(() => screenText(mainScreen!).includes(baseA));
    await waitFor(() => screenText(splitScreen!).includes(baseB));

    expect(screenText(mainScreen!)).toContain(baseA);
    expect(screenText(splitScreen!)).toContain(baseB);
    // Geometry restored: the split kept its anchor + direction.
    expect(store.getState().workspace.panes[1]?.split).toEqual({
      anchorPaneId: "pane-main",
      direction: "right",
    });
    expect(store.getState().workspace.activePaneId).toBe("pane-split-0");
  });

  it("degrades gracefully when a saved cwd no longer exists (no crash)", async () => {
    const stateDir = tmp("station-state-");
    const layoutPath = join(stateDir, "layout.json");
    const goneCwd = tmp("station-gone-");

    writeLayoutSnapshotSync(
      layoutPath,
      buildLayoutSnapshot(
        { panes: [{ id: "pane-main", split: null, role: "shell" }], activePaneId: "pane-main" },
        () => goneCwd,
      ),
    );
    // The worktree vanished between sessions (deleted / renamed) — the most likely
    // on-disk-vs-reality drift the saved spawn cwd can hit.
    rmSync(goneCwd, { recursive: true, force: true });

    const restored = readLayoutSnapshotSync(layoutPath);
    const plan = planLayoutRestoreColdShells(restored!);
    const store = createStationStore({ initialWorkspace: plan.workspace });
    const registry = createPtyRegistry(); // default = real node-pty
    registries.push(registry);
    applyRestoreSeeds(registry, plan.seeds);
    for (const pane of store.getState().workspace.panes) {
      registry.ensure(pane.id);
    }

    // Spawning into the missing dir must not throw synchronously...
    expect(() => registry.resize("pane-main", { cols: 80, rows: 24 })).not.toThrow();
    // ...and it must settle into a terminal state (exited / failed), never hang.
    await waitFor(() => {
      const entry = registry.get("pane-main");
      return entry !== undefined && (entry.exited || entry.status.includes("failed"));
    });
    const entry = registry.get("pane-main");
    expect(entry?.exited === true || entry?.status.includes("failed") === true).toBe(true);
  });

  it("drops a restored shell whose saved cwd is gone, using the production cwdExists", () => {
    const stateDir = tmp("station-state-");
    const layoutPath = join(stateDir, "layout.json");
    const goneCwd = tmp("station-gone-");

    writeLayoutSnapshotSync(
      layoutPath,
      buildLayoutSnapshot(
        { panes: [{ id: "pane-main", split: null, role: "shell" }], activePaneId: "pane-main" },
        () => goneCwd,
      ),
    );
    rmSync(goneCwd, { recursive: true, force: true });

    const restored = readLayoutSnapshotSync(layoutPath);
    // Exactly what main.tsx wires: the real statSync predicate drops the dead shell
    // instead of respawning into a missing directory, leaving an empty workspace.
    const plan = planLayoutRestoreColdShells(restored!, { cwdExists: savedCwdExists });

    expect(plan.workspace.panes).toHaveLength(0);
    expect(plan.workspace.activePaneId).toBeNull();
    expect(plan.seeds).toEqual([]);
  });
});
