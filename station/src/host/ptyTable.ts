import {
  type HostAttachAck,
  type HostAttachmentSource,
  type HostExitFrame,
  type HostFrame,
  type HostListEntry,
  type HostPtyIdentity,
  type HostSpawnParams,
  type HostSpawnResult,
  StationHostProviderError,
} from "@station/host";
import type { HostHandoffFidelity, PtyHandoffManifest } from "@station/contracts";
import { adoptLocalPtyBridge } from "../terminal/pty/ptyBridgeAdoption.js";
import { createLocalPtyTerminal } from "../terminal/pty/localPtyTerminal.js";
import type {
  StationTerminalProcess,
  StationTerminalSpawnOptions,
} from "../terminal/types.js";
import { createPtyOutputCompatibility } from "../terminal/ptyOutputCompatibility.js";
import { createFrameStream } from "./frameStream.js";
import {
  DEFAULT_ORPHAN_TTL_MS,
  bridgeControlSocketPath,
  bridgeParkStatePath,
} from "./orphanBridges.js";
import { clampSize, type PtyEntry, type PtyEntryInit } from "./ptyEntry.js";
import {
  createPtyHandoff,
  type PtyAdoptionReport,
  type PtyHandoffReleaseReport,
  type PtyTableOrphanOptions,
  type PtyTerminalAdopter,
} from "./ptyHandoff.js";
import { ScrollbackRing } from "./scrollbackRing.js";
import {
  createSemanticTerminalSnapshot,
  type SemanticTerminalModel,
  terminalSnapshotFailure,
  TerminalSnapshotPendingError,
  TerminalSnapshotUnavailableError,
} from "./semanticTerminalSnapshot.js";

export type {
  PtyAdoptedTerminal,
  PtyAdoptionTarget,
  PtyHandoffReleaseReport,
  PtyTableOrphanOptions,
  PtyTerminalAdopter,
} from "./ptyHandoff.js";

const DEFAULT_SCROLLBACK_BYTES = 256 * 1024;

export type PtyTableOptions = {
  /** Test seam: inject a fake terminal so unit tests need no real node-pty. */
  createTerminal?: (options: StationTerminalSpawnOptions) => StationTerminalProcess;
  maxScrollbackBytes?: number;
  /** Test seam for deterministic capture barriers and serializer failures. */
  createSemanticTerminal?: (cols: number, rows: number) => SemanticTerminalModel;
  /** Operational observability — safe identifiers, classifications, and counts; never PTY data/env. */
  onEvent?: (event: string, attributes: Record<string, unknown>) => void;
  /** Typed PTY exit boundary, separate from the legacy operational event stream. */
  onPtyExit?: (event: PtyExitEvent) => void;
  /** Enables bridge orphan mode: parked bridges live under this directory until adopted or TTL-reaped. */
  orphanBridges?: PtyTableOrphanOptions;
  /** Test seam for adoption without real control sockets; defaults to the bridge adopter. */
  adoptTerminal?: PtyTerminalAdopter;
};

export type PtySpawnOutcome = HostSpawnResult & { created: boolean };

export type PtyExitEvent = {
  ptyId: string;
  ptyKind: HostPtyIdentity["kind"];
  exitCode: number | null;
  signal?: number | null;
};

/** Raw-ring diagnostic used by Host tests; wire replay is chosen asynchronously by attach. */
export type PtySnapshot = {
  pid: number;
  cols: number;
  rows: number;
  exited: boolean;
  rawChunks: string[];
  rawComplete: boolean;
};

export type PtyTable = {
  spawn(params: HostSpawnParams): PtySpawnOutcome;
  write(ptyId: string, data: string): void;
  resize(ptyId: string, cols: number, rows: number): void;
  list(): HostListEntry[];
  snapshot(ptyId: string): PtySnapshot;
  /**
   * Register the live sink before capturing raw history or semantic state, so
   * output after the capture boundary is queued exactly once as live frames.
   * Ordered resize barriers preserve geometry; classified exact-capture failure
   * retains the sink and returns mode-restoring, cursor-anchoring control VT
   * with no history.
   */
  attach(ptyId: string): Promise<HostAttachmentSource>;
  /** Guarded kill: dispose the PTY, broadcast exit to attached clients, drop it. */
  close(ptyId: string): boolean;
  /** Best-effort focus: broadcast a focus frame to attached clients. */
  focus(ptyId: string): boolean;
  has(ptyId: string): boolean;
  /**
   * Capture every live PTY as a handoff manifest entry, persisting each
   * scrollback ring beside its parked bridge so an adopter can restore replay.
   * Non-bridge transports are skipped with an event, never failed.
   */
  exportRegistry(fidelity?: HostHandoffFidelity): Promise<PtyHandoffManifest>;
  /**
   * Export then park each bridge without SIGTERM and drop local ownership so a
   * negotiated completeHandoff can exit without disposeAll.
   */
  releaseRegistryForHandoff(fidelity: HostHandoffFidelity): Promise<PtyHandoffReleaseReport>;
  /**
   * ADAPTER
   *
   * Rebind the parked bridges named by a validated manifest as live entries so
   * this host serves them without respawning; per-entry failures are reported,
   * never thrown, and an invalid manifest fails closed.
   */
  adoptRegistry(manifest: unknown): Promise<PtyAdoptionReport>;
  disposeAll(): void;
};

export function createPtyTable(options: PtyTableOptions = {}): PtyTable {
  const createTerminal = options.createTerminal ?? createLocalPtyTerminal;
  const maxScrollbackBytes = options.maxScrollbackBytes ?? DEFAULT_SCROLLBACK_BYTES;
  const createSemanticTerminal =
    options.createSemanticTerminal ?? createSemanticTerminalSnapshot;
  const emit = options.onEvent ?? (() => undefined);
  const emitPtyExit = options.onPtyExit ?? (() => undefined);
  const orphanBridges = options.orphanBridges;
  const adoptTerminal: PtyTerminalAdopter =
    options.adoptTerminal ?? ((target) => adoptLocalPtyBridge({ id: target.ptyId, ...target }));
  const entries = new Map<string, PtyEntry>();
  let sequence = 0;

  function identityOf(params: HostSpawnParams): HostPtyIdentity {
    return {
      // `kind` distinguishes UI-owned aux shells from agents; it must round-trip
      // through host.list so the observer can exclude aux and the UI can warm-
      // reattach them. Defaulted to "agent" by the schema for pre-kind spawns.
      kind: params.kind,
      terminalTargetId: params.terminalTargetId,
      worktreeId: params.worktreeId,
      projectId: params.projectId,
      sessionId: params.sessionId,
      worktreePath: params.worktreePath,
      harnessProvider: params.harnessProvider,
    };
  }

  function broadcast(entry: PtyEntry, frame: HostFrame): void {
    for (const sink of [...entry.sinks]) {
      sink(frame);
    }
  }

  function publishOutput(entry: PtyEntry, data: string): void {
    if (data.length === 0) {
      return;
    }
    // Keep raw completeness, semantic state, and live delivery on one transformed byte stream.
    entry.ring.push(data);
    entry.semantic.write(data);
    broadcast(entry, { type: "data", ptyId: entry.ptyId, data });
  }

  function transformAndPublish(entry: PtyEntry, data: string): void {
    const transformed = entry.outputCompatibility.transform(data, entry.rows);
    // Transform before storage and broadcast so replay and live clients consume identical bytes.
    publishOutput(entry, transformed.data);
    if (transformed.rewriteCount > 0 && !entry.compatibilityRewriteReported) {
      entry.compatibilityRewriteReported = true;
      emit("pty.output.compatibility-rewrite", {
        ptyId: entry.ptyId,
        policy: "top-region-scrollback",
        count: transformed.rewriteCount,
      });
    }
  }

  // Broadcast a terminal exit, release the terminal's resources, and DROP the
  // entry. Used by natural exit, guarded close, and shutdown — so the host never
  // accumulates dead entries (each retaining its scrollback ring) and a re-spawn
  // for a worktree never finds a stale exited entry under the same target id.
  function reap(entry: PtyEntry, exitFrame: HostExitFrame, reason: string): void {
    publishOutput(entry, entry.outputCompatibility.flush());
    entry.exited = true;
    entry.lastExit = exitFrame;
    broadcast(entry, exitFrame);
    for (const subscription of entry.subscriptions) {
      subscription.dispose();
    }
    entry.terminal.dispose();
    entry.semantic.dispose();
    entries.delete(entry.ptyId);
    const exitEvent: PtyExitEvent = {
      ptyId: entry.ptyId,
      ptyKind: entry.identity.kind,
      exitCode: exitFrame.exitCode,
    };
    if (exitFrame.signal !== undefined) {
      exitEvent.signal = exitFrame.signal;
    }
    emitPtyExit(exitEvent);
    emit("agent.exit", {
      ptyId: entry.ptyId,
      exitCode: exitFrame.exitCode,
      reason,
      ...(exitFrame.signal === undefined ? {} : { signal: exitFrame.signal }),
    });
  }

  function requireEntry(ptyId: string): PtyEntry {
    const entry = entries.get(ptyId);
    if (entry === undefined) {
      throw new StationHostProviderError("HOST_PTY_NOT_FOUND", `No host PTY "${ptyId}".`);
    }
    return entry;
  }

  // Adopted ids keep the old host's numbering; later spawns must not collide.
  function advanceSequencePast(ptyId: string): void {
    const match = /^pty-(\d+)$/.exec(ptyId);
    if (match === null) {
      return;
    }
    const adopted = Number.parseInt(match[1], 10);
    if (Number.isInteger(adopted) && adopted > sequence) {
      sequence = adopted;
    }
  }

  function buildPtyEntry(init: PtyEntryInit): PtyEntry {
    const { cols, rows } = clampSize(init.cols, init.rows);
    return {
      ...init,
      cols,
      rows,
      compatibilityRewriteReported: false,
      exited: false,
      sinks: new Set(),
      subscriptions: [],
    };
  }

  // Retained data/exit may replay synchronously during subscription, so the
  // entry and its lifecycle event must exist before a replay can reap it.
  function activateEntry(entry: PtyEntry, event: "agent.spawn" | "agent.adopted"): void {
    entries.set(entry.ptyId, entry);
    advanceSequencePast(entry.ptyId);
    emit(event, {
      ptyId: entry.ptyId,
      worktreeId: entry.identity.worktreeId,
      sessionId: entry.identity.sessionId,
      terminalTargetId: entry.identity.terminalTargetId,
    });
    entry.subscriptions.push(
      entry.terminal.onData((data) => {
        transformAndPublish(entry, data);
      }),
    );
    entry.subscriptions.push(
      entry.terminal.onExit((exitEvent) => {
        reap(
          entry,
          {
            type: "exit",
            ptyId: entry.ptyId,
            exitCode: exitEvent.exitCode,
            ...(exitEvent.signal === undefined ? {} : { signal: exitEvent.signal }),
          },
          "exit",
        );
      }),
    );
  }

  const handoff = createPtyHandoff({
    entries,
    orphanBridges,
    adoptTerminal,
    createSemanticTerminal,
    maxScrollbackBytes,
    emit,
    activateAdoptedEntry: (init) => {
      // Adopted entries lose the launch-time output-compatibility policy;
      // they serve bytes exactly as parked and live from here on.
      activateEntry(
        buildPtyEntry({
          ...init,
          outputCompatibility: createPtyOutputCompatibility(undefined),
        }),
        "agent.adopted",
      );
    },
  });

  return {
    spawn(params) {
      // Idempotency is session-qualified: deterministic target ids are reused
      // across generations, but a newer session must never attach to the old PTY.
      for (const existing of entries.values()) {
        if (!existing.exited && existing.identity.terminalTargetId === params.terminalTargetId) {
          if (existing.identity.sessionId === params.sessionId) {
            return { ptyId: existing.ptyId, pid: existing.terminal.pid, created: false };
          }
          throw new StationHostProviderError(
            "HOST_TARGET_SESSION_CONFLICT",
            "A live host PTY already owns this terminal target for another session.",
            { worktreeId: params.worktreeId, sessionId: params.sessionId },
          );
        }
      }

      const { cols, rows } = clampSize(params.cols, params.rows);
      const identity = identityOf(params);
      const env: Record<string, string | undefined> = {
        ...params.env,
        // A Host may inherit styling controls from a headless provider hook, so only launch-request values are authoritative for its PTYs.
        FORCE_COLOR: params.env?.FORCE_COLOR,
        NO_COLOR: params.env?.NO_COLOR,
        // A persistent Host can outlive or reattach through renderers, so no inherited or launch-plan tmux pair is authoritative.
        TMUX: undefined,
        TMUX_PANE: undefined,
      };
      // The ptyId must exist before spawn: orphan-mode bridges name their
      // control socket and park state after it.
      sequence += 1;
      const ptyId = `pty-${sequence}`;
      const spawnOptions: StationTerminalSpawnOptions = {
        id: ptyId,
        command: params.command,
        args: params.args,
        cwd: params.cwd,
        env,
        size: { cols, rows },
      };
      if (orphanBridges !== undefined) {
        spawnOptions.orphan = {
          controlSocketPath: bridgeControlSocketPath(orphanBridges.directory, ptyId),
          parkStatePath: bridgeParkStatePath(orphanBridges.directory, ptyId),
          ttlMs: orphanBridges.ttlMs ?? DEFAULT_ORPHAN_TTL_MS,
          identity,
          parkMaxBytes: maxScrollbackBytes,
        };
      }
      let terminal: StationTerminalProcess;
      try {
        terminal = createTerminal(spawnOptions);
      } catch (error) {
        throw new StationHostProviderError(
          "HOST_SPAWN_FAILED",
          error instanceof Error ? error.message : "Could not spawn the host PTY.",
          {
            cause: error,
            worktreeId: params.worktreeId,
            sessionId: params.sessionId,
          },
        );
      }

      let semantic: SemanticTerminalModel;
      try {
        semantic = createSemanticTerminal(cols, rows);
      } catch (error) {
        terminal.dispose();
        throw new StationHostProviderError(
          "HOST_SPAWN_FAILED",
          "Could not initialize semantic terminal recovery.",
          { cause: error, worktreeId: params.worktreeId, sessionId: params.sessionId },
        );
      }
      const entry = buildPtyEntry({
        ptyId,
        identity,
        command: params.command,
        terminal,
        ring: new ScrollbackRing(maxScrollbackBytes, { cols, rows }),
        semantic,
        outputCompatibility: createPtyOutputCompatibility(params.outputCompatibility),
        cols,
        rows,
      });
      activateEntry(entry, "agent.spawn");

      // pid stabilizes to PTY's child once bridge reports ready; host.list is authoritative.
      return { ptyId: entry.ptyId, pid: terminal.pid, created: true };
    },

    write(ptyId, data) {
      requireEntry(ptyId).terminal.write(data);
    },

    resize(ptyId, cols, rows) {
      const entry = requireEntry(ptyId);
      // A compatibility parser may retain an incomplete pre-resize sequence;
      // publish it before the geometry barrier so its production order survives.
      publishOutput(entry, entry.outputCompatibility.flush());
      const size = clampSize(cols, rows);
      entry.cols = size.cols;
      entry.rows = size.rows;
      entry.ring.resize(size);
      entry.semantic.resize(size.cols, size.rows);
      // Publish first so output synchronously triggered by TIOCSWINSZ is ordered
      // after the geometry it was produced for on every attachment.
      broadcast(entry, {
        type: "resize",
        ptyId: entry.ptyId,
        cols: entry.cols,
        rows: entry.rows,
      });
      entry.terminal.resize(size);
    },

    list() {
      const list: HostListEntry[] = [];
      for (const entry of entries.values()) {
        list.push({
          ...entry.identity,
          ptyId: entry.ptyId,
          pid: entry.terminal.pid,
          alive: !entry.exited,
          cols: entry.cols,
          rows: entry.rows,
        });
      }
      return list;
    },

    snapshot(ptyId) {
      const entry = requireEntry(ptyId);
      const raw = entry.ring.snapshot();
      return {
        pid: entry.terminal.pid,
        cols: entry.cols,
        rows: entry.rows,
        exited: entry.exited,
        rawChunks: raw.events.flatMap((event) =>
          event.type === "data" ? [event.data] : [],
        ),
        rawComplete: raw.complete,
      };
    },

    async attach(ptyId) {
      const entry = entries.get(ptyId);
      if (entry === undefined) {
        // Attach-specific code: the agent the client expected is gone. A
        // first-class diagnosable failure, never a silent fall-through to respawn.
        throw new StationHostProviderError(
          "HOST_ATTACH_GONE",
          `No host PTY "${ptyId}" to attach to.`,
        );
      }
      let sink: ((frame: HostFrame) => void) | undefined;
      const stream = createFrameStream(() => {
        if (sink !== undefined) {
          entry.sinks.delete(sink);
        }
      });
      sink = (frame) => {
        stream.push(frame);
        if (frame.type === "exit") {
          stream.end();
        }
      };
      entry.sinks.add(sink);

      const raw = entry.ring.snapshot();
      const recorded = {
        cols: entry.cols,
        rows: entry.rows,
        pid: entry.terminal.pid,
      };
      const captureStartedAt = performance.now();
      let replay: HostAttachAck["replay"];
      let captureDurationMs = 0;
      if (raw.complete) {
        replay = {
          kind: "raw-complete",
          initialCols: raw.initialCols,
          initialRows: raw.initialRows,
          events: raw.events,
        };
      } else {
        // Incomplete raw bytes are not a terminal state and must never cross the wire.
        try {
          replay = {
            kind: "semantic-truncation-recovery",
            initialCols: recorded.cols,
            initialRows: recorded.rows,
            events: (await entry.semantic.capture()).map((data) => ({ type: "data", data })),
          };
          captureDurationMs = performance.now() - captureStartedAt;
        } catch (error) {
          captureDurationMs = performance.now() - captureStartedAt;
          if (entry.exited || !entries.has(ptyId)) {
            if (sink !== undefined) {
              entry.sinks.delete(sink);
            }
            stream.end();
            throw new StationHostProviderError(
              "HOST_ATTACH_GONE",
              `Host PTY "${ptyId}" exited while its snapshot was captured.`,
              { cause: error },
            );
          }
          if (error instanceof TerminalSnapshotUnavailableError) {
            const failure = terminalSnapshotFailure(error);
            emit("pty.snapshot.degraded", { ptyId, ...failure });
            replay = {
              kind: "live-reset-recovery",
              initialCols: recorded.cols,
              initialRows: recorded.rows,
              events: [],
              resetData: error.resetData,
            };
          } else {
            if (sink !== undefined) {
              entry.sinks.delete(sink);
            }
            stream.end();
            const pending = error instanceof TerminalSnapshotPendingError;
            throw new StationHostProviderError(
              pending ? "HOST_SNAPSHOT_PENDING" : "HOST_SNAPSHOT_FAILED",
              pending
                ? `Host PTY "${ptyId}" ended between terminal parser boundaries; retrying may succeed after more output.`
                : `Could not capture terminal state for host PTY "${ptyId}".`,
              { cause: error },
            );
          }
        }
      }
      const ack: HostAttachAck = {
        subscribed: true,
        ptyId: entry.ptyId,
        pid: recorded.pid,
        cols: recorded.cols,
        rows: recorded.rows,
        exited: false,
        replay,
      };
      return { ack, frames: stream.frames, captureDurationMs };
    },

    close(ptyId) {
      const entry = entries.get(ptyId);
      if (entry === undefined) {
        return false;
      }
      reap(entry, { type: "exit", ptyId: entry.ptyId, exitCode: 0 }, "close");
      return true;
    },

    focus(ptyId) {
      const entry = entries.get(ptyId);
      if (entry === undefined) {
        return false;
      }
      // Best-effort: ask attached clients to surface this pane. With no client
      // attached it is a no-op; the observer's focusTarget does not depend on it.
      broadcast(entry, { type: "focus", ptyId: entry.ptyId });
      emit("agent.focus", { ptyId: entry.ptyId });
      return true;
    },

    has(ptyId) {
      return entries.has(ptyId);
    },

    exportRegistry(fidelity) {
      return handoff.exportRegistry(fidelity);
    },

    releaseRegistryForHandoff(fidelity) {
      return handoff.releaseRegistryForHandoff(fidelity);
    },

    adoptRegistry(manifest) {
      return handoff.adoptRegistry(manifest);
    },

    disposeAll() {
      // Reap each (broadcast exit → attached streams end → dispose → drop) so a
      // shutdown never leaves a client's frame iterator hanging.
      for (const entry of [...entries.values()]) {
        reap(entry, { type: "exit", ptyId: entry.ptyId, exitCode: 0 }, "host-stop");
      }
    },
  };
}
