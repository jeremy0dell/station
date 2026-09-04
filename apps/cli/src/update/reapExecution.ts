import { randomUUID } from "node:crypto";
import {
  type UpdateReapJournal,
  UpdateReapJournalSchema,
  type UpdateReapRecoveryPreflight,
  type UpdateReapRecoveryResult,
  UpdateReapRecoveryResultSchema,
  type UpdateReapTerminalResult,
} from "@station/contracts";
import {
  advanceUpdateReapJournal,
  type UpdateReapJournalPort,
  updateReapJournalHasReached,
  updateReapJournalTargets,
} from "./reapJournal.js";
import type { UpdateReapAuthorization } from "./reapPlan.js";
import {
  type UpdateReapProcessGroupPort,
  updateReapProcessGroupIsAuthorizedRemainder,
  updateReapProcessGroupsMatch,
} from "./reapProcessGroups.js";

export type ExecuteUpdateReapInput = {
  expected: {
    channel: UpdateReapJournal["channel"];
    selectedArtifact: UpdateReapJournal["selectedArtifact"];
    installedScopeDigest: string;
  };
  authorization?: UpdateReapAuthorization;
  reauthorize?: () => Promise<UpdateReapAuthorization>;
  journal: UpdateReapJournalPort;
  processGroups: UpdateReapProcessGroupPort;
  signal?: AbortSignal;
  now?: () => string;
  journalId?: () => string;
};

export class UpdateReapAuthorizationRefusedError extends Error {
  override readonly name = "UpdateReapAuthorizationRefusedError";
}

/**
 * USE CASE
 *
 * Repeats authorization under the update lock, commits the private restart journal before any
 * signal, and drains only exact journaled process groups through the fixed TERM/KILL policy.
 */
export async function executeUpdateReap(input: ExecuteUpdateReapInput): Promise<{
  journal: UpdateReapJournal;
  recovery: UpdateReapRecoveryResult;
}> {
  let journal = await input.journal.findIncomplete();
  if (
    journal !== undefined &&
    (journal.channel !== input.expected.channel ||
      journal.selectedArtifact.version !== input.expected.selectedArtifact.version ||
      journal.selectedArtifact.revision !== input.expected.selectedArtifact.revision ||
      journal.installedScopeDigest !== input.expected.installedScopeDigest)
  ) {
    if (!updateReapJournalHasReached(journal, "reap-started")) {
      throw new UpdateReapAuthorizationRefusedError(
        "The incomplete update reap journal belongs to another installation target.",
      );
    }
    throw new Error("The incomplete update reap journal belongs to another installation target.");
  }
  const afterReapStarted =
    journal !== undefined && updateReapJournalHasReached(journal, "reap-started");
  if (!afterReapStarted) {
    if (signalIsAborted(input.signal)) {
      throw new UpdateReapAuthorizationRefusedError("Update reap was cancelled before reaping.");
    }
    if (input.authorization === undefined || input.reauthorize === undefined) {
      throw new UpdateReapAuthorizationRefusedError(
        "A fresh update reap authorization is required.",
      );
    }
    let repeated: UpdateReapAuthorization;
    try {
      repeated = await input.reauthorize();
    } catch {
      throw new UpdateReapAuthorizationRefusedError(
        "Update reap evidence could not be reverified during locked preflight.",
      );
    }
    if (repeated.digest !== input.authorization.digest) {
      throw new UpdateReapAuthorizationRefusedError(
        "Update reap evidence changed during locked preflight.",
      );
    }
    const now = (input.now ?? (() => new Date().toISOString()))();
    journal = UpdateReapJournalSchema.parse({
      schemaVersion: 1,
      id: journal?.id ?? (input.journalId ?? randomUUID)(),
      authorizationDigest: repeated.digest,
      phase: "authorized",
      channel: repeated.channel,
      selectedArtifact: repeated.selectedArtifact,
      installedScopeDigest: repeated.installedScopeDigest,
      host: repeated.host,
      targets: repeated.targets,
      createdAt: journal?.createdAt ?? now,
      updatedAt: now,
    });
    await input.journal.write(journal);
    journal = advanceUpdateReapJournal(journal, "recovery-prepared", now);
    await input.journal.write(journal);
    if (signalIsAborted(input.signal)) {
      throw new UpdateReapAuthorizationRefusedError("Update reap was cancelled before reaping.");
    }
  }
  if (journal === undefined) throw new Error("Update reap journal was unavailable.");
  if (!updateReapJournalHasReached(journal, "incumbent-host-empty")) {
    journal = await reapJournaledProcessGroups(journal, input.journal, input.processGroups);
  }
  return { journal, recovery: recoveryFromUpdateReapJournal(journal) };
}

export async function markUpdateReapPhase(
  journal: UpdateReapJournal,
  phase: UpdateReapJournal["phase"],
  port: UpdateReapJournalPort,
): Promise<UpdateReapJournal> {
  if (updateReapJournalHasReached(journal, phase)) return journal;
  const advanced = advanceUpdateReapJournal(journal, phase);
  await port.write(advanced);
  return advanced;
}

export function recoveryFromUpdateReapJournal(
  journal: UpdateReapJournal,
): UpdateReapRecoveryResult {
  const terminals = journal.targets.map((target): UpdateReapTerminalResult => {
    if (target.result !== undefined) return target.result;
    return {
      terminalTargetId: target.terminal.terminalTargetId,
      ptyId: target.terminal.ptyId,
      ptyInstanceId: target.terminal.ptyInstanceId,
      sessionId: target.terminal.sessionId,
      terminationOutcome: "unresolved",
      escalationUsed: false,
      resumeDisposition: "unresolved",
      unresolved: true,
      recoveryCommands: [["stn", "update", "--reap"]],
    };
  });
  const unresolved = terminals.some((terminal) => terminal.unresolved);
  return UpdateReapRecoveryResultSchema.parse({
    status: unresolved ? "partial" : "completed",
    terminals,
    unresolved,
    recoveryCommands: unresolved ? [["stn", "update", "--reap"]] : [],
  });
}

export function refusedRecoveryFromUpdateReapTargets(
  input: Pick<UpdateReapAuthorization, "targets"> | Pick<UpdateReapJournal, "targets">,
): UpdateReapRecoveryResult {
  const terminals = input.targets.map((target) => terminalResult(target, "unresolved", false));
  return UpdateReapRecoveryResultSchema.parse({
    status: "refused",
    terminals,
    unresolved: terminals.length > 0,
    recoveryCommands: [["stn", "update", "--reap"]],
  });
}

export function refusedRecoveryFromUpdateReapPreflight(
  preflight: UpdateReapRecoveryPreflight,
): UpdateReapRecoveryResult {
  const terminals =
    preflight.host.status === "inspected"
      ? preflight.host.terminals
          .filter((terminal) => terminal.alive)
          .map((terminal) => ({
            terminalTargetId: terminal.terminalTargetId,
            ptyId: terminal.ptyId,
            ptyInstanceId: terminal.ptyInstanceId,
            sessionId: terminal.sessionId,
            terminationOutcome: "unresolved" as const,
            escalationUsed: false,
            resumeDisposition: "unresolved" as const,
            unresolved: true,
            recoveryCommands: [["stn", "update", "--reap"]],
          }))
      : [];
  return UpdateReapRecoveryResultSchema.parse({
    status: "refused",
    terminals,
    unresolved: terminals.length > 0,
    recoveryCommands: [["stn", "update", "--reap"]],
  });
}

async function reapJournaledProcessGroups(
  initial: UpdateReapJournal,
  journalPort: UpdateReapJournalPort,
  processGroups: UpdateReapProcessGroupPort,
): Promise<UpdateReapJournal> {
  let journal = initial;
  if (!updateReapJournalHasReached(journal, "reap-started")) {
    journal = advanceUpdateReapJournal(journal, "reap-started");
    await journalPort.write(journal);
  }
  const targets = await executeJournaledTerminalReapTargets(journal.targets, processGroups, [
    "stn",
    "update",
    "--reap",
  ]);
  journal = updateReapJournalTargets(journal, targets);
  await journalPort.write(journal);
  return journal;
}

/**
 * USE CASE
 *
 * Applies the shared TERM/wait/KILL/postcondition sequence to exact journaled process groups.
 */
export async function executeJournaledTerminalReapTargets(
  initial: UpdateReapJournal["targets"],
  processGroups: UpdateReapProcessGroupPort,
  recoveryCommand: readonly [string, ...string[]],
): Promise<UpdateReapJournal["targets"]> {
  const pending = initial.filter((target) => target.result === undefined);
  const termSent = new Set<number>();
  const results = new Map<number, UpdateReapTerminalResult>();
  for (const target of pending) {
    const current = await readProcessGroup(processGroups, target.processGroup.leader.pgid);
    if (current.status === "unknown") {
      results.set(
        target.terminal.pid,
        terminalResult(target, "unresolved", false, recoveryCommand),
      );
      continue;
    }
    if (current.group.members.length === 0) {
      results.set(
        target.terminal.pid,
        terminalResult(target, "already-exited", false, recoveryCommand),
      );
      continue;
    }
    if (!updateReapProcessGroupsMatch(current.group, target.processGroup)) {
      results.set(
        target.terminal.pid,
        terminalResult(target, "unresolved", false, recoveryCommand),
      );
      continue;
    }
    try {
      processGroups.signal(target.processGroup.leader.pgid, "SIGTERM");
      termSent.add(target.terminal.pid);
    } catch {
      results.set(
        target.terminal.pid,
        terminalResult(target, "unresolved", false, recoveryCommand),
      );
    }
  }
  if (termSent.size > 0) await processGroups.wait(3_000);
  const killSent = new Set<number>();
  for (const target of pending) {
    if (!termSent.has(target.terminal.pid)) continue;
    const current = await readProcessGroup(processGroups, target.processGroup.leader.pgid);
    if (current.status === "unknown") {
      results.set(
        target.terminal.pid,
        terminalResult(target, "unresolved", false, recoveryCommand),
      );
      continue;
    }
    if (current.group.members.length === 0) {
      results.set(
        target.terminal.pid,
        terminalResult(target, "terminated", false, recoveryCommand),
      );
      continue;
    }
    if (!updateReapProcessGroupIsAuthorizedRemainder(current.group, target.processGroup)) {
      results.set(
        target.terminal.pid,
        terminalResult(target, "unresolved", false, recoveryCommand),
      );
      continue;
    }
    try {
      processGroups.signal(target.processGroup.leader.pgid, "SIGKILL");
      killSent.add(target.terminal.pid);
    } catch {
      results.set(
        target.terminal.pid,
        terminalResult(target, "unresolved", false, recoveryCommand),
      );
    }
  }
  if (killSent.size > 0) await processGroups.wait(500);
  for (const target of pending) {
    if (!killSent.has(target.terminal.pid)) continue;
    const current = await readProcessGroup(processGroups, target.processGroup.leader.pgid);
    results.set(
      target.terminal.pid,
      terminalResult(
        target,
        current.status === "exact" && current.group.members.length === 0 ? "killed" : "unresolved",
        true,
        recoveryCommand,
      ),
    );
  }
  return initial.map((target) => ({
    ...target,
    ...(target.result === undefined
      ? {
          result:
            results.get(target.terminal.pid) ??
            terminalResult(target, "unresolved", false, recoveryCommand),
        }
      : {}),
  }));
}

async function readProcessGroup(
  port: UpdateReapProcessGroupPort,
  pgid: number,
): Promise<
  | {
      status: "exact";
      group: Awaited<ReturnType<UpdateReapProcessGroupPort["read"]>>;
    }
  | { status: "unknown" }
> {
  try {
    return { status: "exact", group: await port.read(pgid) };
  } catch {
    return { status: "unknown" };
  }
}

function terminalResult(
  target: UpdateReapJournal["targets"][number],
  terminationOutcome: UpdateReapTerminalResult["terminationOutcome"],
  escalationUsed: boolean,
  recoveryCommand: readonly [string, ...string[]] = ["stn", "update", "--reap"],
): UpdateReapTerminalResult {
  const unresolved = terminationOutcome === "unresolved";
  return {
    terminalTargetId: target.terminal.terminalTargetId,
    ptyId: target.terminal.ptyId,
    ptyInstanceId: target.terminal.ptyInstanceId,
    sessionId: target.terminal.sessionId,
    terminationOutcome,
    escalationUsed,
    resumeDisposition: unresolved
      ? "unresolved"
      : target.recovery.kind === "selected"
        ? "retained"
        : "non-resumable",
    unresolved,
    recoveryCommands: unresolved ? [recoveryCommand] : [],
  };
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
