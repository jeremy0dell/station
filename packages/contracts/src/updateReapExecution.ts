import { z } from "zod";
import { ProjectIdSchema, ProviderIdSchema, SessionIdSchema, WorktreeIdSchema } from "./ids.js";
import { nonEmptyStringSchema } from "./shared.js";
import { StationBuildIdentitySchema } from "./stationBuildIdentity.js";
import {
  compareStationHostTerminalLifetimeIdentity,
  stationHostTerminalLifetimeIdentitiesAreCanonical,
} from "./stationHostInspection.js";
import { UpdateChannelIdSchema, UpdateCommandArgvSchema } from "./update.js";
import { UpdateArtifactSchema } from "./updateArtifact.js";

export const UpdateReapJournalPhaseSchema = z.enum([
  "authorized",
  "recovery-prepared",
  "reap-started",
  "incumbent-host-empty",
  "artifact-applied",
  "hooks-converged",
  "observer-converged",
  "host-converged",
  "persisted-reconciled",
  "sessions-resumed",
  "verified",
  "completed",
]);
export type UpdateReapJournalPhase = z.infer<typeof UpdateReapJournalPhaseSchema>;

export const UpdateReapTerminationOutcomeSchema = z.enum([
  "already-exited",
  "terminated",
  "killed",
  "unresolved",
]);
export const UpdateReapResumeDispositionSchema = z.enum([
  "resumed",
  "retained",
  "non-resumable",
  "unresolved",
]);

export const UpdateReapTerminalResultSchema = z
  .object({
    terminalTargetId: nonEmptyStringSchema,
    ptyId: nonEmptyStringSchema,
    ptyInstanceId: nonEmptyStringSchema,
    sessionId: SessionIdSchema,
    terminationOutcome: UpdateReapTerminationOutcomeSchema,
    escalationUsed: z.boolean(),
    resumeDisposition: UpdateReapResumeDispositionSchema,
    unresolved: z.boolean(),
    recoveryCommands: z.array(UpdateCommandArgvSchema),
  })
  .strict()
  .superRefine((result, context) => {
    const unresolved =
      result.terminationOutcome === "unresolved" || result.resumeDisposition === "unresolved";
    if (result.unresolved !== unresolved) {
      context.addIssue({
        code: "custom",
        path: ["unresolved"],
        message: "Unresolved state must match termination and resume disposition.",
      });
    }
    if (
      (result.terminationOutcome === "killed" && !result.escalationUsed) ||
      (result.terminationOutcome !== "killed" &&
        result.terminationOutcome !== "unresolved" &&
        result.escalationUsed)
    ) {
      context.addIssue({
        code: "custom",
        path: ["escalationUsed"],
        message: "Escalation must report whether SIGKILL was sent.",
      });
    }
  });
export type UpdateReapTerminalResult = z.infer<typeof UpdateReapTerminalResultSchema>;

/** Strict redacted result for explicitly authorized terminal reaping and session recovery. */
export const UpdateReapRecoveryResultSchema = z
  .object({
    status: z.enum(["completed", "partial", "refused"]),
    terminals: z.array(UpdateReapTerminalResultSchema),
    unresolved: z.boolean(),
    recoveryCommands: z.array(UpdateCommandArgvSchema),
  })
  .strict()
  .superRefine((result, context) => {
    if (!stationHostTerminalLifetimeIdentitiesAreCanonical(result.terminals)) {
      context.addIssue({
        code: "custom",
        path: ["terminals"],
        message: "Reap terminal results must be unique and deterministically sorted.",
      });
    }
    const unresolved = result.terminals.some((terminal) => terminal.unresolved);
    if (result.unresolved !== unresolved) {
      context.addIssue({
        code: "custom",
        path: ["unresolved"],
        message: "Aggregate unresolved state must match terminal results.",
      });
    }
    if (
      (result.status === "completed" && unresolved) ||
      (result.status === "partial" && !unresolved)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Completed reap results cannot contain unresolved terminals.",
      });
    }
  });
export type UpdateReapRecoveryResult = z.infer<typeof UpdateReapRecoveryResultSchema>;

const privateProcessSchema = z
  .object({
    pid: z.number().int().positive(),
    parentPid: z.number().int().nonnegative(),
    pgid: z.number().int().positive(),
    startToken: nonEmptyStringSchema,
  })
  .strict();

const privateProcessGroupSchema = z
  .object({
    leader: privateProcessSchema,
    members: z.array(privateProcessSchema).min(1),
  })
  .strict()
  .superRefine((group, context) => {
    if (group.leader.pid !== group.leader.pgid) {
      context.addIssue({
        code: "custom",
        path: ["leader", "pgid"],
        message: "A reap target must be its process-group leader.",
      });
    }
    if (
      group.members.some(
        (member, index) =>
          member.pgid !== group.leader.pgid ||
          (index > 0 && (group.members[index - 1]?.pid ?? member.pid) >= member.pid),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["members"],
        message: "Process-group members must share one PGID and be uniquely sorted by PID.",
      });
    }
    if (!group.members.some((member) => member.pid === group.leader.pid)) {
      context.addIssue({
        code: "custom",
        path: ["members"],
        message: "Process-group membership must include its leader.",
      });
    }
  });

const privateTerminalSchema = z
  .object({
    kind: z.enum(["agent", "aux"]),
    terminalTargetId: nonEmptyStringSchema,
    ptyId: nonEmptyStringSchema,
    ptyInstanceId: nonEmptyStringSchema,
    projectId: ProjectIdSchema,
    worktreeId: WorktreeIdSchema,
    sessionId: SessionIdSchema,
    harnessProvider: ProviderIdSchema,
    pid: z.number().int().positive(),
  })
  .strict();

const privateRecoverySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("selected"),
      projectId: ProjectIdSchema,
      worktreeId: WorktreeIdSchema,
      sessionId: SessionIdSchema,
      handleId: nonEmptyStringSchema,
    })
    .strict(),
  z.object({ kind: z.literal("non-resumable") }).strict(),
]);

export const UpdateReapJournalTargetSchema = z
  .object({
    terminal: privateTerminalSchema,
    processGroup: privateProcessGroupSchema,
    recovery: privateRecoverySchema,
    result: UpdateReapTerminalResultSchema.optional(),
  })
  .strict()
  .superRefine((target, context) => {
    if (target.processGroup.leader.pid !== target.terminal.pid) {
      context.addIssue({
        code: "custom",
        path: ["processGroup", "leader", "pid"],
        message: "The terminal child must be the authorized process-group leader.",
      });
    }
    if (
      target.recovery.kind === "selected" &&
      (target.recovery.projectId !== target.terminal.projectId ||
        target.recovery.worktreeId !== target.terminal.worktreeId ||
        target.recovery.sessionId !== target.terminal.sessionId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["recovery"],
        message: "Selected recovery identity must match its exact reaped terminal.",
      });
    }
  });
export type UpdateReapJournalTarget = z.infer<typeof UpdateReapJournalTargetSchema>;

/** Strict private restart journal. The filesystem adapter keeps this payload mode 0600. */
export const UpdateReapJournalSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().uuid(),
    authorizationDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    phase: UpdateReapJournalPhaseSchema,
    channel: UpdateChannelIdSchema,
    selectedArtifact: UpdateArtifactSchema,
    installedScopeDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    host: z
      .object({
        socketPath: nonEmptyStringSchema,
        inode: z.string().regex(/^\d+$/u),
        birthtimeNs: z.string().regex(/^\d+$/u),
        buildVersion: nonEmptyStringSchema,
        buildIdentity: StationBuildIdentitySchema,
        process: privateProcessSchema.pick({ pid: true, startToken: true }).strict(),
      })
      .strict(),
    targets: z.array(UpdateReapJournalTargetSchema).min(1),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((journal, context) => {
    if (
      !stationHostTerminalLifetimeIdentitiesAreCanonical(journal.targets.map((x) => x.terminal))
    ) {
      context.addIssue({
        code: "custom",
        path: ["targets"],
        message: "Journal targets must be unique and deterministically sorted.",
      });
    }
    const sessionIds = journal.targets
      .filter((target) => target.recovery.kind === "selected")
      .map((target) => target.terminal.sessionId);
    if (new Set(sessionIds).size !== sessionIds.length) {
      context.addIssue({
        code: "custom",
        path: ["targets"],
        message: "Recoverable journal sessions must be unique.",
      });
    }
    if (
      journal.phase === "completed" &&
      journal.targets.some((target) => target.result === undefined || target.result.unresolved)
    ) {
      context.addIssue({
        code: "custom",
        path: ["phase"],
        message: "Completed journals require resolved results for every target.",
      });
    }
  });
export type UpdateReapJournal = z.infer<typeof UpdateReapJournalSchema>;

export function compareUpdateReapJournalTargets(
  left: UpdateReapJournalTarget,
  right: UpdateReapJournalTarget,
): number {
  return compareStationHostTerminalLifetimeIdentity(left.terminal, right.terminal);
}
