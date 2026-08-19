import { randomUUID } from "node:crypto";
import {
  type HostAttachAck,
  type HostAttachmentIntent,
  type HostAttachmentSource,
  type HostControlEpoch,
  type HostControlState,
  type HostExitFrame,
  type HostFrame,
  type HostListEntry,
  type HostPtyIdentity,
  type HostPtyRef,
  type HostSpawnParams,
  type HostSpawnResult,
  isSameHostPtyIdentity,
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
import {
  clampSize,
  type PtyAttachment,
  type PtyEntry,
  type PtyEntryInit,
} from "./ptyEntry.js";
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
// Settle before the Host client's five-second unary request budget.
const DEFAULT_CLOSE_TIMEOUT_MS = 4_000;

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
  /** Test seam for deterministic explicit-close settlement. */
  closeTimeoutMs?: number;
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
  /** Reuse only identical targets; failed activation frees both indexes and disposes new resources. */
  spawn(params: HostSpawnParams): PtySpawnOutcome;
  list(): HostListEntry[];
  snapshot(ptyId: string): PtySnapshot;
  /**
   * Register the live sink before capturing raw history or semantic state, so
   * output after the capture boundary is queued exactly once as live frames.
   * Ordered resize barriers preserve geometry; classified exact-capture failure
   * retains the sink and returns mode-restoring, cursor-anchoring control VT
   * with no history.
   */
  attach(
    ptyRef: HostPtyRef,
    attachmentId: string,
    intent: HostAttachmentIntent,
  ): Promise<HostAttachmentSource>;
  /** Guarded kill: resolve only after the PTY emits exit and is dropped. */
  close(ptyId: string): Promise<boolean>;
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
   * Rebind validated parked bridges transactionally. Each failed entry is
   * re-parked without killing its process, later entries continue, and no
   * failed PTY id or target remains visible; invalid manifests fail closed.
   */
  adoptRegistry(manifest: unknown): Promise<PtyAdoptionReport>;
  /** End every attachment and clear controller authority before disposing owned PTYs. */
  disposeAll(): void;
};

export function createPtyTable(options: PtyTableOptions = {}): PtyTable {
  const createTerminal = options.createTerminal ?? createLocalPtyTerminal;
  const maxScrollbackBytes = options.maxScrollbackBytes ?? DEFAULT_SCROLLBACK_BYTES;
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  const createSemanticTerminal =
    options.createSemanticTerminal ?? createSemanticTerminalSnapshot;
  const emit = options.onEvent ?? (() => undefined);
  const emitPtyExit = options.onPtyExit ?? (() => undefined);
  const orphanBridges = options.orphanBridges;
  const adoptTerminal: PtyTerminalAdopter =
    options.adoptTerminal ?? ((target) => adoptLocalPtyBridge({ id: target.ptyId, ...target }));
  const entriesByPtyId = new Map<string, PtyEntry>();
  const entriesByTarget = new Map<string, PtyEntry>();
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
    for (const attachment of [...entry.attachments.values()]) {
      attachment.sink(frame);
    }
  }

  function controlState(entry: PtyEntry, attachment: PtyAttachment): HostControlState {
    return {
      attachmentId: attachment.attachmentId,
      controlEpoch: entry.controlEpoch,
      role:
        entry.controllerAttachmentId === attachment.attachmentId ? "controller" : "viewer",
    };
  }

  function endAttachments(entry: PtyEntry): void {
    entry.controllerAttachmentId = undefined;
    const attachments = [...entry.attachments.values()];
    entry.attachments.clear();
    for (const attachment of attachments) {
      attachment.end();
    }
  }

  function detachAttachment(
    entry: PtyEntry,
    attachment: PtyAttachment,
  ): void {
    if (entry.attachments.get(attachment.attachmentId) !== attachment) {
      return;
    }
    entry.attachments.delete(attachment.attachmentId);
    if (entry.controllerAttachmentId === attachment.attachmentId) {
      entry.controllerAttachmentId = undefined;
    }
    attachment.end();
  }

  function grantControl(
    entry: PtyEntry,
    attachment: PtyAttachment,
    reason: "controller_attached" | "control_claimed",
  ): HostControlState {
    if (entry.controllerAttachmentId === attachment.attachmentId) {
      emit("pty.control.granted", {
        ptyId: entry.ptyId,
        attachmentId: attachment.attachmentId,
        controlEpoch: entry.controlEpoch,
        role: "controller",
        reason: "idempotent_reclaim",
      });
      return controlState(entry, attachment);
    }
    if (entry.controlEpoch === Number.MAX_SAFE_INTEGER) {
      throw new StationHostProviderError(
        "HOST_CONTROL_REVOKED",
        "Station Host PTY control epoch is exhausted.",
      );
    }

    const previous =
      entry.controllerAttachmentId === undefined
        ? undefined
        : entry.attachments.get(entry.controllerAttachmentId);
    entry.controlEpoch += 1;
    entry.controllerAttachmentId = attachment.attachmentId;

    // Commit the new controller and epoch before the former controller observes revocation.
    if (previous !== undefined) {
      previous.sink({
        type: "control-revoked",
        ptyId: entry.ptyId,
        attachmentId: previous.attachmentId,
        controlEpoch: entry.controlEpoch,
      });
      emit("pty.control.revoked", {
        ptyId: entry.ptyId,
        attachmentId: previous.attachmentId,
        controlEpoch: entry.controlEpoch,
        role: "viewer",
        reason,
      });
    }
    emit("pty.control.granted", {
      ptyId: entry.ptyId,
      attachmentId: attachment.attachmentId,
      controlEpoch: entry.controlEpoch,
      role: "controller",
      reason,
    });
    return controlState(entry, attachment);
  }

  function rejectMutation(
    entry: PtyEntry,
    attachment: PtyAttachment,
    presentedEpoch: HostControlEpoch,
    mutation: "write" | "resize",
  ): never {
    const registered = entry.attachments.get(attachment.attachmentId) === attachment;
    const reason =
      !registered
        ? "unknown_attachment"
        : entry.controllerAttachmentId !== attachment.attachmentId
          ? "viewer"
          : "stale_epoch";
    const attributes: Record<string, unknown> = {
      ptyId: entry.ptyId,
      attachmentId: attachment.attachmentId,
      controlEpoch: entry.controlEpoch,
      presentedEpoch,
      mutation,
      reason,
    };
    if (registered) {
      attributes.role =
        entry.controllerAttachmentId === attachment.attachmentId ? "controller" : "viewer";
    }
    emit("pty.control.rejected", attributes);
    throw new StationHostProviderError(
      "HOST_CONTROL_REVOKED",
      "Station Host rejected a mutation from a viewer or stale attachment capability.",
    );
  }

  function requireController(
    entry: PtyEntry,
    attachment: PtyAttachment,
    presentedEpoch: HostControlEpoch,
    mutation: "write" | "resize",
  ): void {
    if (
      entry.attachments.get(attachment.attachmentId) !== attachment ||
      entry.controllerAttachmentId !== attachment.attachmentId ||
      presentedEpoch !== entry.controlEpoch
    ) {
      rejectMutation(entry, attachment, presentedEpoch, mutation);
    }
  }

  function guardedResize(
    entry: PtyEntry,
    attachment: PtyAttachment,
    controlEpoch: HostControlEpoch,
    cols: number,
    rows: number,
  ): void {
    requireController(entry, attachment, controlEpoch, "resize");
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

  function deactivateEntry(entry: PtyEntry): void {
    // PTY-id and target indexes must be removed together so neither can identify a replaced lifetime.
    if (entriesByPtyId.get(entry.ptyId) === entry) {
      entriesByPtyId.delete(entry.ptyId);
    }
    if (entriesByTarget.get(entry.identity.terminalTargetId) === entry) {
      entriesByTarget.delete(entry.identity.terminalTargetId);
    }
    endAttachments(entry);
  }

  // Broadcast a terminal exit, release the terminal's resources, and drop the entry.
  function reap(entry: PtyEntry, exitFrame: HostExitFrame, reason: string): void {
    if (entry.closeTimer !== undefined) clearTimeout(entry.closeTimer);
    if (reason === "host-stop") {
      entry.closeReject?.(
        new StationHostProviderError(
          "HOST_UNREACHABLE",
          "Station Host stopped before PTY exit was confirmed.",
        ),
      );
    } else {
      entry.closeResolve?.(true);
    }
    delete entry.closePromise;
    delete entry.closeResolve;
    delete entry.closeReject;
    delete entry.closeTimer;
    publishOutput(entry, entry.outputCompatibility.flush());
    entry.exited = true;
    entry.lastExit = exitFrame;
    broadcast(entry, exitFrame);
    for (const subscription of entry.subscriptions) {
      subscription.dispose();
    }
    entry.subscriptions.length = 0;
    entry.terminal.dispose();
    entry.semantic.dispose();
    deactivateEntry(entry);
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
    const entry = entriesByPtyId.get(ptyId);
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
      controlEpoch: 0,
      attachments: new Map(),
      subscriptions: [],
    };
  }

  function activateEntry(entry: PtyEntry, event: "agent.spawn" | "agent.adopted"): void {
    if (
      entriesByPtyId.has(entry.ptyId) ||
      entriesByTarget.has(entry.identity.terminalTargetId)
    ) {
      throw new StationHostProviderError(
        "HOST_TARGET_CONFLICT",
        "A live Host PTY already owns this PTY id or terminal target.",
      );
    }
    entriesByPtyId.set(entry.ptyId, entry);
    entriesByTarget.set(entry.identity.terminalTargetId, entry);
    advanceSequencePast(entry.ptyId);
    try {
      emit(event, {
        ptyId: entry.ptyId,
        worktreeId: entry.identity.worktreeId,
        sessionId: entry.identity.sessionId,
        terminalTargetId: entry.identity.terminalTargetId,
      });
      const dataSubscription = entry.terminal.onData((data) => {
        transformAndPublish(entry, data);
      });
      if (entry.exited) {
        dataSubscription.dispose();
      } else {
        entry.subscriptions.push(dataSubscription);
      }
      const exitSubscription = entry.terminal.onExit((exitEvent) => {
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
      });
      if (entry.exited) {
        exitSubscription.dispose();
      } else {
        entry.subscriptions.push(exitSubscription);
      }
    } catch (error) {
      for (const subscription of entry.subscriptions) {
        subscription.dispose();
      }
      entry.subscriptions.length = 0;
      // Retained exit replay can fail mid-subscription, so rollback both indexes together.
      deactivateEntry(entry);
      throw error;
    }
  }

  const handoff = createPtyHandoff({
    entriesByPtyId,
    entriesByTarget,
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
    deactivateEntry,
  });

  return {
    spawn(params) {
      const identity = identityOf(params);
      const existing = entriesByTarget.get(params.terminalTargetId);
      if (existing !== undefined && !existing.exited) {
        if (isSameHostPtyIdentity(existing.identity, identity)) {
          return {
            terminalTargetId: existing.identity.terminalTargetId,
            ptyId: existing.ptyId,
            ptyInstanceId: existing.ptyInstanceId,
            pid: existing.terminal.pid,
            created: false,
          };
        }
        throw new StationHostProviderError(
          "HOST_TARGET_CONFLICT",
          "A live Host PTY already owns this terminal target with a different immutable identity.",
          { worktreeId: params.worktreeId, sessionId: params.sessionId },
        );
      }

      const { cols, rows } = clampSize(params.cols, params.rows);
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
      const ptyInstanceId = `ptyi_${randomUUID()}`;
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
          ptyInstanceId,
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
        ptyInstanceId,
        identity,
        command: params.command,
        terminal,
        ring: new ScrollbackRing(maxScrollbackBytes, { cols, rows }),
        semantic,
        outputCompatibility: createPtyOutputCompatibility(params.outputCompatibility),
        cols,
        rows,
      });
      try {
        activateEntry(entry, "agent.spawn");
      } catch (error) {
        semantic.dispose();
        terminal.dispose();
        throw new StationHostProviderError(
          "HOST_SPAWN_FAILED",
          "Could not activate the host PTY.",
          { cause: error, worktreeId: params.worktreeId, sessionId: params.sessionId },
        );
      }

      // pid stabilizes to PTY's child once bridge reports ready; host.list is authoritative.
      return {
        terminalTargetId: entry.identity.terminalTargetId,
        ptyId: entry.ptyId,
        ptyInstanceId: entry.ptyInstanceId,
        pid: terminal.pid,
        created: true,
      };
    },

    list() {
      const list: HostListEntry[] = [];
      for (const entry of entriesByPtyId.values()) {
        list.push({
          ...entry.identity,
          ptyId: entry.ptyId,
          ptyInstanceId: entry.ptyInstanceId,
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

    async attach(ptyRef, attachmentId, intent) {
      const byPtyId = entriesByPtyId.get(ptyRef.ptyId);
      const byTarget = entriesByTarget.get(ptyRef.terminalTargetId);
      if (byPtyId === undefined && byTarget === undefined) {
        // Attach-specific code: the agent the client expected is gone. A
        // first-class diagnosable failure, never a silent fall-through to respawn.
        throw new StationHostProviderError(
          "HOST_ATTACH_GONE",
          `No host PTY "${ptyRef.ptyId}" to attach to.`,
        );
      }
      if (
        byPtyId === undefined ||
        byTarget === undefined ||
        byPtyId !== byTarget ||
        byPtyId.ptyInstanceId !== ptyRef.ptyInstanceId
      ) {
        throw new StationHostProviderError(
          "HOST_ATTACHMENT_MISMATCH",
          "The requested Host PTY reference no longer identifies one live PTY lifetime.",
        );
      }
      const entry = byPtyId;
      if (entry.attachments.has(attachmentId)) {
        throw new StationHostProviderError(
          "HOST_ATTACHMENT_MISMATCH",
          "Station Host issued a duplicate attachment identity for this PTY.",
        );
      }
      let attachment: PtyAttachment;
      const stream = createFrameStream(() => {
        detachAttachment(entry, attachment);
      });
      attachment = {
        attachmentId,
        sink: (frame) => {
          stream.push(frame);
          if (frame.type === "exit") {
            stream.end();
          }
        },
        end: stream.end,
      };
      entry.attachments.set(attachmentId, attachment);

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
          if (entry.exited || !entriesByPtyId.has(ptyRef.ptyId)) {
            detachAttachment(entry, attachment);
            throw new StationHostProviderError(
              "HOST_ATTACH_GONE",
              `Host PTY "${ptyRef.ptyId}" exited while its snapshot was captured.`,
              { cause: error },
            );
          }
          if (error instanceof TerminalSnapshotUnavailableError) {
            const failure = terminalSnapshotFailure(error);
            emit("pty.snapshot.degraded", { ptyId: ptyRef.ptyId, ...failure });
            replay = {
              kind: "live-reset-recovery",
              initialCols: recorded.cols,
              initialRows: recorded.rows,
              events: [],
              resetData: error.resetData,
            };
          } else {
            detachAttachment(entry, attachment);
            const pending = error instanceof TerminalSnapshotPendingError;
            throw new StationHostProviderError(
              pending ? "HOST_SNAPSHOT_PENDING" : "HOST_SNAPSHOT_FAILED",
              pending
                ? `Host PTY "${ptyRef.ptyId}" ended between terminal parser boundaries; retrying may succeed after more output.`
                : `Could not capture terminal state for host PTY "${ptyRef.ptyId}".`,
              { cause: error },
            );
          }
        }
      }
      let state: HostControlState;
      try {
        state =
          intent === "controller"
            ? grantControl(entry, attachment, "controller_attached")
            : controlState(entry, attachment);
      } catch (error) {
        detachAttachment(entry, attachment);
        throw error;
      }
      const ack: HostAttachAck = {
        subscribed: true,
        ...state,
        ...entry.identity,
        ptyId: entry.ptyId,
        ptyInstanceId: entry.ptyInstanceId,
        pid: recorded.pid,
        cols: recorded.cols,
        rows: recorded.rows,
        exited: false,
        replay,
      };
      return {
        ack,
        frames: stream.frames,
        captureDurationMs,
        get controlState() {
          return controlState(entry, attachment);
        },
        claimControl: () => grantControl(entry, attachment, "control_claimed"),
        write: (controlEpoch, data) => {
          requireController(entry, attachment, controlEpoch, "write");
          entry.terminal.write(data);
        },
        resize: (controlEpoch, cols, rows) => {
          guardedResize(entry, attachment, controlEpoch, cols, rows);
        },
      };
    },

    async close(ptyId) {
      const entry = entriesByPtyId.get(ptyId);
      if (entry === undefined) return false;
      if (entry.closePromise !== undefined) return entry.closePromise;

      const closePromise = new Promise<boolean>((resolve, reject) => {
        entry.closeResolve = resolve;
        entry.closeReject = reject;
      });
      entry.closePromise = closePromise;
      entry.closeTimer = setTimeout(() => {
        const error = new StationHostProviderError(
          "HOST_PTY_CLOSE_TIMEOUT",
          `Timed out waiting for Host PTY "${ptyId}" to exit.`,
        );
        entry.closeReject?.(error);
        delete entry.closePromise;
        delete entry.closeResolve;
        delete entry.closeReject;
        delete entry.closeTimer;
      }, closeTimeoutMs);
      entry.closeTimer.unref?.();
      try {
        entry.terminal.kill();
      } catch (error) {
        if (entry.closeTimer !== undefined) clearTimeout(entry.closeTimer);
        entry.closeReject?.(error);
        delete entry.closePromise;
        delete entry.closeResolve;
        delete entry.closeReject;
        delete entry.closeTimer;
      }
      return closePromise;
    },

    focus(ptyId) {
      const entry = entriesByPtyId.get(ptyId);
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
      return entriesByPtyId.has(ptyId);
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
      for (const entry of [...entriesByPtyId.values()]) {
        reap(entry, { type: "exit", ptyId: entry.ptyId, exitCode: 0 }, "host-stop");
      }
    },
  };
}
