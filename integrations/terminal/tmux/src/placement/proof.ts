import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeObservedPath, type TerminalCallerContextRequest } from "@station/contracts";
import {
  type ProcessEvidence,
  processDescendsFrom,
  processIdentityMatches,
} from "@station/runtime";
import { z } from "zod";
import {
  parseTmuxPaneProof,
  parseTmuxPaneProofLines,
  type TmuxPaneProof,
  tmuxPaneProofFormat,
} from "../parse.js";
import { buildTmuxTargetId } from "../targetId.js";
import type { TmuxWorkbenchConfig } from "../topology.js";
import { callerContextRejected, placementRejected } from "./errors.js";
import type {
  PlacementCommandRunner,
  SocketEvidence,
  TmuxMutableProof,
  TmuxPrivateProof,
} from "./types.js";

const TmuxCallerClaimSchema = z
  .tuple([
    z.string().min(1),
    z
      .string()
      .regex(/^[1-9]\d*$/u)
      .transform(Number)
      .pipe(z.number().int().positive().safe()),
    z.string().regex(/^\d+$/u),
    z.string().regex(/^%\d+$/u),
  ])
  .transform(([socketPath, serverPid, , paneId]) => ({ socketPath, serverPid, paneId }));

export class TmuxPlacementProofReader {
  readonly #config: TmuxWorkbenchConfig;
  readonly #run: PlacementCommandRunner;
  readonly #processEvidence: ProcessEvidence;
  readonly #socketEvidence: (path: string) => SocketEvidence;

  constructor(input: {
    config: TmuxWorkbenchConfig;
    run: PlacementCommandRunner;
    processEvidence: ProcessEvidence;
    socketEvidence?: (path: string) => SocketEvidence;
  }) {
    this.#config = input.config;
    this.#run = input.run;
    this.#processEvidence = input.processEvidence;
    this.#socketEvidence = input.socketEvidence ?? readSocketEvidence;
  }

  async resolveCallerProof(
    caller: TerminalCallerContextRequest,
  ): Promise<TmuxPrivateProof | undefined> {
    const claim = parseCallerClaim(caller);
    if (claim === undefined) return undefined;
    const proof = await this.inspectPane(claim.paneId);
    if (
      normalizedSocketPath(claim.socketPath) !== normalizedSocketPath(proof.socketPath) ||
      claim.serverPid !== proof.serverProcess.pid
    ) {
      throw callerContextRejected(
        "The caller belongs to a different tmux server than Station's configured workbench endpoint.",
        "Set [terminal.tmux].workbench_socket_path to this server or run the command from the configured server.",
      );
    }
    if (!processDescendsFrom(this.#processEvidence, caller.process, proof.paneProcess)) {
      throw callerContextRejected(
        "The calling process is not descended from the claimed live tmux pane.",
      );
    }
    return proof;
  }

  async authorityIsCurrent(expected: TmuxPrivateProof): Promise<boolean> {
    const current = await this.inspectPane(expected.paneId);
    return (
      current.targetId === expected.targetId &&
      current.generation === expected.generation &&
      current.sessionId === expected.sessionId &&
      current.windowId === expected.windowId &&
      processIdentityMatches(
        this.#processEvidence.read(expected.paneProcess.pid),
        expected.paneProcess,
      )
    );
  }

  async inspectPane(paneId: string): Promise<TmuxPrivateProof> {
    return this.privateProof(await this.#inspectPaneProof(paneId));
  }

  async inspectMutablePane(paneId: string): Promise<TmuxMutableProof> {
    return this.mutableProof(await this.#inspectPaneProof(paneId));
  }

  async #inspectPaneProof(paneId: string): Promise<TmuxPaneProof> {
    const output = await this.#run(
      ["display-message", "-p", "-t", paneId, tmuxPaneProofFormat],
      "inspect",
    );
    return parseTmuxPaneProof(output.stdout);
  }

  async listProofs(): Promise<TmuxPaneProof[]> {
    const output = await this.#run(["list-panes", "-a", "-F", tmuxPaneProofFormat], "release");
    return parseTmuxPaneProofLines(output.stdout);
  }

  privateProof(proof: TmuxPaneProof): TmuxPrivateProof {
    const mutable = this.mutableProof(proof);
    const paneProcess = this.#processEvidence.read(proof.panePid);
    if (paneProcess === undefined) {
      throw placementRejected("tmux process evidence changed during validation.");
    }
    return {
      ...mutable,
      paneProcess: { pid: paneProcess.pid, startToken: paneProcess.startToken },
    };
  }

  mutableProof(proof: TmuxPaneProof): TmuxMutableProof {
    const server = this.serverProof(proof);
    const result: TmuxMutableProof = {
      ...server,
      sessionId: proof.sessionId,
      sessionName: proof.sessionName,
      windowId: proof.windowId,
      paneId: proof.paneId,
      panePid: proof.panePid,
      targetId: buildTmuxTargetId({
        generation: server.generation,
        sessionId: proof.sessionId,
        windowId: proof.windowId,
        paneId: proof.paneId,
      }),
    };
    if (proof.stationSessionId.length > 0) result.stationSessionId = proof.stationSessionId;
    return result;
  }

  serverProof(
    proof: TmuxPaneProof,
  ): Pick<TmuxPrivateProof, "socketPath" | "socket" | "serverProcess" | "generation"> {
    const configuredSocket = this.#config.workbenchSocketPath;
    if (
      configuredSocket !== undefined &&
      normalizedSocketPath(configuredSocket) !== normalizedSocketPath(proof.socketPath)
    ) {
      throw callerContextRejected(
        "tmux reported a different socket than the configured workbench endpoint.",
        "Check [terminal.tmux].workbench_socket_path and restart Observer.",
      );
    }
    const socket = this.#socketEvidence(proof.socketPath);
    const serverProcess = this.#processEvidence.read(proof.serverPid);
    if (serverProcess === undefined) {
      throw placementRejected("tmux process evidence changed during validation.");
    }
    const process = { pid: serverProcess.pid, startToken: serverProcess.startToken };
    return {
      socketPath: proof.socketPath,
      socket,
      serverProcess: process,
      generation: serverGeneration({
        socketPath: proof.socketPath,
        socket,
        serverProcess: process,
      }),
    };
  }
}

function parseCallerClaim(
  caller: TerminalCallerContextRequest,
): z.infer<typeof TmuxCallerClaimSchema> | undefined {
  const tmux = caller.claims.TMUX;
  const paneId = caller.claims.TMUX_PANE;
  if (tmux === undefined && paneId === undefined) return undefined;
  if (tmux === undefined || paneId === undefined) {
    throw callerContextRejected("The tmux caller claim is incomplete.");
  }
  const parsed = TmuxCallerClaimSchema.safeParse([...tmux.split(","), paneId]);
  if (!parsed.success) throw callerContextRejected("The tmux caller claim is malformed.");
  return parsed.data;
}

function readSocketEvidence(path: string): SocketEvidence {
  try {
    const stat = statSync(path, { bigint: true });
    return { device: stat.dev.toString(), inode: stat.ino.toString() };
  } catch (cause) {
    throw placementRejected("The configured tmux server socket is unavailable.", cause);
  }
}

function normalizedSocketPath(path: string): string {
  return normalizeObservedPath(resolve(path));
}

function serverGeneration(input: {
  socketPath: string;
  socket: SocketEvidence;
  serverProcess: { pid: number; startToken: string };
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        socketPath: normalizedSocketPath(input.socketPath),
        device: input.socket.device,
        inode: input.socket.inode,
        serverPid: input.serverProcess.pid,
        serverStartToken: input.serverProcess.startToken,
      }),
    )
    .digest("hex");
}
