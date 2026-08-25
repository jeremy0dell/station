import type { SafeError, SessionGroupRepairSummary } from "@station/contracts";

export type ReconcileTiming = {
  reason: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  projectsScanned: number;
  worktreesObserved: number;
  terminalTargetsObserved: number;
  harnessRunsObserved: number;
  eventsEmitted: number;
  errors: SafeError[];
  sessionGroupRepair?: SessionGroupRepairSummary;
};
