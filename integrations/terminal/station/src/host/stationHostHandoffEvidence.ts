import {
  compareStationHostTerminalLifetimeIdentity,
  type PtyHandoffManifest,
  type StationHostConvergenceCommand,
  type StationHostHandoffReceipt,
  StationHostHandoffReceiptSchema,
  type StationHostTerminalLifetime,
} from "@station/contracts";
import { type HostBeginHandoffOutcome, stationHostSafeError } from "@station/host";

type HandoffCommand = Extract<StationHostConvergenceCommand, { action: "handoff" }>;
type AcceptedHandoffBegin = Extract<HostBeginHandoffOutcome, { status: "accepted" }>["result"];
type TerminalLifetimeIdentity = {
  terminalTargetId: string;
  ptyId: string;
  ptyInstanceId: string;
};

export function validateStationHostHandoffBegin(
  command: HandoffCommand,
  result: AcceptedHandoffBegin,
): { manifest: PtyHandoffManifest; receipt: StationHostHandoffReceipt } {
  const terminals = Object.entries(result.manifest)
    .map(([ptyId, entry]) => ({
      terminalTargetId: entry.identity.terminalTargetId,
      ptyId,
      ptyInstanceId: entry.ptyInstanceId,
    }))
    .sort(compareStationHostTerminalLifetimeIdentity);
  const receipt = StationHostHandoffReceiptSchema.parse({ fidelity: result.fidelity, terminals });
  if (
    result.fidelity !== command.fidelity ||
    result.skipped.length > 0 ||
    !stationHostHandoffPtyIdsMatch(result.released, command) ||
    !stationHostTerminalIdentitiesMatch(receipt.terminals, command.expected.terminals)
  )
    throw invalidHandoffEvidence("Handoff manifest identity or fidelity drifted.");

  for (const expected of command.expected.terminals) {
    const entry = result.manifest[expected.ptyId];
    if (
      entry === undefined ||
      entry.identity.kind !== expected.kind ||
      entry.identity.worktreeId !== expected.worktreeId ||
      entry.identity.projectId !== expected.projectId ||
      entry.identity.sessionId !== expected.sessionId ||
      entry.identity.worktreePath !== expected.worktreePath ||
      entry.identity.harnessProvider !== expected.harnessProvider ||
      entry.cols !== expected.cols ||
      entry.rows !== expected.rows
    )
      throw invalidHandoffEvidence("Handoff manifest terminal facts drifted.");
  }
  return { manifest: result.manifest, receipt };
}

export function stationHostHandoffPtyIdsMatch(
  actual: readonly string[],
  command: HandoffCommand,
): boolean {
  const uniqueActual = [...new Set(actual)].sort();
  const expected = command.expected.terminals.map(({ ptyId }) => ptyId).sort();
  return (
    uniqueActual.length === expected.length &&
    uniqueActual.every((value, index) => value === expected[index])
  );
}

export function stationHostTerminalIdentitiesMatch(
  actual: readonly TerminalLifetimeIdentity[],
  expected: readonly TerminalLifetimeIdentity[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((terminal, index) => {
      const expectedTerminal = expected[index];
      return (
        expectedTerminal !== undefined &&
        terminal.terminalTargetId === expectedTerminal.terminalTargetId &&
        terminal.ptyId === expectedTerminal.ptyId &&
        terminal.ptyInstanceId === expectedTerminal.ptyInstanceId
      );
    })
  );
}

/** Requires every canonical recovery-inventory fact for each physical terminal lifetime to match. */
export function stationHostTerminalLifetimesMatch(
  actual: readonly StationHostTerminalLifetime[],
  expected: readonly StationHostTerminalLifetime[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((terminal, index) => {
      const expectedTerminal = expected[index];
      return (
        expectedTerminal !== undefined &&
        terminal.kind === expectedTerminal.kind &&
        terminal.terminalTargetId === expectedTerminal.terminalTargetId &&
        terminal.ptyId === expectedTerminal.ptyId &&
        terminal.ptyInstanceId === expectedTerminal.ptyInstanceId &&
        terminal.worktreeId === expectedTerminal.worktreeId &&
        terminal.projectId === expectedTerminal.projectId &&
        terminal.sessionId === expectedTerminal.sessionId &&
        terminal.worktreePath === expectedTerminal.worktreePath &&
        terminal.harnessProvider === expectedTerminal.harnessProvider &&
        terminal.pid === expectedTerminal.pid &&
        terminal.alive === expectedTerminal.alive &&
        terminal.cols === expectedTerminal.cols &&
        terminal.rows === expectedTerminal.rows &&
        handoffSupportMatches(terminal.handoffSupport, expectedTerminal.handoffSupport)
      );
    })
  );
}

function handoffSupportMatches(
  actual: StationHostTerminalLifetime["handoffSupport"],
  expected: StationHostTerminalLifetime["handoffSupport"],
): boolean {
  if (actual.kind !== expected.kind) return false;
  if (actual.kind === "bridge-releasable") return true;
  return expected.kind === "non-releasable" && actual.reason === expected.reason;
}

function invalidHandoffEvidence(message: string) {
  return stationHostSafeError("HOST_HANDOFF_MANIFEST_INVALID", message);
}
