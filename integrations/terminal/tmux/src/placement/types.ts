import type { TerminalTargetId } from "@station/contracts";
import type { ExternalCommandResult } from "@station/runtime";

export type SocketEvidence = {
  device: string;
  inode: string;
};

export type TmuxMutableProof = {
  socketPath: string;
  socket: SocketEvidence;
  serverProcess: { pid: number; startToken: string };
  sessionId: string;
  sessionName: string;
  windowId: string;
  paneId: string;
  panePid: number;
  generation: string;
  targetId: TerminalTargetId;
  stationSessionId?: string;
};

export type TmuxPrivateProof = TmuxMutableProof & {
  paneProcess: { pid: number; startToken: string };
};

export type PlacementCommandOperation = "inspect" | "validate" | "open" | "release";

export type PlacementCommandRunner = (
  args: string[],
  operation: PlacementCommandOperation,
) => Promise<ExternalCommandResult>;
