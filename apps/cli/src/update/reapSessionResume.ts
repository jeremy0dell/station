import type { StationConfig } from "@station/config";
import { type UpdateReapJournal, worktreeHasLiveAgent } from "@station/contracts";
import { createObserverClient } from "@station/protocol";
import { executeTypedObserverCommand } from "../commands/command.js";
import { resolveObserverPaths } from "../paths.js";
import {
  advanceUpdateReapJournal,
  type UpdateReapJournalPort,
  updateReapJournalHasReached,
  updateReapJournalTargets,
} from "./reapJournal.js";

/** DRIVEN PORT: resumes only the exact Station session and recovery handle selected by preflight. */
export interface UpdateReapSessionResumePort {
  inspect(input: {
    projectId: string;
    worktreeId: string;
    sessionId: string;
    harnessProvider: string;
  }): Promise<"pending" | "resumed" | "conflict">;
  resume(input: {
    projectId: string;
    worktreeId: string;
    sessionId: string;
    harnessProvider: string;
    recoveryHandleId: string;
  }): Promise<void>;
}

/** Eagerly resumes every selected recoverable session and leaves failed selections retryable. */
export async function executeUpdateReapSessionResume(
  journal: UpdateReapJournal,
  journalPort: UpdateReapJournalPort,
  resumePort: UpdateReapSessionResumePort,
): Promise<UpdateReapJournal> {
  let next = journal;
  for (const [index, target] of journal.targets.entries()) {
    if (target.recovery.kind !== "selected" || target.result?.resumeDisposition === "resumed") {
      continue;
    }
    if (target.result === undefined || target.result.terminationOutcome === "unresolved") {
      continue;
    }
    const exact = {
      projectId: target.recovery.projectId,
      worktreeId: target.recovery.worktreeId,
      sessionId: target.recovery.sessionId,
      harnessProvider: target.terminal.harnessProvider,
    };
    let resumed = false;
    try {
      const before = await resumePort.inspect(exact);
      if (before === "conflict") throw new Error("The recovery target has another live agent.");
      if (before === "pending") {
        await resumePort.resume({
          ...exact,
          recoveryHandleId: target.recovery.handleId,
        });
      }
      resumed = (await resumePort.inspect(exact)) === "resumed";
    } catch {
      resumed = await resumePort
        .inspect(exact)
        .then((status) => status === "resumed")
        .catch(() => false);
    }
    const updated = {
      ...target,
      result: {
        ...target.result,
        resumeDisposition: resumed ? ("resumed" as const) : ("unresolved" as const),
        unresolved: !resumed,
        recoveryCommands: resumed ? [] : [["stn", "update", "--reap"] as const],
      },
    };
    next = updateReapJournalTargets(
      next,
      next.targets.map((candidate, candidateIndex) =>
        candidateIndex === index ? updated : candidate,
      ),
    );
    await journalPort.write(next);
  }
  if (next.targets.some((target) => target.result === undefined || target.result.unresolved)) {
    return next;
  }
  if (updateReapJournalHasReached(next, "sessions-resumed")) return next;
  next = advanceUpdateReapJournal(next, "sessions-resumed");
  await journalPort.write(next);
  return next;
}

/**
 * ADAPTER
 *
 * Observes the exact Station session around one identity-bound `session.resumeAgent` command.
 */
export function createObserverUpdateReapSessionResumePort(options: {
  config: StationConfig;
  configPath?: string;
  expectedBuildVersion?: string;
}): UpdateReapSessionResumePort {
  return {
    async inspect(input) {
      const client = createObserverClient({
        socketPath: resolveObserverPaths(options.config).socketPath,
        timeoutMs: 30_000,
        ...(options.expectedBuildVersion === undefined
          ? {}
          : { expectedBuildVersion: options.expectedBuildVersion }),
      });
      const row = (await client.getSnapshot()).rows.find(
        (candidate) => candidate.id === input.worktreeId,
      );
      if (row === undefined || row.projectId !== input.projectId) return "conflict";
      if (!worktreeHasLiveAgent(row)) return "pending";
      return row.agent?.sessionId === input.sessionId && row.agent.harness === input.harnessProvider
        ? "resumed"
        : "conflict";
    },
    async resume(input) {
      const outcome = await executeTypedObserverCommand(
        {
          type: "session.resumeAgent",
          payload: {
            projectId: input.projectId,
            worktreeId: input.worktreeId,
            recoveryHandleId: input.recoveryHandleId,
            expected: {
              sessionId: input.sessionId,
              provider: input.harnessProvider,
            },
          },
        },
        {
          config: options.config,
          ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
          timeoutMs: 30_000,
          waitForCompletion: true,
        },
      );
      if (outcome.status !== "succeeded") {
        throw new Error("The exact recovery-handle resume command did not complete successfully.");
      }
    },
  };
}
