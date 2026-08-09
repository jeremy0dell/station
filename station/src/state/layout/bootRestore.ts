import { type HostListEntry, StationHostProviderError } from "@station/host";
import type { StationTerminalProcess, StationTerminalSpawnOptions } from "../../terminal/types.js";
import type { PaneId } from "../types.js";
import type { StationLayoutSnapshot } from "./layoutSnapshot.js";
import {
  type LayoutRestorePlan,
  planLayoutRestoreColdShells,
  planLayoutRestoreWarm,
  type RestoreCwdOptions,
} from "./restoreLayout.js";

export type BootRestoreDeps = {
  /**
   * Enumerate the live host PTYs (with a short timeout), or `undefined`/empty
   * when no host is running — which makes the boot cold-respawn instead of
   * warm-reattach.
   */
  listHost?: () => Promise<readonly HostListEntry[] | undefined>;
  /** Build the host-attached terminal creator for a live entry. */
  makeHostTerminal: (
    entry: HostListEntry,
  ) => (options: StationTerminalSpawnOptions) => StationTerminalProcess;
  /**
   * Spawn a fresh aux shell into the host (for a warm boot's dead shell panes, so
   * they persist again). Returns `undefined` when no host socket is present.
   */
  resolveAuxShellPlacement?: (
    paneId: PaneId,
  ) => ((options: StationTerminalSpawnOptions) => StationTerminalProcess) | undefined;
} & RestoreCwdOptions;

/**
 * Single boot fork: one pre-seed `host.list` is checked for unique live targets
 * before warm reattach. Invalid inventory never degrades into a cold respawn.
 */
export async function buildBootRestorePlan(
  snapshot: StationLayoutSnapshot,
  deps: BootRestoreDeps,
): Promise<LayoutRestorePlan> {
  const live = deps.listHost === undefined ? undefined : await deps.listHost();
  if (live === undefined) {
    return planLayoutRestoreColdShells(snapshot, deps);
  }
  const liveByTarget = checkedLiveTargetIndex(live);
  if (liveByTarget.size === 0) {
    return planLayoutRestoreColdShells(snapshot, deps);
  }
  return planLayoutRestoreWarm(snapshot, {
    liveByTarget,
    makeHostTerminal: deps.makeHostTerminal,
    ...(deps.resolveAuxShellPlacement === undefined
      ? {}
      : { resolveAuxShellPlacement: deps.resolveAuxShellPlacement }),
    ...(deps.cwdExists === undefined ? {} : { cwdExists: deps.cwdExists }),
  });
}

/** Build the unique alive-target index consumed by warm restore. */
function checkedLiveTargetIndex(live: readonly HostListEntry[]): ReadonlyMap<string, HostListEntry> {
  const index = new Map<string, HostListEntry>();
  for (const entry of live) {
    if (!entry.alive) {
      continue;
    }
    if (index.has(entry.terminalTargetId)) {
      throw new StationHostProviderError(
        "HOST_TARGET_CONFLICT",
        `Multiple live Host PTYs claim target "${entry.terminalTargetId}".`,
      );
    }
    index.set(entry.terminalTargetId, entry);
  }
  return index;
}
