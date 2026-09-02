import type {
  ManagedOpenWorkspaceResult,
  ManagedTerminalLaunchProcessRequest,
  OpenPlacedWorkspaceRequest,
  OpenPlacedWorkspaceResult,
  ProviderId,
  ReleaseManagedTerminalTargetRequest,
  ReleasePlacedTerminalTargetRequest,
  ResolvedTerminalPlacement,
  SessionId,
  StationHostExactEvidence,
  StationHostTerminalLifetime,
  TerminalCallerContextRequest,
  TerminalOutputCompatibility,
  TerminalPlacementPort,
  TerminalPlacementRequest,
  TerminalPlacementSource,
  TerminalTargetId,
} from "@station/contracts";
import type { HostPtyAttachExpectation, HostSpawnResult } from "@station/host";
import { OneShotAuthorityStore, type RuntimeClock, systemClock } from "@station/runtime";
import { STATION_TERMINAL_PROVIDER_ID, StationTerminalProviderError } from "../errors.js";
import { closeExactStationHostPty } from "../host/closeExactStationHostPty.js";
import { inspectStationHost } from "../host/inspectStationHost.js";
import type { NativePlacementProofResolverOptions, NativePrivateProof } from "./proof.js";
import {
  NativePlacementProofResolver,
  nativePlacementBindingGeneration,
  sameHostPty,
} from "./proof.js";
import { requestNativePlacement } from "./protocol.js";

export const NATIVE_PLACEMENT_PENDING_CAPACITY = 256;
const NATIVE_PLACEMENT_AUTHORITY_TTL_MS = 10 * 60 * 1000;
const NATIVE_PLACEMENT_AUTHORITY_CAPACITY = 256;

type NativePlacementOwner = {
  openManagedWorkspace(request: OpenPlacedWorkspaceRequest): Promise<ManagedOpenWorkspaceResult>;
  releaseTarget(request: ReleaseManagedTerminalTargetRequest): Promise<boolean>;
};

type PendingPlacement = {
  proof: NativePrivateProof;
  targetId: TerminalTargetId;
  sessionId: string;
  bindingToken: string;
  generation: string;
  committed: boolean;
  destinationHost?: {
    ptyRef: HostPtyAttachExpectation;
    evidence?: StationHostExactEvidence;
    terminal?: StationHostTerminalLifetime;
  };
};

export type StationPlacementServiceOptions = {
  stateDir: string;
  hostSocketPath?: string;
  owner: NativePlacementOwner;
  clock?: RuntimeClock;
  processEvidence?: NativePlacementProofResolverOptions["processEvidence"];
  authorityStore?: OneShotAuthorityStore<NativePrivateProof>;
  request?: typeof requestNativePlacement;
  inspectHost?: typeof inspectStationHost;
  closeHostPty?: typeof closeExactStationHostPty;
  socketHolders?: NativePlacementProofResolverOptions["socketHolders"];
  pendingCapacity?: number;
};

/**
 * ADAPTER
 *
 * Proves one native renderer/pane from exact socket and process ancestry,
 * issues one-shot authority, and coordinates bounded generation-safe
 * reserve/commit/finalize/release lifecycle.
 */
export class StationPlacementService implements TerminalPlacementPort {
  readonly id: ProviderId = STATION_TERMINAL_PROVIDER_ID;
  readonly supportedIntents = ["sibling"] as const;

  readonly #owner: NativePlacementOwner;
  readonly #clock: RuntimeClock;
  readonly #authorities: OneShotAuthorityStore<NativePrivateProof>;
  readonly #proofs: NativePlacementProofResolver;
  readonly #request: typeof requestNativePlacement;
  readonly #inspectHost: typeof inspectStationHost;
  readonly #closeHostPty: typeof closeExactStationHostPty;
  readonly #pendingCapacity: number;
  readonly #pending = new Map<string, PendingPlacement>();

  constructor(options: StationPlacementServiceOptions) {
    this.#owner = options.owner;
    this.#clock = options.clock ?? systemClock;
    this.#authorities =
      options.authorityStore ??
      new OneShotAuthorityStore<NativePrivateProof>({
        capacity: NATIVE_PLACEMENT_AUTHORITY_CAPACITY,
        now: () => this.#clock.now(),
      });
    this.#request = options.request ?? requestNativePlacement;
    this.#inspectHost = options.inspectHost ?? inspectStationHost;
    this.#closeHostPty = options.closeHostPty ?? closeExactStationHostPty;
    this.#pendingCapacity = options.pendingCapacity ?? NATIVE_PLACEMENT_PENDING_CAPACITY;
    if (!Number.isSafeInteger(this.#pendingCapacity) || this.#pendingCapacity <= 0) {
      throw new Error("Native placement pending capacity must be a positive integer.");
    }
    this.#proofs = new NativePlacementProofResolver({
      stateDir: options.stateDir,
      ...(options.hostSocketPath === undefined ? {} : { hostSocketPath: options.hostSocketPath }),
      ...(options.processEvidence === undefined
        ? {}
        : { processEvidence: options.processEvidence }),
      ...(options.request === undefined ? {} : { request: options.request }),
      ...(options.inspectHost === undefined ? {} : { inspectHost: options.inspectHost }),
      ...(options.socketHolders === undefined ? {} : { socketHolders: options.socketHolders }),
    });
  }

  async resolveCurrentPlacement(
    caller: TerminalCallerContextRequest,
  ): Promise<TerminalPlacementSource | undefined> {
    if (caller.claims.STATION_PANE !== "1") return undefined;
    const proof = await this.#proofs.resolveCaller(caller);
    if (proof === undefined) return undefined;
    const authority = this.#authorities.issue(proof, NATIVE_PLACEMENT_AUTHORITY_TTL_MS);
    return {
      provider: this.id,
      targetId: proof.targetId,
      generation: proof.generation,
      authorityId: authority.id,
      expiresAt: authority.expiresAt.toISOString(),
    };
  }

  async validatePlacement(placement: TerminalPlacementRequest): Promise<void> {
    if (placement.intent !== "sibling")
      throw placementRejected("Native placement is sibling-only.");
    await this.#resolveAuthority(placement.source, false);
  }

  async openPlacedWorkspace(
    request: OpenPlacedWorkspaceRequest,
  ): Promise<OpenPlacedWorkspaceResult> {
    if (request.placement.intent !== "sibling") {
      throw placementRejected("Native placement is sibling-only.");
    }
    const sessionId = request.sessionId;
    if (sessionId === undefined) {
      throw placementRejected("Placed native workspaces require an explicit session identity.");
    }
    if (this.#pending.size >= this.#pendingCapacity) {
      throw placementRejected("Native placement cleanup capacity is exhausted.");
    }
    const proof = await this.#resolveAuthority(request.placement.source, true);
    const opened = await this.#owner.openManagedWorkspace(request);
    const generation = nativePlacementBindingGeneration(
      proof,
      opened.target.targetId,
      opened.bindingToken,
    );
    try {
      const value = await this.#request(proof.socketPath, {
        type: "reserve",
        source: proof.source,
        bindingToken: opened.bindingToken,
        target: {
          terminalTargetId: opened.target.targetId,
          sessionId,
          worktreeId: request.worktree.id,
          harnessProvider: request.harness,
        },
      });
      if (value.type !== "reserved") {
        throw placementRejected("Native renderer returned the wrong reserve acknowledgement.");
      }
      this.#pending.set(opened.bindingToken, {
        proof,
        targetId: opened.target.targetId,
        sessionId,
        bindingToken: opened.bindingToken,
        generation,
        committed: false,
      });
    } catch (cause) {
      await this.#rollbackUnconfirmedReserve(proof.socketPath, opened, sessionId, cause);
    }
    const placement: ResolvedTerminalPlacement = {
      intent: "sibling",
      provider: this.id,
      targetId: opened.target.targetId,
      generation,
      presentation: "presented",
    };
    return { ...opened, placement };
  }

  hasPendingBinding(bindingToken: string): boolean {
    return this.#pending.has(bindingToken);
  }

  async finalizePlacedTarget(request: ReleasePlacedTerminalTargetRequest): Promise<void> {
    const pending = this.#pending.get(request.bindingToken);
    if (pending === undefined) return;
    this.#assertPendingMatches(pending, request);
    if (!pending.committed) {
      throw cleanupUncertain("Native placement was finalized before its process was committed.");
    }
    const value = await this.#request(pending.proof.socketPath, {
      type: "finalize",
      bindingToken: pending.bindingToken,
    });
    if (value.type !== "finalized") {
      throw cleanupUncertain("Native renderer did not confirm placement finalization.");
    }
    this.#pending.delete(request.bindingToken);
  }

  async commitPlacedProcess(
    request: ManagedTerminalLaunchProcessRequest,
    options: {
      outputCompatibility?: TerminalOutputCompatibility | undefined;
      host?: { socketPath: string; ptyRef: HostPtyAttachExpectation; spawned: HostSpawnResult };
    } = {},
  ): Promise<boolean> {
    const pending = this.#pending.get(request.bindingToken);
    if (pending === undefined) return false;
    if (
      pending.targetId !== request.terminalTarget.targetId ||
      pending.sessionId !== request.terminalTarget.sessionId
    ) {
      throw placementRejected("Native placement launch binding was superseded.");
    }
    if (options.host !== undefined) {
      const host = options.host;
      pending.destinationHost = { ptyRef: host.ptyRef };
      const inspected = await this.#inspectHost({ socketPath: host.socketPath });
      if (inspected.status !== "exact") {
        throw cleanupUncertain("Could not prove the Host lifetime for the placed native PTY.");
      }
      const terminal = inspected.evidence.terminals.find((candidate) =>
        sameHostPty(candidate, host.ptyRef),
      );
      if (terminal === undefined || terminal.pid !== host.spawned.pid) {
        throw cleanupUncertain("Station Host returned mismatched placed PTY evidence.");
      }
      pending.destinationHost = {
        ptyRef: host.ptyRef,
        evidence: inspected.evidence,
        terminal,
      };
    }
    const value = await this.#request(pending.proof.socketPath, {
      type: "commit",
      bindingToken: pending.bindingToken,
      launch: {
        provider: request.launchPlan.provider,
        command: request.launchPlan.command,
        args: request.launchPlan.args,
        ...(request.launchPlan.cwd === undefined ? {} : { cwd: request.launchPlan.cwd }),
        ...(request.launchPlan.env === undefined ? {} : { env: request.launchPlan.env }),
        ...(options.outputCompatibility === undefined
          ? {}
          : { outputCompatibility: options.outputCompatibility }),
      },
      ...(options.host === undefined
        ? {}
        : { host: { socketPath: options.host.socketPath, ptyRef: options.host.ptyRef } }),
    });
    if (value.type !== "committed") {
      throw cleanupUncertain("Native renderer did not confirm the exact placed process.");
    }
    pending.committed = true;
    return true;
  }

  async releasePlacedTarget(
    request: ReleasePlacedTerminalTargetRequest,
  ): Promise<{ status: "released" | "already-absent" }> {
    const pending = this.#pending.get(request.bindingToken);
    if (pending === undefined) return { status: "already-absent" };
    this.#assertPendingMatches(pending, request);
    if (pending.destinationHost !== undefined) {
      const host = pending.destinationHost;
      if (host.evidence === undefined || host.terminal === undefined) {
        throw cleanupUncertain(
          "Native Host placement failed before exact cleanup proof was retained.",
        );
      }
      await this.#closeHostPty({ expectedHost: host.evidence, expectedPty: host.terminal });
    }
    const value = await this.#request(pending.proof.socketPath, {
      type: "release",
      bindingToken: pending.bindingToken,
    });
    if (value.type !== "released") {
      throw cleanupUncertain("Native renderer did not confirm exact placed-pane cleanup.");
    }
    const released = await this.#owner.releaseTarget({
      targetId: pending.targetId,
      expectedSessionId: pending.sessionId as SessionId,
      expectedBindingToken: pending.bindingToken,
    });
    if (!released) throw cleanupUncertain("Native terminal binding changed during cleanup.");
    this.#pending.delete(request.bindingToken);
    return value.status === "already-absent" && pending.destinationHost === undefined
      ? { status: "already-absent" }
      : { status: "released" };
  }

  #assertPendingMatches(
    pending: PendingPlacement,
    request: ReleasePlacedTerminalTargetRequest,
  ): void {
    if (
      pending.targetId !== request.targetId ||
      pending.sessionId !== request.sessionId ||
      pending.generation !== request.generation
    ) {
      throw cleanupUncertain(
        "Native placement cleanup authority did not match the retained target.",
      );
    }
  }

  async #resolveAuthority(
    source: TerminalPlacementSource,
    consume: boolean,
  ): Promise<NativePrivateProof> {
    if (source.provider !== this.id) throw placementRejected("Placement source is not native.");
    const stored = consume
      ? this.#authorities.consume(source.authorityId)
      : this.#authorities.get(source.authorityId);
    if (
      stored === undefined ||
      stored.expiresAt.toISOString() !== source.expiresAt ||
      stored.value.targetId !== source.targetId ||
      stored.value.generation !== source.generation
    ) {
      throw placementRejected("Native placement authority is expired, consumed, or tampered.");
    }
    await this.#proofs.assertCurrent(stored.value);
    return stored.value;
  }

  async #rollbackUnconfirmedReserve(
    socketPath: string,
    opened: ManagedOpenWorkspaceResult,
    sessionId: string,
    cause: unknown,
  ): Promise<never> {
    const cleanupFailures: unknown[] = [];
    try {
      const value = await this.#request(socketPath, {
        type: "release",
        bindingToken: opened.bindingToken,
      });
      if (value.type !== "released") cleanupFailures.push(new Error("Wrong release response."));
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      if (
        !(await this.#owner.releaseTarget({
          targetId: opened.target.targetId,
          expectedSessionId: sessionId as SessionId,
          expectedBindingToken: opened.bindingToken,
        }))
      ) {
        cleanupFailures.push(new Error("Native target binding changed."));
      }
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (cleanupFailures.length > 0) {
      throw cleanupUncertain(
        "Could not prove rollback of an unconfirmed native pane reservation.",
        new AggregateError([cause, ...cleanupFailures]),
      );
    }
    throw cause;
  }
}

function placementRejected(message: string): StationTerminalProviderError {
  return new StationTerminalProviderError("TERMINAL_PLACEMENT_REJECTED", message);
}

function cleanupUncertain(message: string, cause?: unknown): StationTerminalProviderError {
  return new StationTerminalProviderError("TERMINAL_CLEANUP_UNCERTAIN", message, {
    ...(cause === undefined ? {} : { cause }),
    hint: "Inspect the retained native session before removing its worktree.",
  });
}
