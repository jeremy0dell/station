import net from "node:net";
import {
  compareStationHostTerminalLifetimeIdentity,
  type PtyBridgeStatus,
  PtyBridgeStatusCommandSchema,
  PtyBridgeStatusSchema,
  type PtyHandoffEntry,
  type StationHostExactEvidence,
  type UpdateReapTerminalEvidence,
} from "@station/contracts";
import { stationHostErrorFromUnknown, stationHostSafeError } from "@station/host";
import {
  loadParkedOrphanRecoveryEvidence,
  type ParkedOrphanRecoveryEvidence,
  stationHostTerminalConflictsWithUnownedPark,
  stationHostTerminalMatchesParkedOrphan,
} from "./orphanRecovery.js";

const MAX_STATUS_LINE_CHARS = 16 * 1024;
const parkedTerminalIdentities = Symbol("station.parked-terminal-identities");

/** DRIVEN PORT: supplies durable park evidence, read-only bridge status, and one clock. */
export type ParkedOrphanRecoveryPreflightPorts = {
  loadRecoveryEvidence(stateDir: string): Promise<ParkedOrphanRecoveryEvidence>;
  readBridgeStatus(controlSocket: string, deadlineMs: number): Promise<PtyBridgeStatus>;
  now(): number;
};

/**
 * COMPOSITION ROOT
 *
 * Binds durable filesystem evidence, local bridge status, and the absolute preflight clock.
 */
export function preflightParkedOrphanRecovery(
  options: {
    stateDir: string;
    currentHostEvidence?: StationHostExactEvidence;
    deadlineMs?: number;
  },
  deps: Partial<ParkedOrphanRecoveryPreflightPorts> = {},
): Promise<ParkedOrphanRecoveryPreflightResult> {
  const now = deps.now ?? Date.now;
  const deadlineMs = options.deadlineMs ?? now() + 5_000;
  return executeParkedOrphanRecoveryPreflight(
    {
      stateDir: options.stateDir,
      ...(options.currentHostEvidence === undefined
        ? {}
        : { currentHostEvidence: options.currentHostEvidence }),
      deadlineMs,
    },
    {
      loadRecoveryEvidence: deps.loadRecoveryEvidence ?? loadParkedOrphanRecoveryEvidence,
      readBridgeStatus: deps.readBridgeStatus ?? readParkedBridgeStatus,
      now,
    },
  );
}

/**
 * USE CASE
 *
 * Proves every durable live park is currently reachable and still identifies the same bridge and
 * PTY without starting a Host or requesting ownership transfer. Unowned parks must also be
 * disjoint from every independently unique lifetime identity in the current Host inventory.
 */
export async function executeParkedOrphanRecoveryPreflight(
  input: {
    stateDir: string;
    currentHostEvidence?: StationHostExactEvidence;
    deadlineMs: number;
  },
  ports: ParkedOrphanRecoveryPreflightPorts,
): Promise<ParkedOrphanRecoveryPreflightResult> {
  const evidence = await ports.loadRecoveryEvidence(input.stateDir);
  const { deadlineMs } = input;
  const now = ports.now;
  if (now() >= deadlineMs) throw invalidParkViabilityError();
  let unownedParkedCount = 0;
  const unownedTerminals: UpdateReapTerminalEvidence[] = [];
  for (const [ptyId, entry] of Object.entries(evidence.manifest)) {
    if (now() >= deadlineMs) throw invalidParkViabilityError();
    let status: PtyBridgeStatus;
    try {
      status = await ports.readBridgeStatus(entry.controlSocket, deadlineMs);
    } catch (error) {
      throw stationHostErrorFromUnknown(error, {
        code: "HOST_HANDOFF_MANIFEST_INVALID",
        message: "A parked terminal was not reachable for update recovery.",
        hint: "The update was not installed; inspect parked bridge status and retry.",
      });
    }
    assertBridgeMatchesPark(
      ptyId,
      entry,
      evidence.payloadPids[ptyId],
      status,
      input.currentHostEvidence,
    );
    if (!status.adopted) {
      unownedParkedCount += 1;
      unownedTerminals.push({
        kind: entry.identity.kind,
        terminalTargetId: entry.identity.terminalTargetId,
        ptyId,
        ptyInstanceId: entry.ptyInstanceId,
        projectId: entry.identity.projectId,
        worktreeId: entry.identity.worktreeId,
        sessionId: entry.identity.sessionId,
        harnessProvider: entry.identity.harnessProvider,
        alive: true,
        handoffSupport: "bridge-releasable",
      });
    }
  }
  if (now() >= deadlineMs) throw invalidParkViabilityError();
  unownedTerminals.sort(compareStationHostTerminalLifetimeIdentity);
  const result: ParkedOrphanRecoveryPreflightResult = {
    totalParkedCount: Object.keys(evidence.manifest).length,
    unownedParkedCount,
    adoptionRequiredCount: unownedParkedCount,
  };
  Object.defineProperty(result, parkedTerminalIdentities, {
    value: unownedTerminals,
    enumerable: false,
  });
  return result;
}

export type ParkedOrphanRecoveryPreflightResult = {
  totalParkedCount: number;
  unownedParkedCount: number;
  adoptionRequiredCount: number;
};

/** Returns exact unowned park identities only to the composing update invocation. */
export function parkedOrphanTerminalEvidence(
  result: ParkedOrphanRecoveryPreflightResult,
): readonly UpdateReapTerminalEvidence[] {
  return (
    (
      result as ParkedOrphanRecoveryPreflightResult & {
        [parkedTerminalIdentities]?: readonly UpdateReapTerminalEvidence[];
      }
    )[parkedTerminalIdentities] ?? []
  );
}

function assertBridgeMatchesPark(
  ptyId: string,
  entry: PtyHandoffEntry,
  payloadPid: number | undefined,
  status: PtyBridgeStatus,
  currentHostEvidence: StationHostExactEvidence | undefined,
): void {
  if (
    status.bridgeProtocol !== entry.bridgeProtocolVersion ||
    status.ptyInstanceId !== entry.ptyInstanceId ||
    status.pid !== payloadPid ||
    status.bridgePid !== entry.bridgePid ||
    status.cols !== entry.cols ||
    status.rows !== entry.rows ||
    status.exited
  ) {
    throw invalidParkViabilityError(ptyId);
  }
  if (!status.adopted) {
    if (
      currentHostEvidence?.terminals.some((terminal) =>
        stationHostTerminalConflictsWithUnownedPark(terminal, ptyId, entry),
      ) === true
    ) {
      throw invalidParkViabilityError(ptyId);
    }
    return;
  }
  const owned = currentHostEvidence?.terminals.find((terminal) => terminal.ptyId === ptyId);
  if (
    owned === undefined ||
    !stationHostTerminalMatchesParkedOrphan(owned, ptyId, entry, payloadPid)
  ) {
    throw invalidParkViabilityError(ptyId);
  }
}

function readParkedBridgeStatus(
  controlSocket: string,
  deadlineMs: number,
): Promise<PtyBridgeStatus> {
  return new Promise((resolve, reject) => {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      reject(invalidParkViabilityError());
      return;
    }
    const socket = net.connect(controlSocket);
    let settled = false;
    let buffer = "";
    const timer = setTimeout(
      () => finish(new Error("Parked bridge status timed out.")),
      remainingMs,
    );
    const finish = (error?: unknown, status?: PtyBridgeStatus): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error !== undefined) reject(error);
      else if (status !== undefined) resolve(status);
      else reject(new Error("Parked bridge status was unavailable."));
    };
    socket.setEncoding("utf8");
    socket.on("error", finish);
    socket.on("close", () => finish(new Error("Parked bridge closed without status.")));
    socket.on("connect", () => {
      const command = PtyBridgeStatusCommandSchema.parse({
        type: "exit-status",
      });
      socket.write(`${JSON.stringify(command)}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_STATUS_LINE_CHARS) {
        finish(new Error("Parked bridge status exceeded the bounded reply size."));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        finish(undefined, PtyBridgeStatusSchema.parse(JSON.parse(buffer.slice(0, newline))));
      } catch (error) {
        finish(error);
      }
    });
  });
}

function invalidParkViabilityError(ptyId?: string) {
  return stationHostSafeError(
    "HOST_HANDOFF_MANIFEST_INVALID",
    ptyId === undefined
      ? "Parked terminal recovery viability could not be proved."
      : `Parked terminal ${ptyId} no longer matched its durable recovery evidence.`,
    {
      hint: "The update was not installed; inspect parked bridge status and retry.",
    },
  );
}
