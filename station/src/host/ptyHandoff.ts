import {
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
  readScrollbackExport,
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
  entries: ReadonlyMap<string, PtyEntry>;
  orphanBridges: PtyTableOrphanOptions | undefined;
  adoptTerminal: PtyTerminalAdopter;
  createSemanticTerminal: (cols: number, rows: number) => SemanticTerminalModel;
  maxScrollbackBytes: number;
  emit: (event: string, attributes: Record<string, unknown>) => void;
  /** Table-side activation: register, emit the adoption event, wire subscriptions. */
  activateAdoptedEntry: (init: AdoptedEntryInit) => void;
};

export type PtyHandoff = {
  exportRegistry(): Promise<PtyHandoffManifest>;
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

  return {
    async exportRegistry() {
      const manifest: PtyHandoffManifest = {};
      for (const entry of entries.values()) {
        if (entry.exited) {
          continue;
        }
        const bridgePid = entry.terminal.bridgePid;
        if (bridgePid === undefined || orphanBridges === undefined) {
          // In-process transports have no bridge process to park; adoption is a
          // bridge-lane capability, so report the skip instead of failing.
          emit("pty.handoff.export-skipped", {
            ptyId: entry.ptyId,
            reason: bridgePid === undefined ? "no-bridge-transport" : "orphan-mode-disabled",
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
        manifest[entry.ptyId] = handoffEntry;
      }
      emit("pty.handoff.export", { count: Object.keys(manifest).length });
      return manifest;
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
      for (const [ptyId, handoffEntry] of Object.entries(manifest)) {
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
        if (handoffEntry.scrollbackRef !== undefined) {
          const exportData = await readScrollbackExport(handoffEntry.scrollbackRef);
          if (exportData !== undefined) {
            ring = ScrollbackRing.restore(maxScrollbackBytes, exportData);
          } else {
            emit("pty.handoff.scrollback-import-failed", { ptyId });
          }
        }
        if (ring === undefined) {
          ring = new ScrollbackRing(maxScrollbackBytes, { cols, rows });
        }
        // An evicted park backlog leaves a gap between the exported ring and
        // live output; replay must fail closed into semantic recovery.
        if (terminal.parkedEvicted === true) {
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
