import { randomUUID } from "node:crypto";
import type { TmuxConfig } from "@station/config";
import type {
  OpenPlacedWorkspaceRequest,
  OpenPlacedWorkspaceResult,
  ProviderId,
  ReleasePlacedTerminalTargetRequest,
  ResolvedTerminalPlacement,
  TerminalCallerContextRequest,
  TerminalPlacementPort,
  TerminalPlacementRequest,
  TerminalPlacementSource,
} from "@station/contracts";
import {
  createLocalProcessEvidence,
  type ExternalCommandRunner,
  type ProcessEvidence,
  type RuntimeClock,
  systemClock,
} from "@station/runtime";
import { createPlacementCommandRunner, isExpectedWorkbenchAbsence } from "../command.js";
import { TmuxTerminalProviderError } from "../errors.js";
import { parseTmuxPaneProofLines, tmuxPaneProofFormat } from "../parse.js";
import { parseTmuxTargetId } from "../targetId.js";
import {
  buildWorkbenchWindowName,
  resolveTmuxWorkbenchConfig,
  tmuxWindowTarget,
} from "../topology.js";
import { TmuxPlacementAuthorityStore } from "./authority.js";
import { TmuxPlacementCleanup } from "./cleanup.js";
import { cleanupUncertain, placementRejected } from "./errors.js";
import { buildPlacedWorkspaceMutationArgs } from "./mutation.js";
import { TmuxPlacementProofReader } from "./proof.js";
import type { SocketEvidence, TmuxMutableProof, TmuxPrivateProof } from "./types.js";

export const TMUX_PLACEMENT_AUTHORITY_TTL_MS = 10 * 60 * 1000;
export const TMUX_PLACEMENT_AUTHORITY_CAPACITY = 256;
const openGuardRejectedMarker = "__station_open_guard_rejected__";

export type TmuxPlacementServiceOptions = {
  command?: string;
  config?: TmuxConfig;
  timeoutMs?: number;
  runner?: ExternalCommandRunner;
  clock?: RuntimeClock;
  processEvidence?: ProcessEvidence;
  socketEvidence?: (path: string) => SocketEvidence;
  authorityStore?: TmuxPlacementAuthorityStore;
  newBindingToken?: () => string;
};

/**
 * ADAPTER
 *
 * Proves caller-owned tmux topology on one configured endpoint and applies
 * one-shot sibling or source-free detached placement with exact rollback authority.
 */
export class TmuxPlacementService implements TerminalPlacementPort {
  readonly id: ProviderId = "tmux";
  readonly supportedIntents = ["sibling", "detached"] as const;

  readonly #config: ReturnType<typeof resolveTmuxWorkbenchConfig>;
  readonly #clock: RuntimeClock;
  readonly #run: ReturnType<typeof createPlacementCommandRunner>;
  readonly #proofs: TmuxPlacementProofReader;
  readonly #cleanup: TmuxPlacementCleanup;
  readonly #authorities: TmuxPlacementAuthorityStore;
  readonly #newBindingToken: () => string;

  constructor(options: TmuxPlacementServiceOptions = {}) {
    this.#config = resolveTmuxWorkbenchConfig(options.config);
    this.#clock = options.clock ?? systemClock;
    this.#run = createPlacementCommandRunner({
      command: options.command ?? process.env.STATION_TMUX_BIN ?? "tmux",
      config: this.#config,
      timeoutMs: options.timeoutMs ?? 5000,
      ...(options.runner === undefined ? {} : { runner: options.runner }),
      clock: this.#clock,
    });
    this.#proofs = new TmuxPlacementProofReader({
      config: this.#config,
      run: this.#run,
      processEvidence: options.processEvidence ?? createLocalProcessEvidence(),
      ...(options.socketEvidence === undefined ? {} : { socketEvidence: options.socketEvidence }),
    });
    this.#cleanup = new TmuxPlacementCleanup({ run: this.#run, proofs: this.#proofs });
    this.#authorities =
      options.authorityStore ??
      new TmuxPlacementAuthorityStore({
        now: () => this.#clock.now(),
        capacity: TMUX_PLACEMENT_AUTHORITY_CAPACITY,
      });
    this.#newBindingToken = options.newBindingToken ?? (() => `placement_${randomUUID()}`);
  }

  async resolveCurrentPlacement(
    caller: TerminalCallerContextRequest,
  ): Promise<TerminalPlacementSource | undefined> {
    const proof = await this.#proofs.resolveCallerProof(caller);
    if (proof === undefined) return undefined;
    const authority = this.#authorities.issue(proof, TMUX_PLACEMENT_AUTHORITY_TTL_MS);
    return {
      provider: this.id,
      targetId: proof.targetId,
      generation: proof.generation,
      authorityId: authority.id,
      expiresAt: authority.expiresAt.toISOString(),
    };
  }

  async validatePlacement(request: TerminalPlacementRequest): Promise<void> {
    this.#assertSupported(request);
    if (request.intent === "detached") {
      // Probe the configured endpoint before worktree mutation; an absent server is
      // valid because the open command may create the workbench session.
      await this.#hasWorkbenchSession();
      return;
    }
    await this.#resolveAuthority(request.source, false);
  }

  async openPlacedWorkspace(
    request: OpenPlacedWorkspaceRequest,
  ): Promise<OpenPlacedWorkspaceResult> {
    this.#assertSupported(request.placement);
    const sessionId = request.sessionId;
    if (sessionId === undefined) {
      throw placementRejected("Placed workspaces require an explicit Station session identity.");
    }
    const bindingToken = this.#newBindingToken();
    let expectedGeneration: string | undefined;
    let siblingProof: TmuxPrivateProof | undefined;
    let mutationMayExist = false;
    try {
      let destination:
        | { create: "session"; sessionTarget: string; sessionName: string }
        | { create: "window"; sessionTarget: string };
      let configureWorkbench: boolean;
      if (request.placement.intent === "sibling") {
        const authority = await this.#resolveAuthority(request.placement.source, true);
        siblingProof = authority;
        expectedGeneration = authority.generation;
        destination = { create: "window", sessionTarget: authority.sessionId };
        configureWorkbench = false;
      } else {
        const sessionExists = await this.#hasWorkbenchSession();
        destination = sessionExists
          ? { create: "window", sessionTarget: this.#config.workbenchSession }
          : {
              create: "session",
              sessionTarget: this.#config.workbenchSession,
              sessionName: this.#config.workbenchSession,
            };
        configureWorkbench = true;
      }

      const windowName = buildWorkbenchWindowName({
        projectId: request.project.id,
        branch: request.worktree.branch,
        worktreeId: request.worktree.id,
        path: request.worktree.path,
      });
      mutationMayExist = true;
      const output = await this.#run(
        buildPlacedWorkspaceMutationArgs({
          ...destination,
          windowName,
          cwd: request.worktree.path,
          bindingToken,
          stationSessionId: sessionId,
          projectId: request.project.id,
          worktreeId: request.worktree.id,
          worktreePath: request.worktree.path,
          harness: request.harness,
          proofFormat: tmuxPaneProofFormat,
          configureWorkbench,
          ...(siblingProof === undefined
            ? {}
            : {
                guard: {
                  serverPid: siblingProof.serverProcess.pid,
                  sessionId: siblingProof.sessionId,
                  windowId: siblingProof.windowId,
                  paneId: siblingProof.paneId,
                  panePid: siblingProof.paneProcess.pid,
                  rejectionMarker: openGuardRejectedMarker,
                },
              }),
        }),
        "open",
      );
      if (output.stdout.trim() === openGuardRejectedMarker) {
        mutationMayExist = false;
        throw placementRejected("The tmux caller topology changed before sibling mutation.");
      }
      const proofOutput = parseTmuxPaneProofLines(output.stdout).find(
        (candidate) => candidate.openToken === bindingToken,
      );
      if (proofOutput === undefined) {
        throw placementRejected("tmux did not confirm the exact placed-window binding.");
      }
      const proof = this.#proofs.privateProof(proofOutput);
      if (expectedGeneration !== undefined && proof.generation !== expectedGeneration) {
        throw placementRejected("The tmux server changed during sibling placement.");
      }
      if (proof.stationSessionId !== sessionId) {
        throw placementRejected("tmux returned a mismatched Station session binding.");
      }
      return placedWorkspaceResult(request, sessionId, proof, windowName, bindingToken);
    } catch (error) {
      if (!mutationMayExist) throw error;
      try {
        await this.#cleanup.rollback(bindingToken, expectedGeneration);
      } catch (rollbackError) {
        throw cleanupUncertain(
          "tmux could not prove that the partially placed target was rolled back.",
          rollbackError,
        );
      }
      throw error;
    }
  }

  releasePlacedTarget(
    request: ReleasePlacedTerminalTargetRequest,
  ): Promise<{ status: "released" | "already-absent" }> {
    return this.#cleanup.release(request);
  }

  /** Qualifies an ordinary provider result with the configured endpoint's generation. */
  qualifyTarget(paneId: string): Promise<TmuxMutableProof> {
    return this.#proofs.inspectMutablePane(paneId);
  }

  /** Returns the live server/topology proof needed to guard an ordinary mutation. */
  async mutableTargetProof(targetId: string): Promise<TmuxMutableProof> {
    const target = this.#parseMutableTarget(targetId);
    const proof = await this.#proofs.inspectMutablePane(target.paneId);
    if (
      proof.generation !== target.generation ||
      proof.sessionId !== target.sessionId ||
      proof.windowId !== target.windowId
    ) {
      throw new TmuxTerminalProviderError(
        "TERMINAL_TARGET_MISSING",
        "The tmux target generation no longer exists.",
      );
    }
    return proof;
  }

  #parseMutableTarget(targetId: string): ReturnType<typeof parseTmuxTargetId> {
    try {
      return parseTmuxTargetId(targetId);
    } catch (cause) {
      throw new TmuxTerminalProviderError(
        "TERMINAL_TARGET_INVALID",
        "Malformed tmux target identity cannot authorize mutation.",
        { cause },
      );
    }
  }

  async #resolveAuthority(
    source: TerminalPlacementSource,
    consume: boolean,
  ): Promise<TmuxPrivateProof> {
    if (source.provider !== this.id) {
      throw placementRejected("The placement source belongs to another terminal provider.");
    }
    const stored = consume
      ? this.#authorities.consume(source.authorityId)
      : this.#authorities.get(source.authorityId);
    if (
      stored === undefined ||
      stored.expiresAt.toISOString() !== source.expiresAt ||
      stored.value.targetId !== source.targetId ||
      stored.value.generation !== source.generation
    ) {
      throw placementRejected("The terminal placement source is expired, consumed, or tampered.");
    }
    if (!(await this.#proofs.authorityIsCurrent(stored.value))) {
      throw placementRejected("The terminal placement source changed before mutation.");
    }
    return stored.value;
  }

  async #hasWorkbenchSession(): Promise<boolean> {
    try {
      await this.#run(["has-session", "-t", this.#config.workbenchSession], "inspect");
      return true;
    } catch (error) {
      if (isExpectedWorkbenchAbsence(error, this.#config.workbenchSession)) return false;
      throw error;
    }
  }

  #assertSupported(request: TerminalPlacementRequest): void {
    if (!this.supportedIntents.includes(request.intent)) {
      throw new TmuxTerminalProviderError(
        "TERMINAL_PLACEMENT_UNSUPPORTED",
        "tmux does not support the requested placement intent.",
      );
    }
  }
}

function placedWorkspaceResult(
  request: OpenPlacedWorkspaceRequest,
  sessionId: string,
  proof: TmuxPrivateProof,
  windowName: string,
  bindingToken: string,
): OpenPlacedWorkspaceResult {
  const identity = {
    provider: "tmux" as const,
    targetId: proof.targetId,
    generation: proof.generation,
  };
  const placement: ResolvedTerminalPlacement =
    request.placement.intent === "sibling"
      ? {
          intent: "sibling",
          ...identity,
          presentation: "presented",
        }
      : {
          intent: "detached",
          ...identity,
          presentation: "detached",
        };
  return {
    target: {
      provider: "tmux",
      targetId: proof.targetId,
      projectId: request.project.id,
      worktreeId: request.worktree.id,
      sessionId,
      harnessBinding: {
        role: "main-agent",
        harnessProvider: request.harness,
        worktreePath: request.worktree.path,
      },
      providerData: {
        sessionName: proof.sessionName,
        windowName,
        windowTarget: tmuxWindowTarget({
          sessionId: proof.sessionId,
          windowNameOrId: proof.windowId,
        }),
        paneTarget: proof.paneId,
        windowId: proof.windowId,
        paneId: proof.paneId,
      },
      confidence: "high",
      reason: "tmux created a workspace from explicit validated placement.",
    },
    agentEndpointId: proof.paneId,
    placement,
    bindingToken,
  };
}
