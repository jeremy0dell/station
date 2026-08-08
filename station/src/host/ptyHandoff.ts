import {
  type HostHandoffFidelity,
  PtyBridgeProtocolVersion,
  type PtyHandoffEntry,
  type PtyHandoffManifest,
  PtyHandoffManifestSchema,
  type PtyScrollbackExport,
} from "@station/contracts";
import { type HostPtyIdentity, StationHostProviderError } from "@station/host";
import type { StationTerminalProcess, StationTerminalSize } from "../terminal/types.js";
import {
  bridgeControlSocketPath,
  readScreenSnapshot,
  readScrollbackExport,
  writeScreenSnapshot,
  writeScrollbackExport,
} from "./orphanBridges.js";
import { clampSize, type PtyEntry } from "./ptyEntry.js";
import { ScrollbackRing } from "./scrollbackRing.js";
import type { SemanticTerminalModel } from "./semanticTerminalSnapshot.js";

export type PtyTableOrphanOptions = {
  directory: string;
  ttlMs?: number;
};

export type PtyAdoptionTarget = {
  ptyId: string;
  command: string;
  controlSocketPath: string;
  size: StationTerminalSize;
};

/** An adopted terminal plus the park-backlog completeness flag, when the transport reports one. */
export type PtyAdoptedTerminal = StationTerminalProcess & {
  readonly parkedEvicted?: boolean | undefined;
};

export type PtyTerminalAdopter = (target: PtyAdoptionTarget) => Promise<PtyAdoptedTerminal>;

export type PtyAdoptionReport = {
  adopted: string[];
  failed: Array<{ ptyId: string; reason: string }>;
};

/** The per-lane pieces adoption assembles before the table activates the entry. */
export type AdoptedEntryInit = {
  ptyId: string;
  identity: HostPtyIdentity;
  command: string;
  terminal: PtyAdoptedTerminal;
  ring: ScrollbackRing;
  semantic: SemanticTerminalModel;
  cols: number;
  rows: number;
};

export type PtyHandoffDeps = {
  entries: Map<string, PtyEntry>;
  orphanBridges: PtyTableOrphanOptions | undefined;
  adoptTerminal: PtyTerminalAdopter;
  createSemanticTerminal: (cols: number, rows: number) => SemanticTerminalModel;
  maxScrollbackBytes: number;
  emit: (event: string, attributes: Record<string, unknown>) => void;
  /** Table-side activation: register, emit the adoption event, wire subscriptions. */
  activateAdoptedEntry: (init: AdoptedEntryInit) => void;
};

export type PtyHandoffReleaseReport = {
  manifest: PtyHandoffManifest;
  fidelity: HostHandoffFidelity;
  released: string[];
  skipped: Array<{ ptyId: string; reason: string }>;
};

export type PtyHandoff = {
  exportRegistry(fidelity?: HostHandoffFidelity): Promise<PtyHandoffManifest>;
  /**
   * Export scrollback/screen, park each bridge without SIGTERM, and drop local
   * table ownership so completeHandoff can exit without disposeAll.
   */
  releaseRegistryForHandoff(fidelity: HostHandoffFidelity): Promise<PtyHandoffReleaseReport>;
  adoptRegistry(manifest: unknown): Promise<PtyAdoptionReport>;
};

/**
 * Live-PTY handoff between host generations: export captures every bridge-backed
 * entry as a manifest plus persisted scrollback, adoption rebinds parked bridges
 * as live entries. Per-entry failures are reported, never thrown; an invalid
 * manifest fails closed.
 */
export function createPtyHandoff(deps: PtyHandoffDeps): PtyHandoff {
  const {
    entries,
    orphanBridges,
    adoptTerminal,
    createSemanticTerminal,
    maxScrollbackBytes,
    emit,
    activateAdoptedEntry,
  } = deps;

  const failAdoption = (
    report: PtyAdoptionReport,
    ptyId: string,
    reason: string,
    error?: unknown,
  ): void => {
    report.failed.push({ ptyId, reason });
    if (error !== undefined) {
      emit("pty.handoff.adopt-failed", {
        ptyId,
        reason,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  async function buildManifest(
    fidelity: HostHandoffFidelity,
    options: { requireRelease?: boolean } = {},
  ): Promise<{
    manifest: PtyHandoffManifest;
    skipped: Array<{ ptyId: string; reason: string }>;
  }> {
    const manifest: PtyHandoffManifest = {};
    const skipped: Array<{ ptyId: string; reason: string }> = [];
    for (const entry of entries.values()) {
      if (entry.exited) {
        continue;
      }
      const bridgePid = entry.terminal.bridgePid;
      if (bridgePid === undefined || orphanBridges === undefined) {
        const reason = bridgePid === undefined ? "no-bridge-transport" : "orphan-mode-disabled";
        skipped.push({ ptyId: entry.ptyId, reason });
        emit("pty.handoff.export-skipped", { ptyId: entry.ptyId, reason });
        continue;
      }
      // Export may snapshot bridge-backed rows; live park requires releaseToOrphan.
      if (options.requireRelease === true && entry.terminal.releaseToOrphan === undefined) {
        skipped.push({ ptyId: entry.ptyId, reason: "release-unsupported" });
        emit("pty.handoff.export-skipped", {
          ptyId: entry.ptyId,
          reason: "release-unsupported",
        });
        continue;
      }
      const snapshot = entry.ring.snapshot();
      const exportData: PtyScrollbackExport = {
        initialCols: snapshot.initialCols,
        initialRows: snapshot.initialRows,
        complete: snapshot.complete,
        events: snapshot.events,
      };
      const handoffEntry: PtyHandoffEntry = {
        bridgeProtocolVersion: PtyBridgeProtocolVersion,
        bridgePid,
        controlSocket: bridgeControlSocketPath(orphanBridges.directory, entry.ptyId),
        command: entry.command,
        cols: entry.cols,
        rows: entry.rows,
        identity: { ...entry.identity },
        ringComplete: snapshot.complete,
      };
      try {
        handoffEntry.scrollbackRef = await writeScrollbackExport(
          orphanBridges.directory,
          entry.ptyId,
          exportData,
        );
      } catch (error) {
        // A scrollback write failure degrades adoption replay, not adoption itself.
        emit("pty.handoff.scrollback-export-failed", {
          ptyId: entry.ptyId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      if (fidelity === "screen") {
        try {
          const sequences = await entry.semantic.capture();
          handoffEntry.screenSnapshotRef = await writeScreenSnapshot(
            orphanBridges.directory,
            entry.ptyId,
            { cols: entry.cols, rows: entry.rows, sequences },
          );
        } catch (error) {
          // Screen fidelity never blocks handoff; adopter falls back to replay.
          emit("pty.handoff.screen-export-failed", {
            ptyId: entry.ptyId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      manifest[entry.ptyId] = handoffEntry;
    }
    emit("pty.handoff.export", {
      count: Object.keys(manifest).length,
      fidelity,
      skipped: skipped.length,
    });
    return { manifest, skipped };
  }

  return {
    async exportRegistry(fidelity = "processes") {
      const { manifest } = await buildManifest(fidelity);
      return manifest;
    },

    async releaseRegistryForHandoff(fidelity) {
      const { manifest, skipped } = await buildManifest(fidelity, { requireRelease: true });
      // Partial handoff would leave non-parkable live terminals owned by a host
      // about to exit without disposeAll; refuse before mutating ownership.
      if (skipped.length > 0) {
        emit("pty.handoff.refused-partial", {
          fidelity,
          skipped: skipped.length,
          releasable: Object.keys(manifest).length,
        });
        return { manifest: {}, fidelity, released: [], skipped };
      }
      const released: string[] = [];
      for (const ptyId of Object.keys(manifest)) {
        const entry = entries.get(ptyId);
        if (entry === undefined) {
          continue;
        }
        for (const subscription of entry.subscriptions) {
          subscription.dispose();
        }
        entry.subscriptions.length = 0;
        entry.terminal.releaseToOrphan?.();
        entry.semantic.dispose();
        entries.delete(ptyId);
        released.push(ptyId);
      }
      emit("pty.handoff.released", { count: released.length, fidelity });
      return { manifest, fidelity, released, skipped };
    },

    async adoptRegistry(manifestInput) {
      let manifest: PtyHandoffManifest;
      try {
        manifest = PtyHandoffManifestSchema.parse(manifestInput);
      } catch (error) {
        throw new StationHostProviderError(
          "HOST_HANDOFF_MANIFEST_INVALID",
          "The PTY handoff manifest is invalid.",
          { cause: error },
        );
      }
      const report: PtyAdoptionReport = { adopted: [], failed: [] };
      for (const ptyId of Object.keys(manifest)) {
        const handoffEntry = manifest[ptyId];
        if (handoffEntry === undefined) {
          continue;
        }
        if (entries.has(ptyId)) {
          failAdoption(report, ptyId, "duplicate-pty-id");
          continue;
        }
        let terminal: PtyAdoptedTerminal;
        try {
          terminal = await adoptTerminal({
            ptyId,
            command: handoffEntry.command,
            controlSocketPath: handoffEntry.controlSocket,
            size: { cols: handoffEntry.cols, rows: handoffEntry.rows },
          });
        } catch (error) {
          // Per-entry isolation: one unreachable bridge never blocks the rest.
          failAdoption(report, ptyId, "adopt-failed", error);
          continue;
        }
        const { cols, rows } = clampSize(handoffEntry.cols, handoffEntry.rows);
        let ring: ScrollbackRing | undefined;
        let importFailed = false;
        if (handoffEntry.scrollbackRef !== undefined) {
          const exportData = await readScrollbackExport(handoffEntry.scrollbackRef);
          if (exportData !== undefined) {
            ring = ScrollbackRing.restore(maxScrollbackBytes, exportData);
          } else {
            importFailed = true;
            emit("pty.handoff.scrollback-import-failed", { ptyId });
          }
        }
        if (ring === undefined) {
          ring = new ScrollbackRing(maxScrollbackBytes, { cols, rows });
        }
        // Fail closed on any known gap — an evicted park backlog, an export
        // that recorded truncation, or a scrollback ref that would not read:
        // replay falls into semantic recovery, never a partial raw stream.
        if (
          terminal.parkedEvicted === true ||
          handoffEntry.ringComplete === false ||
          importFailed
        ) {
          ring.markEvicted();
        }
        let semantic: SemanticTerminalModel;
        try {
          semantic = createSemanticTerminal(cols, rows);
        } catch (error) {
          terminal.dispose();
          failAdoption(report, ptyId, "semantic-init-failed", error);
          continue;
        }
        if (handoffEntry.screenSnapshotRef !== undefined) {
          const screen = await readScreenSnapshot(handoffEntry.screenSnapshotRef);
          if (screen !== undefined) {
            try {
              for (const sequence of screen.sequences) {
                semantic.write(sequence);
              }
            } catch (error) {
              emit("pty.handoff.screen-import-failed", {
                ptyId,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          } else {
            emit("pty.handoff.screen-import-failed", { ptyId, reason: "unreadable" });
          }
        }
        activateAdoptedEntry({
          ptyId,
          identity: { ...handoffEntry.identity },
          command: handoffEntry.command,
          terminal,
          ring,
          semantic,
          cols,
          rows,
        });
        report.adopted.push(ptyId);
      }
      emit("pty.handoff.adopt", {
        adopted: report.adopted.length,
        failed: report.failed.length,
      });
      return report;
    },
  };
}
