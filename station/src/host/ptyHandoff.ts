import {
  type HostHandoffFidelity,
  PtyBridgeProtocolVersion,
  type PtyHandoffEntry,
  type PtyHandoffManifest,
  PtyHandoffManifestSchema,
  type PtyScrollbackExport,
} from "@station/contracts";
import {
  type HostPtyHandoffSupport,
  type HostPtyIdentity,
  StationHostProviderError,
} from "@station/host";
import type { StationTerminalProcess, StationTerminalSize } from "../terminal/types.js";
import {
  bridgeControlSocketPath,
  readScreenSnapshot,
  readScrollbackExport,
  waitForReleasedParkReady,
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
  /** Exact PTY lifetime the parked bridge must prove before yielding ownership. */
  ptyInstanceId: string;
  /** Exact bridge process the incumbent manifest attested for this PTY lifetime. */
  bridgePid: number;
  command: string;
  controlSocketPath: string;
  size: StationTerminalSize;
};

/** Adopted bridge ownership that can be surrendered without killing the PTY when setup fails. */
export type PtyAdoptedTerminal = Omit<StationTerminalProcess, "releaseToOrphan"> & {
  releaseToOrphan(): boolean;
  readonly parkedEvicted?: boolean | undefined;
};

export type PtyTerminalAdopter = (target: PtyAdoptionTarget) => Promise<PtyAdoptedTerminal>;

export type PtyAdoptionReport = {
  adopted: string[];
  failed: Array<{ ptyId: string; reason: string }>;
};

/** Internal release failure whose parked PTYs still require incumbent restoration. */
export class PtyHandoffRestorationError extends StationHostProviderError {
  readonly remainingManifest: PtyHandoffManifest;

  constructor(remainingManifest: PtyHandoffManifest, cause: unknown) {
    super(
      "HOST_HANDOFF_INVALID_STATE",
      "Station Host could not restore every terminal after handoff release failed.",
      { cause },
    );
    this.remainingManifest = remainingManifest;
  }
}

/** The per-lane pieces adoption assembles before the table activates the entry. */
export type AdoptedEntryInit = {
  ptyId: string;
  ptyInstanceId: string;
  identity: HostPtyIdentity;
  command: string;
  terminal: PtyAdoptedTerminal;
  ring: ScrollbackRing;
  semantic: SemanticTerminalModel;
  cols: number;
  rows: number;
};

export type PtyHandoffDeps = {
  entriesByPtyId: Map<string, PtyEntry>;
  entriesByTarget: Map<string, PtyEntry>;
  orphanBridges: PtyTableOrphanOptions | undefined;
  adoptTerminal: PtyTerminalAdopter;
  createSemanticTerminal: (cols: number, rows: number) => SemanticTerminalModel;
  maxScrollbackBytes: number;
  emit: (event: string, attributes: Record<string, unknown>) => void;
  /** Transactionally reserve both indexes, emit adoption, and install lifecycle subscriptions. */
  activateAdoptedEntry: (init: AdoptedEntryInit) => void;
  /** Table-owned atomic removal from both PTY-id and terminal-target indexes. */
  deactivateEntry: (entry: PtyEntry) => void;
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

type Emit = (event: string, attributes: Record<string, unknown>) => void;

/**
 * Live-PTY handoff between host generations: export captures every bridge-backed
 * entry as a manifest plus persisted scrollback, adoption rebinds parked bridges
 * as live entries. Per-entry failures are reported, never thrown; an invalid
 * manifest fails closed.
 */
export function createPtyHandoff(deps: PtyHandoffDeps): PtyHandoff {
  const {
    entriesByPtyId,
    entriesByTarget,
    orphanBridges,
    adoptTerminal,
    createSemanticTerminal,
    maxScrollbackBytes,
    emit,
    activateAdoptedEntry,
    deactivateEntry,
  } = deps;

  async function buildManifest(
    fidelity: HostHandoffFidelity,
    options: { requireRelease?: boolean } = {},
  ): Promise<{
    manifest: PtyHandoffManifest;
    skipped: Array<{ ptyId: string; reason: string }>;
  }> {
    const manifest: PtyHandoffManifest = {};
    const skipped: Array<{ ptyId: string; reason: string }> = [];
    for (const entry of entriesByPtyId.values()) {
      if (entry.exited) {
        continue;
      }
      const built = await tryBuildHandoffEntry({
        entry,
        fidelity,
        orphanBridges,
        requireRelease: options.requireRelease === true,
        emit,
      });
      if (built.kind === "skipped") {
        skipped.push({ ptyId: entry.ptyId, reason: built.reason });
        continue;
      }
      manifest[entry.ptyId] = built.entry;
    }
    emit("pty.handoff.export", {
      count: Object.keys(manifest).length,
      fidelity,
      skipped: skipped.length,
    });
    return { manifest, skipped };
  }

  async function adoptRegistry(manifestInput: unknown): Promise<PtyAdoptionReport> {
    const manifest = parseHandoffManifest(manifestInput);
    preflightAdoption(manifest, entriesByPtyId, entriesByTarget);
    const report: PtyAdoptionReport = { adopted: [], failed: [] };
    for (const ptyId of Object.keys(manifest)) {
      const handoffEntry = manifest[ptyId];
      if (handoffEntry === undefined) {
        continue;
      }
      const outcome = await adoptOneEntry({
        ptyId,
        handoffEntry,
        adoptTerminal,
        createSemanticTerminal,
        maxScrollbackBytes,
        emit,
        activateAdoptedEntry,
      });
      if (outcome.kind === "adopted") {
        report.adopted.push(ptyId);
      } else {
        report.failed.push({ ptyId, reason: outcome.reason });
      }
    }
    emit("pty.handoff.adopt", {
      adopted: report.adopted.length,
      failed: report.failed.length,
    });
    return report;
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
      const parked = parkAndDropReleasedEntries(
        entriesByPtyId,
        Object.keys(manifest),
        deactivateEntry,
      );
      try {
        await ensureExpectedParksReady({
          expectPark: parked.expectPark,
          manifest,
          emit,
        });
      } catch (error) {
        // Ownership already left the table; restore before surfacing the failure.
        let restoration: PtyAdoptionReport;
        try {
          restoration = await adoptRegistry(manifest);
        } catch (restorationError) {
          throw new PtyHandoffRestorationError(manifest, restorationError);
        }
        const remainingManifest = unadoptedPtyHandoffManifest(manifest, restoration.adopted);
        if (Object.keys(remainingManifest).length > 0) {
          throw new PtyHandoffRestorationError(remainingManifest, error);
        }
        throw error;
      }
      emit("pty.handoff.released", { count: parked.released.length, fidelity });
      return { manifest, fidelity, released: parked.released, skipped };
    },

    adoptRegistry,
  };
}

/** Preserve exact manifest evidence only for PTYs not proven adopted by a completed report. */
export function unadoptedPtyHandoffManifest(
  manifest: PtyHandoffManifest,
  adoptedPtyIds: readonly string[],
): PtyHandoffManifest {
  const adopted = new Set(adoptedPtyIds);
  const remaining: PtyHandoffManifest = {};
  for (const [ptyId, entry] of Object.entries(manifest)) {
    if (!adopted.has(ptyId)) {
      remaining[ptyId] = entry;
    }
  }
  return remaining;
}

type BuildEntryResult =
  | { kind: "entry"; entry: PtyHandoffEntry }
  | { kind: "skipped"; reason: string };

/**
 * POLICY
 *
 * Classifies whether one live PTY transport can leave its current Host without termination.
 * The same checks drive read-only inventory and release admission so preflight cannot advertise a
 * weaker bridge path than handoff will accept.
 */
export function classifyPtyHandoffSupport(input: {
  entry: Pick<PtyEntry, "terminal">;
  orphanBridges: PtyTableOrphanOptions | undefined;
  requireRelease?: boolean;
}): HostPtyHandoffSupport {
  if (input.entry.terminal.bridgePid === undefined) {
    return { kind: "non-releasable", reason: "no-bridge-transport" };
  }
  if (input.orphanBridges === undefined) {
    return { kind: "non-releasable", reason: "orphan-mode-disabled" };
  }
  if (input.requireRelease !== false && input.entry.terminal.releaseToOrphan === undefined) {
    return { kind: "non-releasable", reason: "release-unsupported" };
  }
  return { kind: "bridge-releasable" };
}

async function tryBuildHandoffEntry(input: {
  entry: PtyEntry;
  fidelity: HostHandoffFidelity;
  orphanBridges: PtyTableOrphanOptions | undefined;
  requireRelease: boolean;
  emit: Emit;
}): Promise<BuildEntryResult> {
  const { entry, fidelity, orphanBridges, requireRelease, emit } = input;
  const support = classifyPtyHandoffSupport({
    entry,
    orphanBridges,
    requireRelease,
  });
  if (support.kind === "non-releasable") {
    emit("pty.handoff.export-skipped", { ptyId: entry.ptyId, reason: support.reason });
    return { kind: "skipped", reason: support.reason };
  }
  const bridgePid = entry.terminal.bridgePid;
  if (bridgePid === undefined || orphanBridges === undefined) {
    throw new Error("Bridge-releasable handoff support requires bridge and orphan evidence.");
  }

  const snapshot = entry.ring.snapshot();
  const handoffEntry: PtyHandoffEntry = {
    bridgeProtocolVersion: PtyBridgeProtocolVersion,
    bridgePid,
    controlSocket: bridgeControlSocketPath(orphanBridges.directory, entry.ptyId),
    command: entry.command,
    cols: entry.cols,
    rows: entry.rows,
    ptyInstanceId: entry.ptyInstanceId,
    identity: { ...entry.identity },
    ringComplete: snapshot.complete,
  };

  await attachScrollbackExport(handoffEntry, {
    directory: orphanBridges.directory,
    ptyId: entry.ptyId,
    exportData: {
      initialCols: snapshot.initialCols,
      initialRows: snapshot.initialRows,
      complete: snapshot.complete,
      events: snapshot.events,
    },
    emit,
  });
  if (fidelity === "screen") {
    await attachScreenExport(handoffEntry, entry, orphanBridges.directory, emit);
  }
  return { kind: "entry", entry: handoffEntry };
}

async function attachScrollbackExport(
  handoffEntry: PtyHandoffEntry,
  input: {
    directory: string;
    ptyId: string;
    exportData: PtyScrollbackExport;
    emit: Emit;
  },
): Promise<void> {
  try {
    handoffEntry.scrollbackRef = await writeScrollbackExport(
      input.directory,
      input.ptyId,
      input.exportData,
    );
  } catch (error) {
    // A scrollback write failure degrades adoption replay, not adoption itself.
    input.emit("pty.handoff.scrollback-export-failed", {
      ptyId: input.ptyId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function attachScreenExport(
  handoffEntry: PtyHandoffEntry,
  entry: PtyEntry,
  directory: string,
  emit: Emit,
): Promise<void> {
  try {
    const sequences = await entry.semantic.capture();
    handoffEntry.screenSnapshotRef = await writeScreenSnapshot(directory, entry.ptyId, {
      cols: entry.cols,
      rows: entry.rows,
      sequences,
    });
  } catch (error) {
    // Screen fidelity never blocks handoff; adopter falls back to replay.
    emit("pty.handoff.screen-export-failed", {
      ptyId: entry.ptyId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function parkAndDropReleasedEntries(
  entriesByPtyId: Map<string, PtyEntry>,
  ptyIds: string[],
  deactivateEntry: (entry: PtyEntry) => void,
): { released: string[]; expectPark: string[] } {
  const released: string[] = [];
  const expectPark: string[] = [];
  for (const ptyId of ptyIds) {
    const entry = entriesByPtyId.get(ptyId);
    if (entry === undefined) {
      continue;
    }
    for (const subscription of entry.subscriptions) {
      subscription.dispose();
    }
    entry.subscriptions.length = 0;
    const willPark = entry.terminal.releaseToOrphan?.() === true;
    entry.semantic.dispose();
    deactivateEntry(entry);
    released.push(ptyId);
    if (willPark) {
      expectPark.push(ptyId);
    }
  }
  return { released, expectPark };
}

async function ensureExpectedParksReady(input: {
  expectPark: string[];
  manifest: PtyHandoffManifest;
  emit: Emit;
}): Promise<void> {
  for (const ptyId of input.expectPark) {
    const controlSocket = input.manifest[ptyId]?.controlSocket;
    if (controlSocket === undefined) {
      throw new StationHostProviderError(
        "HOST_HANDOFF_INVALID_STATE",
        `Released terminal "${ptyId}" is missing a control socket in the handoff manifest.`,
      );
    }
    const readiness = await waitForReleasedParkReady(controlSocket);
    if (readiness === "ready") {
      continue;
    }
    input.emit("pty.handoff.park-not-ready", { ptyId, readiness });
    throw new StationHostProviderError(
      "HOST_HANDOFF_INVALID_STATE",
      readiness === "park-only"
        ? `Released terminal "${ptyId}" wrote park state but never opened its control socket.`
        : `Released terminal "${ptyId}" did not park in time for live handoff.`,
    );
  }
}

function parseHandoffManifest(manifestInput: unknown): PtyHandoffManifest {
  try {
    return PtyHandoffManifestSchema.parse(manifestInput);
  } catch (error) {
    throw new StationHostProviderError(
      "HOST_HANDOFF_MANIFEST_INVALID",
      "The PTY handoff manifest is invalid.",
      { cause: error },
    );
  }
}

function preflightAdoption(
  manifest: PtyHandoffManifest,
  entriesByPtyId: ReadonlyMap<string, PtyEntry>,
  entriesByTarget: ReadonlyMap<string, PtyEntry>,
): void {
  for (const [ptyId, entry] of Object.entries(manifest)) {
    if (
      entriesByPtyId.has(ptyId) ||
      entriesByTarget.has(entry.identity.terminalTargetId)
    ) {
      throw new StationHostProviderError(
        "HOST_TARGET_CONFLICT",
        "A handoff entry conflicts with a live Host PTY id or terminal target.",
      );
    }
  }
}

type AdoptOneResult = { kind: "adopted" } | { kind: "failed"; reason: string };
type AdoptionFailureReason =
  | "ring-restore-failed"
  | "semantic-init-failed"
  | "screen-seed-failed"
  | "activation-failed";

async function adoptOneEntry(input: {
  ptyId: string;
  handoffEntry: PtyHandoffEntry;
  adoptTerminal: PtyTerminalAdopter;
  createSemanticTerminal: (cols: number, rows: number) => SemanticTerminalModel;
  maxScrollbackBytes: number;
  emit: Emit;
  activateAdoptedEntry: (init: AdoptedEntryInit) => void;
}): Promise<AdoptOneResult> {
  const { ptyId, handoffEntry, emit } = input;

  let terminal: PtyAdoptedTerminal;
  try {
    terminal = await input.adoptTerminal({
      ptyId,
      ptyInstanceId: handoffEntry.ptyInstanceId,
      bridgePid: handoffEntry.bridgePid,
      command: handoffEntry.command,
      controlSocketPath: handoffEntry.controlSocket,
      size: { cols: handoffEntry.cols, rows: handoffEntry.rows },
    });
  } catch (error) {
    // Per-entry isolation: one unreachable bridge never blocks the rest.
    failAdoptionEmit(emit, ptyId, "adopt-failed", error);
    return { kind: "failed", reason: "adopt-failed" };
  }

  const { cols, rows } = clampSize(handoffEntry.cols, handoffEntry.rows);
  let phase: AdoptionFailureReason = "ring-restore-failed";
  let semantic: SemanticTerminalModel | undefined;
  try {
    const ring = await restoreAdoptionRing({
      ptyId,
      handoffEntry,
      terminal,
      cols,
      rows,
      maxScrollbackBytes: input.maxScrollbackBytes,
      emit,
    });
    phase = "semantic-init-failed";
    semantic = input.createSemanticTerminal(cols, rows);
    phase = "screen-seed-failed";
    await seedScreenSnapshot(semantic, ptyId, handoffEntry.screenSnapshotRef, emit);
    phase = "activation-failed";
    input.activateAdoptedEntry({
      ptyId,
      ptyInstanceId: handoffEntry.ptyInstanceId,
      identity: { ...handoffEntry.identity },
      command: handoffEntry.command,
      terminal,
      ring,
      semantic,
      cols,
      rows,
    });
  } catch (error) {
    semantic?.dispose();
    try {
      terminal.releaseToOrphan();
    } catch (releaseError) {
      failAdoptionEmit(emit, ptyId, "orphan-release-failed", releaseError);
    }
    failAdoptionEmit(emit, ptyId, phase, error);
    return { kind: "failed", reason: phase };
  }
  return { kind: "adopted" };
}

async function restoreAdoptionRing(input: {
  ptyId: string;
  handoffEntry: PtyHandoffEntry;
  terminal: PtyAdoptedTerminal;
  cols: number;
  rows: number;
  maxScrollbackBytes: number;
  emit: Emit;
}): Promise<ScrollbackRing> {
  let ring: ScrollbackRing | undefined;
  let importFailed = false;
  if (input.handoffEntry.scrollbackRef !== undefined) {
    const exportData = await readScrollbackExport(input.handoffEntry.scrollbackRef);
    if (exportData !== undefined) {
      ring = ScrollbackRing.restore(input.maxScrollbackBytes, exportData);
    } else {
      importFailed = true;
      input.emit("pty.handoff.scrollback-import-failed", { ptyId: input.ptyId });
    }
  }
  if (ring === undefined) {
    ring = new ScrollbackRing(input.maxScrollbackBytes, {
      cols: input.cols,
      rows: input.rows,
    });
  }
  // Fail closed on any known gap — an evicted park backlog, an export
  // that recorded truncation, or a scrollback ref that would not read:
  // replay falls into semantic recovery, never a partial raw stream.
  if (
    input.terminal.parkedEvicted === true ||
    input.handoffEntry.ringComplete === false ||
    importFailed
  ) {
    ring.markEvicted();
  }
  return ring;
}

/** An unreadable snapshot degrades to replay; applying a decoded snapshot must succeed atomically. */
async function seedScreenSnapshot(
  semantic: SemanticTerminalModel,
  ptyId: string,
  screenSnapshotRef: string | undefined,
  emit: Emit,
): Promise<void> {
  if (screenSnapshotRef === undefined) {
    return;
  }
  const screen = await readScreenSnapshot(screenSnapshotRef);
  if (screen === undefined) {
    emit("pty.handoff.screen-import-failed", { ptyId, reason: "unreadable" });
    return;
  }
  for (const sequence of screen.sequences) {
    semantic.write(sequence);
  }
}

function failAdoptionEmit(
  emit: Emit,
  ptyId: string,
  reason: string,
  error: unknown,
): void {
  emit("pty.handoff.adopt-failed", {
    ptyId,
    reason,
    message: error instanceof Error ? error.message : String(error),
  });
}
