import { z } from "zod";
import {
  ProjectIdSchema,
  ProviderIdSchema,
  SessionIdSchema,
  TerminalTargetIdSchema,
  TimestampSchema,
  WorktreeIdSchema,
} from "./ids.js";
import { nonEmptyStringSchema } from "./shared.js";

// Recovery is exact-handle based. "latest", "continue", and picker semantics
// stay outside this contract so clients cannot trigger ambiguous recovery.
export const HarnessResumeTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("native-session"),
      id: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("session-file"),
      path: nonEmptyStringSchema,
    })
    .strict(),
]);

export type HarnessResumeTarget = z.infer<typeof HarnessResumeTargetSchema>;

export const HarnessResumeOptionsSchema = z
  .object({
    target: HarnessResumeTargetSchema,
    previousSessionId: SessionIdSchema.optional(),
    recoveryHandleId: nonEmptyStringSchema.optional(),
  })
  .strict();

export type HarnessResumeOptions = z.infer<typeof HarnessResumeOptionsSchema>;

export const SessionRecoveryHandleSchema = z
  .object({
    id: nonEmptyStringSchema,
    provider: ProviderIdSchema,
    projectId: ProjectIdSchema,
    worktreeId: WorktreeIdSchema,
    sessionId: SessionIdSchema.optional(),
    target: HarnessResumeTargetSchema,
    // Runtime context is useful for observer-side safety checks, but clients
    // receive only WorktreeRecoveryAction and never see raw ids or file paths.
    cwd: nonEmptyStringSchema.optional(),
    terminalTargetId: TerminalTargetIdSchema.optional(),
    harnessRunId: nonEmptyStringSchema.optional(),
    observedAt: TimestampSchema,
    lastSeenAt: TimestampSchema,
  })
  .strict();

export type SessionRecoveryHandle = z.infer<typeof SessionRecoveryHandleSchema>;
