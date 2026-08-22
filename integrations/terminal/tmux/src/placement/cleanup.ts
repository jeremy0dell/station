import type { ReleasePlacedTerminalTargetRequest } from "@station/contracts";
import { buildQualifiedKillWindowArgs } from "../commandGuard.js";
import { isTmuxNoServerListError } from "../errors.js";
import type { TmuxPaneProof } from "../parse.js";
import { parseTmuxTargetId } from "../targetId.js";
import { cleanupUncertain } from "./errors.js";
import type { TmuxPlacementProofReader } from "./proof.js";
import type { PlacementCommandRunner } from "./types.js";

const releaseRejectedMarker = "__station_release_guard_rejected__";

export class TmuxPlacementCleanup {
  readonly #run: PlacementCommandRunner;
  readonly #proofs: TmuxPlacementProofReader;

  constructor(input: { run: PlacementCommandRunner; proofs: TmuxPlacementProofReader }) {
    this.#run = input.run;
    this.#proofs = input.proofs;
  }

  async release(
    request: ReleasePlacedTerminalTargetRequest,
  ): Promise<{ status: "released" | "already-absent" }> {
    let target: ReturnType<typeof parseTmuxTargetId>;
    try {
      target = parseTmuxTargetId(request.targetId);
    } catch (cause) {
      throw cleanupUncertain("The placed target identity cannot authorize cleanup.", cause);
    }
    if (target.generation !== request.generation) {
      throw cleanupUncertain("The placed target generation does not match its release request.");
    }
    const proofs = await this.#listProofsForCleanup(target.generation);
    const matches = proofs.filter(
      (proof) => proof.sessionId === target.sessionId && proof.windowId === target.windowId,
    );
    if (matches.length === 0) return { status: "already-absent" };
    if (
      matches.some(
        (proof) =>
          proof.openToken !== request.bindingToken || proof.stationSessionId !== request.sessionId,
      )
    ) {
      throw cleanupUncertain("The placed tmux window binding no longer matches cleanup authority.");
    }
    const matchedProof = matches[0];
    if (matchedProof === undefined) {
      throw cleanupUncertain("The placed tmux window lookup became ambiguous.");
    }
    await this.#killWindowAndConfirm({
      sessionId: target.sessionId,
      windowId: target.windowId,
      generation: target.generation,
      bindingToken: request.bindingToken,
      stationSessionId: request.sessionId,
      serverPid: matchedProof.serverPid,
    });
    return { status: "released" };
  }

  async rollback(bindingToken: string, expectedGeneration: string | undefined): Promise<void> {
    let proofs: TmuxPaneProof[];
    try {
      proofs = await this.#proofs.listProofs();
    } catch (error) {
      if (expectedGeneration === undefined && isTmuxNoServerListError(error)) return;
      throw error;
    }
    const qualified = proofs.map((proof) => ({
      raw: proof,
      proof: this.#proofs.privateProof(proof),
    }));
    if (
      expectedGeneration !== undefined &&
      qualified.some((candidate) => candidate.proof.generation !== expectedGeneration)
    ) {
      throw cleanupUncertain("The tmux server changed before partial-placement rollback.");
    }
    const matches = qualified.filter((candidate) => candidate.raw.openToken === bindingToken);
    const windows = new Map(
      matches.map((candidate) => [
        `${candidate.proof.sessionId}:${candidate.proof.windowId}`,
        candidate.proof,
      ]),
    );
    // Once mutation was attempted, an absent binding is not proof that no window
    // was created: stamping may have failed or a hook may have renamed it.
    if (windows.size === 0) {
      throw cleanupUncertain("tmux could not prove that the partial placement was absent.");
    }
    if (windows.size !== 1) {
      throw cleanupUncertain("The partial tmux placement token matched multiple windows.");
    }
    const target = windows.values().next().value;
    if (target === undefined) {
      throw cleanupUncertain("The partial tmux placement target disappeared during rollback.");
    }
    await this.#killWindowAndConfirm({
      sessionId: target.sessionId,
      windowId: target.windowId,
      generation: target.generation,
      bindingToken,
      stationSessionId: matches[0]?.raw.stationSessionId ?? "",
      serverPid: target.serverProcess.pid,
    });
  }

  async #killWindowAndConfirm(input: {
    sessionId: string;
    windowId: string;
    generation: string;
    bindingToken: string;
    stationSessionId: string;
    serverPid: number;
  }): Promise<void> {
    try {
      const output = await this.#run(
        buildQualifiedKillWindowArgs({
          sessionId: input.sessionId,
          windowId: input.windowId,
          serverPid: input.serverPid,
          bindingToken: input.bindingToken,
          stationSessionId: input.stationSessionId,
          rejectionMarker: releaseRejectedMarker,
        }),
        "release",
      );
      if (output.stdout.trim() === releaseRejectedMarker) {
        throw cleanupUncertain("The tmux release guard rejected changed binding evidence.");
      }
      return;
    } catch (error) {
      const proofs = await this.#listProofsForCleanup(input.generation);
      const exactWindowRemains = proofs.some(
        (proof) => proof.sessionId === input.sessionId && proof.windowId === input.windowId,
      );
      if (!exactWindowRemains) return;
      throw cleanupUncertain("tmux did not confirm exact placed-window release.", error);
    }
  }

  async #listProofsForCleanup(expectedGeneration: string): Promise<TmuxPaneProof[]> {
    let proofs: TmuxPaneProof[];
    try {
      proofs = await this.#proofs.listProofs();
    } catch (error) {
      throw cleanupUncertain("tmux endpoint absence makes placed-target cleanup uncertain.", error);
    }
    for (const proof of proofs) {
      try {
        if (this.#proofs.serverProof(proof).generation !== expectedGeneration) {
          throw cleanupUncertain("The tmux server generation changed before cleanup.");
        }
      } catch (cause) {
        throw cleanupUncertain("tmux cleanup proof could not be revalidated.", cause);
      }
    }
    return proofs;
  }
}
