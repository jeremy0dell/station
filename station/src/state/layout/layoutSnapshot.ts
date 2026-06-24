import { z } from "zod";
import type { PaneId, WorkspaceSlice } from "../types.js";

/**
 * Station-local v1 layout snapshot; observer and host do not read this contract.
 * Persist pane geometry, active pane, cwd, and host target lookup, but never
 * relaunch commands or trusted session identity from disk.
 */
export const STATION_LAYOUT_SCHEMA_VERSION = 1;

const paneIdSchema = z.string().min(1);

const paneSplitSchema = z
  .object({
    anchorPaneId: paneIdSchema,
    direction: z.enum(["right", "below"]),
    // Reserved for the split-ratio work; everything is flexGrow=1 today.
    ratio: z.number().positive().optional(),
  })
  .strict();

const paneRecordSchema = z
  .object({
    id: paneIdSchema,
    split: paneSplitSchema.nullable(),
    role: z.enum(["primary-agent", "shell"]),
    // A host-backed pane's PTY identity, used on the next boot to reattach it to
    // its live host PTY (and re-validated against the live host, never trusted blindly).
    terminalTargetId: z.string().min(1).optional(),
  })
  .strict();

export const StationLayoutSnapshotSchema = z
  .object({
    schemaVersion: z.literal(STATION_LAYOUT_SCHEMA_VERSION),
    panes: z.array(paneRecordSchema),
    activePaneId: paneIdSchema.nullable(),
    cwdByPane: z.record(paneIdSchema, z.string().min(1)),
  })
  .strict();

export type StationLayoutSnapshot = z.infer<typeof StationLayoutSnapshotSchema>;

/**
 * Join store records with registry cwd/target lookups. Host targets are persisted
 * only as reattach lookup keys for the next boot.
 */
export function buildLayoutSnapshot(
  workspace: WorkspaceSlice,
  cwdForPane: (paneId: PaneId) => string | undefined,
  targetForPane?: (paneId: PaneId) => string | undefined,
): StationLayoutSnapshot {
  const cwdByPane: Record<string, string> = {};
  for (const pane of workspace.panes) {
    const cwd = cwdForPane(pane.id);
    if (cwd !== undefined) {
      cwdByPane[pane.id] = cwd;
    }
  }
  return {
    schemaVersion: STATION_LAYOUT_SCHEMA_VERSION,
    panes: workspace.panes.map((pane) => {
      const target = targetForPane?.(pane.id);
      return {
        id: pane.id,
        split: pane.split,
        role: pane.role,
        ...(target === undefined ? {} : { terminalTargetId: target }),
      };
    }),
    activePaneId: workspace.activePaneId,
    cwdByPane,
  };
}

/** Strict parse; returns `undefined` on any shape/version mismatch. */
export function parseLayoutSnapshot(raw: unknown): StationLayoutSnapshot | undefined {
  const result = StationLayoutSnapshotSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}

/**
 * Reject incoherent snapshots before restore: panes must be nonempty, ids unique,
 * active id present, and split anchors already seen. Bad docs fall back cleanly.
 */
export function isLayoutTopologyValid(snapshot: StationLayoutSnapshot): boolean {
  if (snapshot.panes.length === 0) {
    return false;
  }
  const seen = new Set<PaneId>();
  for (const pane of snapshot.panes) {
    if (seen.has(pane.id)) {
      return false; // duplicate id
    }
    if (pane.split !== null && !seen.has(pane.split.anchorPaneId)) {
      return false; // anchor missing or not yet seen (forward/cyclic ref)
    }
    seen.add(pane.id);
  }
  return snapshot.activePaneId === null || seen.has(snapshot.activePaneId);
}
