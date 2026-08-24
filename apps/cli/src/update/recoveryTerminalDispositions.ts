import {
  compareCodeUnitStrings,
  compareUpdateReapTerminalIdentity,
  type UpdateReapHostEvidence,
  type UpdateReapObserverEvidence,
  type UpdateReapTerminalDisposition,
  type UpdateReapTerminalDispositionReason,
} from "@station/contracts";

/**
 * POLICY
 *
 * Derives the one canonical set of terminal handoff and recovery dispositions from #639's raw
 * aggregate evidence. The result describes consequences only and grants no recovery or reap
 * authority.
 */
export function deriveUpdateRecoveryTerminalDispositions(input: {
  host: UpdateReapHostEvidence;
  observer: UpdateReapObserverEvidence;
}): UpdateReapTerminalDisposition[] {
  if (input.host.status !== "inspected") return [];
  const sessions = new Map(
    input.observer.status === "exact" && input.observer.recovery.status === "assessed"
      ? input.observer.recovery.assessment.sessions.map((session) => [session.sessionId, session])
      : [],
  );
  return input.host.terminals
    .map((terminal): UpdateReapTerminalDisposition => {
      const reasons: UpdateReapTerminalDispositionReason[] = [];
      const handoff =
        terminal.handoffSupport === "bridge-releasable"
          ? "preservable"
          : terminal.handoffSupport === "non-releasable"
            ? "non-preservable"
            : "unknown";
      if (handoff === "unknown") reasons.push("handoff_support_unknown");

      const session = sessions.get(terminal.sessionId);
      let reapRecovery: UpdateReapTerminalDisposition["reapRecovery"];
      if (terminal.kind === "aux") {
        reapRecovery = "non-resumable";
        reasons.push("aux_terminal_not_resumable");
      } else if (session === undefined) {
        reapRecovery =
          input.observer.status === "exact" && input.observer.recovery.status === "assessed"
            ? "non-resumable"
            : "unknown";
        reasons.push(
          reapRecovery === "non-resumable"
            ? "retained_session_missing"
            : "session_recovery_unknown",
        );
      } else if (
        session.projectId !== terminal.projectId ||
        session.worktreeId !== terminal.worktreeId ||
        session.harnessProvider !== terminal.harnessProvider
      ) {
        reapRecovery = "unknown";
        reasons.push("retained_session_identity_mismatch");
      } else if (session.disposition === "recoverable") {
        reapRecovery = "recoverable";
      } else if (session.disposition === "unknown") {
        reapRecovery = "unknown";
        reasons.push("session_recovery_unknown");
      } else {
        reapRecovery = "non-resumable";
        reasons.push("session_non_resumable");
      }
      return {
        terminalTargetId: terminal.terminalTargetId,
        ptyId: terminal.ptyId,
        ptyInstanceId: terminal.ptyInstanceId,
        sessionId: terminal.sessionId,
        handoff,
        reapRecovery,
        reasons: Array.from(new Set(reasons)).sort(compareCodeUnitStrings),
      };
    })
    .sort(compareUpdateReapTerminalIdentity);
}
