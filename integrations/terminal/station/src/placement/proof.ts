import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  StationHostExactEvidence,
  StationHostTerminalLifetime,
  TerminalCallerContextRequest,
  TerminalTargetId,
} from "@station/contracts";
import {
  type HostPtyAttachExpectation,
  isSameHostPtyIdentity,
  isSameHostPtyRef,
} from "@station/host";
import { readUnixSocketHolderPidsAsync } from "@station/protocol";
import {
  createLocalProcessEvidence,
  type ProcessEvidence,
  type ProcessIdentity,
  processDescendsFrom,
  processIdentityMatches,
} from "@station/runtime";
import { StationTerminalProviderError } from "../errors.js";
import { inspectStationHost } from "../host/inspectStationHost.js";
import {
  type NativePlacementPaneProof,
  type NativePlacementSourceProof,
  nativePlacementSocketDirectory,
  requestNativePlacement,
} from "./protocol.js";

export const NATIVE_PLACEMENT_EVIDENCE_TIMEOUT_MS = 5_000;

export type NativePrivateProof = {
  socketPath: string;
  uiRunId: string;
  source: NativePlacementSourceProof;
  targetId: TerminalTargetId;
  generation: string;
  rendererProcess: ProcessIdentity;
  terminalProcess: ProcessIdentity;
  host?: {
    evidence: StationHostExactEvidence;
    terminal: StationHostTerminalLifetime;
  };
};

export type NativePlacementProofResolverOptions = {
  stateDir: string;
  hostSocketPath?: string;
  processEvidence?: ProcessEvidence;
  request?: typeof requestNativePlacement;
  inspectHost?: typeof inspectStationHost;
  socketHolders?: (socketPath: string, deadlineMs: number) => Promise<readonly number[]>;
};

export class NativePlacementProofResolver {
  readonly #stateDir: string;
  readonly #hostSocketPath: string | undefined;
  readonly #processEvidence: ProcessEvidence;
  readonly #request: typeof requestNativePlacement;
  readonly #inspectHost: typeof inspectStationHost;
  readonly #socketHolders: (socketPath: string, deadlineMs: number) => Promise<readonly number[]>;

  constructor(options: NativePlacementProofResolverOptions) {
    this.#stateDir = options.stateDir;
    this.#hostSocketPath = options.hostSocketPath;
    this.#processEvidence = options.processEvidence ?? createLocalProcessEvidence();
    this.#request = options.request ?? requestNativePlacement;
    this.#inspectHost = options.inspectHost ?? inspectStationHost;
    this.#socketHolders =
      options.socketHolders ??
      ((socketPath, deadlineMs) => readUnixSocketHolderPidsAsync(socketPath, { deadlineMs }));
  }

  async resolveCaller(
    caller: TerminalCallerContextRequest,
  ): Promise<NativePrivateProof | undefined> {
    const candidates = (
      await Promise.all((await this.#socketPaths()).map((path) => this.#candidate(path, caller)))
    ).filter((candidate): candidate is NativePrivateProof => candidate !== undefined);
    if (candidates.length === 0) return undefined;
    if (candidates.length !== 1) {
      throw callerRejected("More than one native renderer pane matched the caller process.");
    }
    return candidates[0];
  }

  async assertCurrent(proof: NativePrivateProof): Promise<void> {
    const deadlineMs = Date.now() + NATIVE_PLACEMENT_EVIDENCE_TIMEOUT_MS;
    let value: Awaited<ReturnType<typeof requestNativePlacement>>;
    try {
      value = await this.#request(proof.socketPath, { type: "snapshot" }, remainingMs(deadlineMs));
      const holders = await this.#socketHolders(proof.socketPath, deadlineMs);
      if (
        value.type !== "snapshot" ||
        value.snapshot.uiRunId !== proof.uiRunId ||
        value.snapshot.handlerGeneration !== proof.source.handlerGeneration ||
        holders.length !== 1 ||
        holders[0] !== proof.rendererProcess.pid ||
        !processIdentityMatches(
          this.#processEvidence.read(proof.rendererProcess.pid),
          proof.rendererProcess,
        )
      ) {
        throw placementRejected("Native renderer or pane generation changed before placement.");
      }
      const pane = value.snapshot.panes.find((candidate) => sameSource(candidate, proof.source));
      if (
        pane === undefined ||
        !processIdentityMatches(this.#processEvidence.read(pane.terminalPid), proof.terminalProcess)
      ) {
        throw placementRejected("Native renderer or pane generation changed before placement.");
      }
      const host = await this.#hostProof(pane);
      const hostMatches =
        proof.host === undefined
          ? host === undefined
          : host !== undefined && sameHostPty(host.terminal, proof.host.terminal);
      if (!hostMatches) {
        throw placementRejected("Native renderer or pane generation changed before placement.");
      }
    } catch (cause) {
      if (cause instanceof StationTerminalProviderError) throw cause;
      throw evidenceUnavailable("Native placement proof could not be refreshed.", cause);
    }
  }

  async #candidate(
    socketPath: string,
    caller: TerminalCallerContextRequest,
  ): Promise<NativePrivateProof | undefined> {
    const deadlineMs = Date.now() + NATIVE_PLACEMENT_EVIDENCE_TIMEOUT_MS;
    try {
      const value = await this.#request(socketPath, { type: "snapshot" }, remainingMs(deadlineMs));
      if (value.type !== "snapshot") {
        throw evidenceUnavailable("Native renderer returned the wrong placement evidence.");
      }
      const snapshot = value.snapshot;
      const holders = await this.#socketHolders(socketPath, deadlineMs);
      if (holders.length !== 1 || holders[0] !== snapshot.rendererPid) return undefined;
      const renderer = this.#processEvidence.read(snapshot.rendererPid);
      if (renderer === undefined) return undefined;
      const panes = snapshot.panes.filter((pane) =>
        processDescendsFrom(this.#processEvidence, caller.process, pane.terminalPid),
      );
      if (panes.length > 1) {
        throw callerRejected("More than one native pane matched the caller process.");
      }
      const pane = panes[0];
      if (pane === undefined) return undefined;
      const terminal = this.#processEvidence.read(pane.terminalPid);
      if (terminal === undefined) return undefined;
      const host = await this.#hostProof(pane);
      if (pane.hostPtyRef !== undefined && host === undefined) return undefined;
      const targetId = (pane.terminalTargetId ??
        host?.terminal.terminalTargetId ??
        `native:caller:${digest([snapshot.uiRunId, pane.paneId, pane.entryGeneration])}`) as TerminalTargetId;
      const source: NativePlacementSourceProof = {
        handlerGeneration: snapshot.handlerGeneration,
        paneId: pane.paneId,
        entryGeneration: pane.entryGeneration,
        terminalPid: pane.terminalPid,
      };
      const rendererProcess = { pid: renderer.pid, startToken: renderer.startToken };
      const terminalProcess = { pid: terminal.pid, startToken: terminal.startToken };
      const generation = proofGeneration({
        socketPath,
        uiRunId: snapshot.uiRunId,
        source,
        rendererProcess,
        terminalProcess,
        host,
      });
      return {
        socketPath,
        uiRunId: snapshot.uiRunId,
        source,
        targetId,
        generation,
        rendererProcess,
        terminalProcess,
        ...(host === undefined ? {} : { host }),
      };
    } catch (cause) {
      if (cause instanceof StationTerminalProviderError) throw cause;
      throw evidenceUnavailable("Native caller placement evidence is unavailable.", cause);
    }
  }

  async #hostProof(
    pane: NativePlacementPaneProof,
  ): Promise<NativePrivateProof["host"] | undefined> {
    const hostPtyRef = pane.hostPtyRef;
    if (hostPtyRef === undefined) return undefined;
    if (this.#hostSocketPath === undefined) {
      throw evidenceUnavailable("Station Host placement evidence is not configured.");
    }
    const inspected = await this.#inspectHost({ socketPath: this.#hostSocketPath });
    if (inspected.status !== "exact") {
      throw evidenceUnavailable("Exact Station Host placement evidence is unavailable.");
    }
    const terminal = inspected.evidence.terminals.find((candidate) =>
      sameHostPty(candidate, hostPtyRef),
    );
    if (terminal === undefined || terminal.pid !== pane.terminalPid) return undefined;
    return { evidence: inspected.evidence, terminal };
  }

  async #socketPaths(): Promise<string[]> {
    const directory = nativePlacementSocketDirectory(this.#stateDir);
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isSocket() && entry.name.endsWith(".sock"))
        .map((entry) => join(directory, entry.name));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw evidenceUnavailable("Native renderer socket inventory is unavailable.", cause);
    }
  }
}

export function nativePlacementBindingGeneration(
  proof: NativePrivateProof,
  targetId: TerminalTargetId,
  bindingToken: string,
): string {
  return digest([proof.generation, targetId, bindingToken]);
}

export function sameHostPty(
  left: StationHostTerminalLifetime,
  right: HostPtyAttachExpectation | StationHostTerminalLifetime,
): boolean {
  return isSameHostPtyIdentity(left, right) && isSameHostPtyRef(left, right);
}

function sameSource(pane: NativePlacementPaneProof, source: NativePlacementSourceProof): boolean {
  return (
    pane.paneId === source.paneId &&
    pane.entryGeneration === source.entryGeneration &&
    pane.terminalPid === source.terminalPid
  );
}

function proofGeneration(input: {
  socketPath: string;
  uiRunId: string;
  source: NativePlacementSourceProof;
  rendererProcess: ProcessIdentity;
  terminalProcess: ProcessIdentity;
  host?: NativePrivateProof["host"];
}): string {
  return digest([
    input.socketPath,
    input.uiRunId,
    input.source.handlerGeneration,
    input.source.paneId,
    input.source.entryGeneration,
    String(input.source.terminalPid),
    String(input.rendererProcess.pid),
    input.rendererProcess.startToken,
    input.terminalProcess.startToken,
    input.host?.terminal.ptyId ?? "local",
    input.host?.terminal.ptyInstanceId ?? "local",
  ]);
}

function digest(parts: readonly string[]): string {
  return `nativeg_${createHash("sha256").update(parts.join("\0")).digest("hex")}`;
}

function remainingMs(deadlineMs: number): number {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) {
    throw evidenceUnavailable("Native placement evidence timed out.");
  }
  return remaining;
}

function callerRejected(message: string): StationTerminalProviderError {
  return new StationTerminalProviderError("TERMINAL_CALLER_CONTEXT_REJECTED", message);
}

function placementRejected(message: string): StationTerminalProviderError {
  return new StationTerminalProviderError("TERMINAL_PLACEMENT_REJECTED", message);
}

function evidenceUnavailable(message: string, cause?: unknown): StationTerminalProviderError {
  return new StationTerminalProviderError("TERMINAL_PLACEMENT_EVIDENCE_UNAVAILABLE", message, {
    ...(cause === undefined ? {} : { cause }),
    hint: "Retry after the native renderer and Station Host are responsive.",
  });
}
