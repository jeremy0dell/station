import type { HostListEntry } from "@station/host";
import type { PtyRegistry } from "../../terminal/registry/ptyRegistry.js";
import type { StationTerminalProcess, StationTerminalSpawnOptions } from "../../terminal/types.js";
import type { StationLayoutSnapshot } from "./layoutSnapshot.js";
import {
  auxTerminalTargetId,
  paneIdFromAuxTarget,
  type PaneId,
  type PaneRecord,
  type WorkspaceSlice,
} from "../types.js";

/**
 * One restored pane's registry seed: its spawn cwd plus, when its PTY is still
 * live in the host, the host-backed override factory that reattaches to it. With
 * no override the pane respawns a fresh local shell at `cwd`.
 */
export type RestoreSeed = {
  paneId: PaneId;
  cwd: string | undefined;
  createTerminalOverride?: (options: StationTerminalSpawnOptions) => StationTerminalProcess;
};

export type LayoutRestorePlan = {
  workspace: WorkspaceSlice;
  seeds: RestoreSeed[];
};

export type RestoreCwdOptions = {
  cwdExists?: (cwd: string) => boolean;
};

/**
 * Cold restore only respawns saved shells. Agents are never relaunched from disk;
 * shell panes anchored to dropped agents are re-rooted for coherent layout.
 */
export function planLayoutRestoreColdShells(
  snapshot: StationLayoutSnapshot,
  options: RestoreCwdOptions = {},
): LayoutRestorePlan {
  const shellPanes = snapshot.panes.filter(
    (pane) => pane.role === "shell" && paneCwdIsRestorable(snapshot, pane, options),
  );
  const shellIds = new Set(shellPanes.map((pane) => pane.id));
  const panes: PaneRecord[] = shellPanes.map((pane) => ({
    id: pane.id,
    split:
      pane.split !== null && shellIds.has(pane.split.anchorPaneId)
        ? { anchorPaneId: pane.split.anchorPaneId, direction: pane.split.direction }
        : null,
    role: "shell",
  }));
  const activePaneId =
    snapshot.activePaneId !== null && shellIds.has(snapshot.activePaneId)
      ? snapshot.activePaneId
      : (panes[0]?.id ?? null);
  const seeds: RestoreSeed[] = shellPanes.map((pane) => ({
    paneId: pane.id,
    cwd: snapshot.cwdByPane[pane.id],
  }));
  return {
    workspace: { panes, activePaneId },
    seeds,
  };
}

/**
 * Seed before the reconciler's no-option ensure; registry cwd/override are
 * captured only on the first ensure.
 */
export function applyRestoreSeeds(registry: PtyRegistry, seeds: readonly RestoreSeed[]): void {
  for (const seed of seeds) {
    const spawnOptions = seed.cwd === undefined ? undefined : { cwd: seed.cwd };
    registry.ensure(seed.paneId, spawnOptions, seed.createTerminalOverride);
  }
}

/**
 * What the boot gate needs to reattach panes to live PTYs: the live `host.list`
 * keyed by `terminalTargetId`, plus a factory that builds the host-backed override
 * for a given live entry (`createHostBackedTerminal` in production, a fake in tests).
 */
export type WarmRestoreDeps = {
  liveByTarget: ReadonlyMap<string, HostListEntry>;
  makeHostTerminal: (
    entry: HostListEntry,
  ) => (options: StationTerminalSpawnOptions) => StationTerminalProcess;
  /**
   * Spawn a fresh aux shell back into the host for a shell pane whose PTY is gone,
   * so it persists again going forward. Returns `undefined` when the host is
   * unavailable, in which case the shell respawns locally. Absent ⇒ always local.
   */
  makeFreshAuxTerminal?: (
    paneId: PaneId,
  ) => ((options: StationTerminalSpawnOptions) => StationTerminalProcess) | undefined;
} & RestoreCwdOptions;

/**
 * Warm restore reattaches panes with live host targets, respawns missing shells,
 * drops missing agents, and adopts live aux orphans as top-level shells.
 * `claimedTargets` prevents two restored panes from attaching one host PTY.
 */
export function planLayoutRestoreWarm(
  snapshot: StationLayoutSnapshot,
  deps: WarmRestoreDeps,
): LayoutRestorePlan {
  const panes: PaneRecord[] = [];
  const seeds: RestoreSeed[] = [];
  const keptIds = new Set<PaneId>();
  const claimedTargets = new Set<string>();

  for (const pane of snapshot.panes) {
    // Agents carry a persisted target; an aux shell's is recomputed from its id.
    const lookupTarget =
      pane.terminalTargetId ?? (pane.role === "shell" ? auxTerminalTargetId(pane.id) : undefined);
    const live = lookupTarget === undefined ? undefined : deps.liveByTarget.get(lookupTarget);
    if (lookupTarget !== undefined && live !== undefined) {
      claimedTargets.add(lookupTarget);
      const record: PaneRecord = { id: pane.id, split: reanchor(pane, keptIds), role: pane.role };
      if (pane.role === "primary-agent") {
        // Reattaching a live agent re-derives its identity from the host entry —
        // never trusted from disk — so its exit still reports to the observer.
        record.agentIdentity = {
          sessionId: live.sessionId,
          terminalTargetId: live.terminalTargetId,
          harnessProvider: live.harnessProvider,
        };
      }
      panes.push(record);
      keptIds.add(pane.id);
      seeds.push({ paneId: pane.id, cwd: snapshot.cwdByPane[pane.id], createTerminalOverride: deps.makeHostTerminal(live) });
      continue;
    }
    if (pane.role === "shell") {
      if (!paneCwdIsRestorable(snapshot, pane, deps)) {
        continue;
      }
      panes.push({ id: pane.id, split: reanchor(pane, keptIds), role: "shell" });
      keptIds.add(pane.id);
      const seed: RestoreSeed = { paneId: pane.id, cwd: snapshot.cwdByPane[pane.id] };
      const freshOverride = deps.makeFreshAuxTerminal?.(pane.id);
      if (freshOverride !== undefined) {
        seed.createTerminalOverride = freshOverride;
      }
      seeds.push(seed);
    }
    // A dead primary-agent pane is dropped (its child shells re-root via reanchor).
  }

  // Adopt live aux PTYs with no persisted slot as top-level recovered shells.
  for (const entry of deps.liveByTarget.values()) {
    if (entry.kind !== "aux" || claimedTargets.has(entry.terminalTargetId)) {
      continue;
    }
    const paneId = paneIdFromAuxTarget(entry.terminalTargetId) ?? `pane-recovered-${entry.ptyId}`;
    if (keptIds.has(paneId)) {
      continue;
    }
    panes.push({ id: paneId, split: null, role: "shell" });
    keptIds.add(paneId);
    seeds.push({ paneId, cwd: entry.worktreePath, createTerminalOverride: deps.makeHostTerminal(entry) });
  }

  const activePaneId =
    snapshot.activePaneId !== null && keptIds.has(snapshot.activePaneId)
      ? snapshot.activePaneId
      : (panes[0]?.id ?? null);
  return { workspace: { panes, activePaneId }, seeds };
}

/** Keep a split anchored only to a pane that survived; else re-root it. */
function reanchor(
  pane: StationLayoutSnapshot["panes"][number],
  keptIds: ReadonlySet<PaneId>,
): PaneRecord["split"] {
  if (pane.split !== null && keptIds.has(pane.split.anchorPaneId)) {
    return { anchorPaneId: pane.split.anchorPaneId, direction: pane.split.direction };
  }
  return null;
}

function paneCwdIsRestorable(
  snapshot: StationLayoutSnapshot,
  pane: StationLayoutSnapshot["panes"][number],
  options: RestoreCwdOptions,
): boolean {
  const cwd = snapshot.cwdByPane[pane.id];
  return cwd === undefined || options.cwdExists?.(cwd) !== false;
}
