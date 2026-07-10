import { z } from "zod";
import { DiagnosticDetailSchema, SafeErrorSchema } from "./errors.js";
import {
  CommandIdSchema,
  ProjectIdSchema,
  ProviderIdSchema,
  SessionIdSchema,
  TimestampSchema,
  WorktreeIdSchema,
} from "./ids.js";
import { nonEmptyStringSchema } from "./shared.js";

export const CommandSourceSchema = z
  .object({
    kind: z.enum(["branch", "pr", "manual"]),
    value: nonEmptyStringSchema,
  })
  .strict();

export const CreateWorktreePayloadSchema = z
  .object({
    projectId: ProjectIdSchema,
    branch: nonEmptyStringSchema,
    base: nonEmptyStringSchema.optional(),
    path: nonEmptyStringSchema.optional(),
    source: CommandSourceSchema.optional(),
  })
  .strict();

export type CreateWorktreePayload = z.infer<typeof CreateWorktreePayloadSchema>;

export const RemoveWorktreePayloadSchema = z
  .object({
    worktreeId: WorktreeIdSchema,
    projectId: ProjectIdSchema.optional(),
    force: z.boolean().optional(),
  })
  .strict();

export type RemoveWorktreePayload = z.infer<typeof RemoveWorktreePayloadSchema>;

// Fork a worktree: new branch off the source HEAD, optionally seeding its working tree.
export const ForkWorktreePayloadSchema = z
  .object({
    projectId: ProjectIdSchema,
    sourceWorktreeId: WorktreeIdSchema,
    branch: nonEmptyStringSchema,
    base: nonEmptyStringSchema.optional(),
    copyDirty: z.boolean().optional(),
  })
  .strict();

export type ForkWorktreePayload = z.infer<typeof ForkWorktreePayloadSchema>;

export const HarnessCommandOptionsSchema = z
  .object({
    provider: ProviderIdSchema,
    mode: z.enum(["interactive", "exec"]).optional(),
    profile: nonEmptyStringSchema.optional(),
    approvalPolicy: nonEmptyStringSchema.optional(),
    sandboxMode: nonEmptyStringSchema.optional(),
  })
  .strict();

export const StartAgentHarnessCommandOptionsSchema = z
  .object({
    provider: ProviderIdSchema.optional(),
    mode: z.enum(["interactive", "exec"]).optional(),
    profile: nonEmptyStringSchema.optional(),
  })
  .strict();

export const TerminalFocusOriginSchema = z
  .object({
    provider: ProviderIdSchema,
    clientId: nonEmptyStringSchema.optional(),
  })
  .strict();

export type TerminalFocusOrigin = z.infer<typeof TerminalFocusOriginSchema>;

export const TerminalCommandOptionsSchema = z
  .object({
    provider: ProviderIdSchema,
    layout: z.enum(["default", "agent-only", "agent-build-shell"]).optional(),
    focus: z.boolean().optional(),
    origin: TerminalFocusOriginSchema.optional(),
  })
  .strict();

export const CreateSessionPayloadSchema = z
  .object({
    projectId: ProjectIdSchema,
    branch: nonEmptyStringSchema,
    base: nonEmptyStringSchema.optional(),
    source: CommandSourceSchema.optional(),
    harness: HarnessCommandOptionsSchema,
    terminal: TerminalCommandOptionsSchema,
    initialPrompt: nonEmptyStringSchema.optional(),
  })
  .strict();

export type CreateSessionPayload = z.infer<typeof CreateSessionPayloadSchema>;

export const StartAgentPayloadSchema = z
  .object({
    projectId: ProjectIdSchema,
    worktreeId: WorktreeIdSchema,
    harness: StartAgentHarnessCommandOptionsSchema.optional(),
    terminal: TerminalCommandOptionsSchema.partial().optional(),
    initialPrompt: nonEmptyStringSchema.optional(),
  })
  .strict();

export type StartAgentPayload = z.infer<typeof StartAgentPayloadSchema>;

export const ResumeAgentPayloadSchema = z
  .object({
    projectId: ProjectIdSchema,
    worktreeId: WorktreeIdSchema,
    recoveryHandleId: nonEmptyStringSchema.optional(),
    terminal: TerminalCommandOptionsSchema.partial().optional(),
    initialPrompt: nonEmptyStringSchema.optional(),
  })
  .strict();

export type ResumeAgentPayload = z.infer<typeof ResumeAgentPayloadSchema>;

export const ForkSessionPayloadSchema = z
  .object({
    projectId: ProjectIdSchema,
    sourceWorktreeId: WorktreeIdSchema,
    branch: nonEmptyStringSchema,
    base: nonEmptyStringSchema.optional(),
    copyDirty: z.boolean().optional(),
    harness: StartAgentHarnessCommandOptionsSchema.optional(),
    terminal: TerminalCommandOptionsSchema.partial().optional(),
    initialPrompt: nonEmptyStringSchema.optional(),
  })
  .strict();

export type ForkSessionPayload = z.infer<typeof ForkSessionPayloadSchema>;

export const TerminalFocusPayloadSchema = z
  .object({
    sessionId: SessionIdSchema.optional(),
    worktreeId: WorktreeIdSchema.optional(),
    origin: TerminalFocusOriginSchema.optional(),
  })
  .strict()
  .refine(
    (payload) => payload.sessionId ?? payload.worktreeId,
    "terminal.focus requires sessionId or worktreeId",
  );

export type TerminalFocusPayload = z.infer<typeof TerminalFocusPayloadSchema>;

export const TerminalClosePayloadSchema = z
  .object({
    sessionId: SessionIdSchema.optional(),
    worktreeId: WorktreeIdSchema.optional(),
    force: z.boolean().optional(),
  })
  .strict()
  .refine(
    (payload) => payload.sessionId ?? payload.worktreeId,
    "terminal.close requires sessionId or worktreeId",
  );

export type TerminalClosePayload = z.infer<typeof TerminalClosePayloadSchema>;

export const CloseSessionPayloadSchema = z
  .object({
    sessionId: SessionIdSchema,
    mode: z.enum(["harness", "terminal", "all"]),
    force: z.boolean().optional(),
  })
  .strict();

export type CloseSessionPayload = z.infer<typeof CloseSessionPayloadSchema>;

export const RenameSessionPayloadSchema = z
  .object({
    sessionId: SessionIdSchema,
    title: nonEmptyStringSchema,
  })
  .strict();

export type RenameSessionPayload = z.infer<typeof RenameSessionPayloadSchema>;

export const AcknowledgeTurnPayloadSchema = z
  .object({
    sessionId: SessionIdSchema,
    token: nonEmptyStringSchema,
  })
  .strict();

export type AcknowledgeTurnPayload = z.infer<typeof AcknowledgeTurnPayloadSchema>;

export const ObserverReconcilePayloadSchema = z
  .object({
    reason: nonEmptyStringSchema.optional(),
  })
  .strict();

export type ObserverReconcilePayload = z.infer<typeof ObserverReconcilePayloadSchema>;

export const AddProjectPayloadSchema = z
  .object({
    path: nonEmptyStringSchema,
    id: ProjectIdSchema.optional(),
    label: nonEmptyStringSchema.optional(),
    allowNonGit: z.boolean().optional(),
  })
  .strict();

export type AddProjectPayload = z.infer<typeof AddProjectPayloadSchema>;

export const RemoveProjectPayloadSchema = z
  .object({
    projectId: ProjectIdSchema,
  })
  .strict();

export type RemoveProjectPayload = z.infer<typeof RemoveProjectPayloadSchema>;

export const SetProjectDefaultHarnessPayloadSchema = z
  .object({
    projectId: ProjectIdSchema,
    harness: ProviderIdSchema,
  })
  .strict();

export type SetProjectDefaultHarnessPayload = z.infer<typeof SetProjectDefaultHarnessPayloadSchema>;

export const StationCommandTypeSchema = z.enum([
  "worktree.create",
  "worktree.fork",
  "worktree.remove",
  "session.create",
  "session.startAgent",
  "session.resumeAgent",
  "session.fork",
  "terminal.focus",
  "terminal.close",
  "session.close",
  "session.rename",
  "session.acknowledgeTurn",
  "observer.reconcile",
  "project.add",
  "project.remove",
  "project.setDefaultHarness",
]);

export const CreateWorktreeCommandSchema = z
  .object({ type: z.literal("worktree.create"), payload: CreateWorktreePayloadSchema })
  .strict();

export const ForkWorktreeCommandSchema = z
  .object({ type: z.literal("worktree.fork"), payload: ForkWorktreePayloadSchema })
  .strict();

export const RemoveWorktreeCommandSchema = z
  .object({ type: z.literal("worktree.remove"), payload: RemoveWorktreePayloadSchema })
  .strict();

export const CreateSessionCommandSchema = z
  .object({ type: z.literal("session.create"), payload: CreateSessionPayloadSchema })
  .strict();

export const StartAgentCommandSchema = z
  .object({ type: z.literal("session.startAgent"), payload: StartAgentPayloadSchema })
  .strict();

export const ResumeAgentCommandSchema = z
  .object({ type: z.literal("session.resumeAgent"), payload: ResumeAgentPayloadSchema })
  .strict();

export const ForkSessionCommandSchema = z
  .object({ type: z.literal("session.fork"), payload: ForkSessionPayloadSchema })
  .strict();

export const TerminalFocusCommandSchema = z
  .object({ type: z.literal("terminal.focus"), payload: TerminalFocusPayloadSchema })
  .strict();

export const TerminalCloseCommandSchema = z
  .object({ type: z.literal("terminal.close"), payload: TerminalClosePayloadSchema })
  .strict();

export const CloseSessionCommandSchema = z
  .object({ type: z.literal("session.close"), payload: CloseSessionPayloadSchema })
  .strict();

export const RenameSessionCommandSchema = z
  .object({ type: z.literal("session.rename"), payload: RenameSessionPayloadSchema })
  .strict();

export const AcknowledgeTurnCommandSchema = z
  .object({ type: z.literal("session.acknowledgeTurn"), payload: AcknowledgeTurnPayloadSchema })
  .strict();

export const ObserverReconcileCommandSchema = z
  .object({ type: z.literal("observer.reconcile"), payload: ObserverReconcilePayloadSchema })
  .strict();

export const AddProjectCommandSchema = z
  .object({ type: z.literal("project.add"), payload: AddProjectPayloadSchema })
  .strict();

export const RemoveProjectCommandSchema = z
  .object({ type: z.literal("project.remove"), payload: RemoveProjectPayloadSchema })
  .strict();

export const SetProjectDefaultHarnessCommandSchema = z
  .object({
    type: z.literal("project.setDefaultHarness"),
    payload: SetProjectDefaultHarnessPayloadSchema,
  })
  .strict();

export const StationCommandSchema = z.discriminatedUnion("type", [
  CreateWorktreeCommandSchema,
  ForkWorktreeCommandSchema,
  RemoveWorktreeCommandSchema,
  CreateSessionCommandSchema,
  StartAgentCommandSchema,
  ResumeAgentCommandSchema,
  ForkSessionCommandSchema,
  TerminalFocusCommandSchema,
  TerminalCloseCommandSchema,
  CloseSessionCommandSchema,
  RenameSessionCommandSchema,
  AcknowledgeTurnCommandSchema,
  ObserverReconcileCommandSchema,
  AddProjectCommandSchema,
  RemoveProjectCommandSchema,
  SetProjectDefaultHarnessCommandSchema,
]);

export type StationCommand = z.infer<typeof StationCommandSchema>;

export const CommandReceiptSchema = z
  .object({
    commandId: CommandIdSchema,
    traceId: nonEmptyStringSchema.optional(),
    spanId: nonEmptyStringSchema.optional(),
    accepted: z.boolean(),
    status: z.enum(["accepted", "rejected"]),
    error: SafeErrorSchema.optional(),
  })
  .strict();

export type CommandReceipt = z.infer<typeof CommandReceiptSchema>;

export const CommandRecordSchema = z
  .object({
    id: CommandIdSchema,
    type: StationCommandTypeSchema,
    command: StationCommandSchema,
    status: z.enum(["accepted", "started", "succeeded", "failed"]),
    createdAt: TimestampSchema,
    startedAt: TimestampSchema.optional(),
    finishedAt: TimestampSchema.optional(),
    traceId: nonEmptyStringSchema.optional(),
    spanId: nonEmptyStringSchema.optional(),
    error: SafeErrorSchema.optional(),
    diagnostics: z.array(DiagnosticDetailSchema).optional(),
  })
  .strict();

export type CommandRecord = z.infer<typeof CommandRecordSchema>;
