import { randomUUID } from "node:crypto";
import type { TerminalTargetId } from "@station/contracts";
import {
  nativePlacementSocketPath,
  startNativePlacementProtocolServer,
  type NativePlacementPaneProof,
  type NativePlacementRequest,
  type NativePlacementSourceProof,
  type NativePlacementValue,
} from "@station/terminal";
import type { StationStore } from "./state/store.js";
import {
  agentWorktreePaneId,
  type AgentIdentity,
  type PaneId,
} from "./state/types.js";
import type { HostAttachedTerminalOptions } from "./terminal/pty/hostAttachedTerminal.js";
import type { PtyRegistry, PtyRegistryEntry } from "./terminal/registry/ptyRegistry.js";
import type { StationTerminalProcess } from "./terminal/types.js";

type NativePlacementRegistry = Pick<
  PtyRegistry,
  "dispose" | "resetUnstarted" | "resize" | "terminate"
> & {
  ensure(...args: Parameters<PtyRegistry["ensure"]>): PtyRegistryEntry;
  get(paneId: PaneId): PtyRegistryEntry | undefined;
  entries(): readonly PtyRegistryEntry[];
};

type NativePlacementHandler = {
  generation: string;
  store: StationStore;
  registry: NativePlacementRegistry;
  createHostTerminal(options: HostAttachedTerminalOptions): StationTerminalProcess;
};

type NativeReservation = {
  handlerGeneration: string;
  paneId: PaneId;
  identity: AgentIdentity;
  sourceViewport: { cols: number; rows: number };
  entry: PtyRegistryEntry;
  committed: boolean;
  hostBacked?: boolean;
};

const NATIVE_PLACEMENT_RESERVATION_CAPACITY = 256;

export type StationNativePlacementEndpoint = {
  readonly uiRunId: string;
  readonly socketPath: string;
  attach(input: Omit<NativePlacementHandler, "generation">): string;
  suspend(generation: string): void;
  close(): Promise<void>;
  abandon(): void;
};

/**
 * ADAPTER
 *
 * Owns one native renderer's private placement endpoint. Compatible HMR keeps
 * the socket but replaces its handler generation, invalidating older authority.
 */
export async function createStationNativePlacementEndpoint(options: {
  stateDir: string;
  uiRunId: string;
}): Promise<StationNativePlacementEndpoint> {
  let handler: NativePlacementHandler | undefined;
  const reservations = new Map<string, NativeReservation>();
  const socketPath = nativePlacementSocketPath(options.stateDir, options.uiRunId);
  const server = await startNativePlacementProtocolServer({
    socketPath,
    handle: async (request) => handleRequest(request),
  });

  const currentHandler = (): NativePlacementHandler => {
    if (handler === undefined) throw placementRejected("Native renderer is between generations.");
    return handler;
  };

  const snapshot = (active: NativePlacementHandler): NativePlacementValue => {
    pruneAbsentReservations(active, reservations);
    return {
      type: "snapshot",
      snapshot: {
        uiRunId: options.uiRunId,
        handlerGeneration: active.generation,
        rendererPid: process.pid,
        panes: active.registry.entries().flatMap((entry) => {
          const terminal = entry.terminal;
          if (terminal === null || entry.exited || terminal.pid <= 0) return [];
          const pane = active.store
            .getState()
            .workspace.panes.find((candidate) => candidate.id === entry.paneId);
          if (pane === undefined) return [];
          const proof: NativePlacementPaneProof = {
            paneId: entry.paneId,
            entryGeneration: entry.generation,
            terminalPid: terminal.pid,
          };
          if (pane.agentIdentity !== undefined) {
            proof.terminalTargetId = pane.agentIdentity.terminalTargetId as TerminalTargetId;
          }
          if (terminal.hostPtyRef !== undefined) proof.hostPtyRef = terminal.hostPtyRef;
          return [proof];
        }),
      },
    };
  };

  const handleRequest = async (request: NativePlacementRequest): Promise<NativePlacementValue> => {
    const active = currentHandler();
    switch (request.type) {
      case "snapshot":
        return snapshot(active);
      case "reserve":
        return reserve(active, request);
      case "commit":
        return commit(active, request);
      case "finalize":
        return finalize(active, request.bindingToken);
      case "release":
        return release(active, request.bindingToken);
    }
  };

  const reserve = (
    active: NativePlacementHandler,
    request: Extract<NativePlacementRequest, { type: "reserve" }>,
  ): NativePlacementValue => {
    pruneAbsentReservations(active, reservations);
    assertSourceCurrent(active, request.source);
    if (reservations.has(request.bindingToken)) {
      throw placementRejected("Native placement binding is already reserved.");
    }
    if (reservations.size >= NATIVE_PLACEMENT_RESERVATION_CAPACITY) {
      throw placementRejected("Native renderer placement capacity is exhausted.");
    }
    const paneId = agentWorktreePaneId(request.target.worktreeId);
    if (active.store.getState().workspace.panes.some((pane) => pane.id === paneId)) {
      throw placementRejected("The native destination pane already exists.");
    }
    if (active.registry.get(paneId) !== undefined) {
      throw placementRejected("The native destination registry entry already exists.");
    }
    const sourceViewport = currentSourceViewport(active, request.source);
    const identity: AgentIdentity = {
      sessionId: request.target.sessionId,
      terminalTargetId: request.target.terminalTargetId,
      terminalBindingToken: request.bindingToken,
      harnessProvider: request.target.harnessProvider,
    };
    const entry = active.registry.ensure(paneId);
    reservations.set(request.bindingToken, {
      handlerGeneration: active.generation,
      paneId,
      identity,
      sourceViewport,
      entry,
      committed: false,
    });
    active.store.actions.createPane(paneId, {
      role: "primary-agent",
      worktreeId: request.target.worktreeId,
      activate: false,
    });
    active.store.actions.setPrimaryAgent(paneId, identity);
    if (!paneMatches(active.store, paneId, identity)) {
      throw cleanupUncertain("Native renderer could not prove the reserved pane identity.");
    }
    return { type: "reserved", paneId };
  };

  const commit = (
    active: NativePlacementHandler,
    request: Extract<NativePlacementRequest, { type: "commit" }>,
  ): NativePlacementValue => {
    const reservation = requireReservation(active, request.bindingToken, reservations);
    if (reservation.committed) {
      const terminal = reservation.entry.terminal;
      if (
        active.registry.get(reservation.paneId) === reservation.entry &&
        terminal !== null &&
        terminal.pid > 0
      ) {
        return {
          type: "committed",
          paneId: reservation.paneId,
          entryGeneration: reservation.entry.generation,
          terminalPid: terminal.pid,
        };
      }
      throw cleanupUncertain("Native placed process acknowledgement was superseded.");
    }
    const spawnOptions = {
      command: request.launch.command,
      args: request.launch.args,
      ...(request.launch.cwd === undefined ? {} : { cwd: request.launch.cwd }),
      ...(request.launch.env === undefined ? {} : { env: request.launch.env }),
      ...(request.launch.outputCompatibility === undefined
        ? {}
        : { outputCompatibility: request.launch.outputCompatibility }),
    };
    const host = request.host;
    const createTerminal =
      host === undefined
        ? undefined
        : () =>
            active.createHostTerminal({
              hostSocketPath: host.socketPath,
              ptyRef: host.ptyRef,
              size: reservation.sourceViewport,
            });
    const reset = active.registry.resetUnstarted(
      reservation.entry,
      spawnOptions,
      createTerminal,
    );
    if (reset.kind !== "reset") {
      throw cleanupUncertain("Native reserved PTY started or changed before commit.");
    }
    const entry = reset.entry;
    reservation.entry = entry;
    reservation.hostBacked = request.host !== undefined;
    active.store.actions.setPrimaryAgent(reservation.paneId, {
      ...reservation.identity,
      processOwner: request.host === undefined ? "ui" : "host",
    });
    active.registry.resize(reservation.paneId, reservation.sourceViewport);
    const terminal = entry.terminal;
    if (
      active.registry.get(reservation.paneId) !== entry ||
      terminal === null ||
      terminal.pid <= 0 ||
      !paneMatches(active.store, reservation.paneId, reservation.identity)
    ) {
      throw cleanupUncertain("Native renderer could not prove the committed placed process.");
    }
    reservation.committed = true;
    return {
      type: "committed",
      paneId: reservation.paneId,
      entryGeneration: entry.generation,
      terminalPid: terminal.pid,
    };
  };

  const finalize = (
    active: NativePlacementHandler,
    bindingToken: string,
  ): NativePlacementValue => {
    const reservation = reservations.get(bindingToken);
    if (reservation === undefined) {
      return { type: "finalized", status: "already-finalized" };
    }
    const current = requireReservation(active, bindingToken, reservations);
    const terminal = current.entry.terminal;
    if (
      !current.committed ||
      active.registry.get(current.paneId) !== current.entry ||
      terminal === null ||
      terminal.pid <= 0
    ) {
      throw cleanupUncertain("Native renderer could not prove the finalized placed process.");
    }
    reservations.delete(bindingToken);
    return { type: "finalized", status: "finalized" };
  };

  const release = async (
    active: NativePlacementHandler,
    bindingToken: string,
  ): Promise<NativePlacementValue> => {
    const reservation = reservations.get(bindingToken);
    if (reservation === undefined) {
      return { type: "released", status: "already-absent" };
    }
    if (reservation.handlerGeneration !== active.generation) {
      throw cleanupUncertain("Native renderer generation changed before placed-pane cleanup.");
    }
    if (!paneMatches(active.store, reservation.paneId, reservation.identity)) {
      throw cleanupUncertain("Native placed pane identity changed before cleanup.");
    }
    if (active.registry.get(reservation.paneId) !== reservation.entry) {
      throw cleanupUncertain("Native placed PTY generation changed before cleanup.");
    }
    if (reservation.hostBacked !== true) {
      await active.registry.terminate(reservation.paneId);
    }
    if (active.registry.get(reservation.paneId) !== reservation.entry) {
      throw cleanupUncertain("Native placed PTY changed while cleanup was running.");
    }
    active.registry.dispose(reservation.paneId);
    active.store.actions.closePane(reservation.paneId);
    reservations.delete(bindingToken);
    return { type: "released", status: "released" };
  };

  return {
    uiRunId: options.uiRunId,
    socketPath,
    attach(input) {
      const generation = `renderer_${randomUUID()}`;
      handler = { ...input, generation };
      return generation;
    },
    suspend(generation) {
      if (handler?.generation === generation) handler = undefined;
    },
    close: () => server.close(),
    abandon: () => server.abandon(),
  };
}

function assertSourceCurrent(
  handler: NativePlacementHandler,
  source: NativePlacementSourceProof,
): void {
  if (handler.generation !== source.handlerGeneration) {
    throw placementRejected("Native renderer generation changed before reservation.");
  }
  currentSourceViewport(handler, source);
}

function currentSourceViewport(
  handler: NativePlacementHandler,
  source: NativePlacementSourceProof,
): { cols: number; rows: number } {
  const value = handler.registry.get(source.paneId);
  const terminal = value?.terminal;
  if (
    value === undefined ||
    value.generation !== source.entryGeneration ||
    terminal === null ||
    terminal === undefined ||
    terminal.pid !== source.terminalPid ||
    value.exited
  ) {
    throw placementRejected("Native source pane changed before reservation.");
  }
  return { cols: terminal.size.cols, rows: terminal.size.rows };
}

function requireReservation(
  handler: NativePlacementHandler,
  bindingToken: string,
  reservations: ReadonlyMap<string, NativeReservation>,
): NativeReservation {
  const reservation = reservations.get(bindingToken);
  if (reservation === undefined) {
    throw placementRejected("Native placement reservation is missing.");
  }
  if (reservation.handlerGeneration !== handler.generation) {
    throw cleanupUncertain("Native renderer generation changed after reservation.");
  }
  if (!paneMatches(handler.store, reservation.paneId, reservation.identity)) {
    throw cleanupUncertain("Native reserved pane was replaced before commit.");
  }
  return reservation;
}

function pruneAbsentReservations(
  handler: NativePlacementHandler,
  reservations: Map<string, NativeReservation>,
): void {
  const panes = handler.store.getState().workspace.panes;
  for (const [bindingToken, reservation] of reservations) {
    if (
      !panes.some((pane) => pane.id === reservation.paneId) &&
      handler.registry.get(reservation.paneId) === undefined
    ) {
      reservations.delete(bindingToken);
    }
  }
}

function paneMatches(store: StationStore, paneId: PaneId, identity: AgentIdentity): boolean {
  const pane = store.getState().workspace.panes.find((candidate) => candidate.id === paneId);
  return (
    pane?.role === "primary-agent" &&
    pane.agentIdentity?.sessionId === identity.sessionId &&
    pane.agentIdentity.terminalTargetId === identity.terminalTargetId &&
    pane.agentIdentity.terminalBindingToken === identity.terminalBindingToken
  );
}

function placementRejected(message: string): Error & {
  tag: "TerminalProviderError";
  code: "TERMINAL_PLACEMENT_REJECTED";
  provider: "native";
} {
  return Object.assign(new Error(message), {
    tag: "TerminalProviderError" as const,
    code: "TERMINAL_PLACEMENT_REJECTED" as const,
    provider: "native" as const,
  });
}

function cleanupUncertain(message: string): Error & {
  tag: "TerminalProviderError";
  code: "TERMINAL_CLEANUP_UNCERTAIN";
  provider: "native";
} {
  return Object.assign(new Error(message), {
    tag: "TerminalProviderError" as const,
    code: "TERMINAL_CLEANUP_UNCERTAIN" as const,
    provider: "native" as const,
  });
}
