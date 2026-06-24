import { z } from "zod";
import { TerminalFocusOriginSchema } from "./commands.js";
import { SafeErrorSchema } from "./errors.js";
import {
  CommandIdSchema,
  ProjectIdSchema,
  ProviderIdSchema,
  SessionIdSchema,
  TimestampSchema,
  WorktreeIdSchema,
} from "./ids.js";
import { WorktreeObservationSchema } from "./observations.js";
import { HarnessPermissionModeSchema, ProviderProjectConfigSchema } from "./providers.js";
import { HarnessResumeOptionsSchema } from "./recovery.js";
import { nonEmptyStringSchema } from "./shared.js";

export const TerminalIntentTypeSchema = z.enum([
  "session.ensureAgentWorkspace",
  "terminal.focus",
  "terminal.close",
]);

export type TerminalIntentType = z.infer<typeof TerminalIntentTypeSchema>;

export const TerminalIntentSubjectSchema = z
  .object({
    projectId: ProjectIdSchema.optional(),
    worktreeId: WorktreeIdSchema.optional(),
    sessionId: SessionIdSchema.optional(),
  })
  .strict()
  .refine(
    (subject) => subject.worktreeId !== undefined || subject.sessionId !== undefined,
    "terminal intent subject requires worktreeId or sessionId",
  );

export type TerminalIntentSubject = z.infer<typeof TerminalIntentSubjectSchema>;

export const EnsureAgentWorkspaceHarnessOptionsSchema = z
  .object({
    provider: ProviderIdSchema,
    mode: z.enum(["interactive", "exec"]).optional(),
    profile: nonEmptyStringSchema.optional(),
    permissionMode: HarnessPermissionModeSchema.optional(),
    approvalPolicy: nonEmptyStringSchema.optional(),
    sandboxMode: nonEmptyStringSchema.optional(),
  })
  .strict();

export type EnsureAgentWorkspaceHarnessOptions = z.infer<
  typeof EnsureAgentWorkspaceHarnessOptionsSchema
>;

export const EnsureAgentWorkspaceIntentSchema = z
  .object({
    type: z.literal("session.ensureAgentWorkspace"),
    commandId: CommandIdSchema,
    terminalProvider: ProviderIdSchema,
    project: ProviderProjectConfigSchema,
    worktree: WorktreeObservationSchema,
    sessionId: SessionIdSchema,
    harness: EnsureAgentWorkspaceHarnessOptionsSchema,
    layout: nonEmptyStringSchema,
    focus: z.boolean().optional(),
    origin: TerminalFocusOriginSchema.optional(),
    initialPrompt: nonEmptyStringSchema.optional(),
    resume: HarnessResumeOptionsSchema.optional(),
  })
  .strict();

export type EnsureAgentWorkspaceIntent = z.infer<typeof EnsureAgentWorkspaceIntentSchema>;

export const TerminalFocusIntentSchema = z
  .object({
    type: z.literal("terminal.focus"),
    commandId: CommandIdSchema,
    terminalProvider: ProviderIdSchema,
    subject: TerminalIntentSubjectSchema,
    origin: TerminalFocusOriginSchema.optional(),
  })
  .strict();

export type TerminalFocusIntent = z.infer<typeof TerminalFocusIntentSchema>;

export const TerminalCloseIntentSchema = z
  .object({
    type: z.literal("terminal.close"),
    commandId: CommandIdSchema,
    terminalProvider: ProviderIdSchema,
    subject: TerminalIntentSubjectSchema,
    force: z.boolean().optional(),
  })
  .strict();

export type TerminalCloseIntent = z.infer<typeof TerminalCloseIntentSchema>;

export const TerminalIntentSchema = z.discriminatedUnion("type", [
  EnsureAgentWorkspaceIntentSchema,
  TerminalFocusIntentSchema,
  TerminalCloseIntentSchema,
]);

export type TerminalIntent = z.infer<typeof TerminalIntentSchema>;

export const TerminalIntentAcceptedReceiptSchema = z
  .object({
    status: z.literal("accepted"),
    accepted: z.literal(true),
    commandId: CommandIdSchema,
    type: TerminalIntentTypeSchema,
    terminalProvider: ProviderIdSchema,
    timestamp: TimestampSchema,
  })
  .strict();

export type TerminalIntentAcceptedReceipt = z.infer<typeof TerminalIntentAcceptedReceiptSchema>;

export const TerminalIntentRejectedReceiptSchema = z
  .object({
    status: z.literal("rejected"),
    accepted: z.literal(false),
    commandId: CommandIdSchema,
    type: TerminalIntentTypeSchema,
    terminalProvider: ProviderIdSchema,
    timestamp: TimestampSchema,
    error: SafeErrorSchema,
  })
  .strict();

export type TerminalIntentRejectedReceipt = z.infer<typeof TerminalIntentRejectedReceiptSchema>;

export const TerminalIntentReceiptSchema = z.discriminatedUnion("status", [
  TerminalIntentAcceptedReceiptSchema,
  TerminalIntentRejectedReceiptSchema,
]);

export type TerminalIntentReceipt = z.infer<typeof TerminalIntentReceiptSchema>;
