import { z } from "zod";
import { DiagnosticDetailSchema, SafeErrorSchema } from "./errors.js";
import {
  CommandIdSchema,
  ProjectIdSchema,
  ProviderIdSchema,
  SessionGroupIdSchema,
  SessionIdSchema,
  TimestampSchema,
  WorktreeIdSchema,
} from "./ids.js";
import { SessionRecoveryHandleSchema } from "./recovery.js";
import { nonEmptyStringSchema, userFacingTitleSchema } from "./shared.js";
import { TerminalPlacementRequestSchema } from "./terminalPlacement.js";

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
    launchHarness: ProviderIdSchema.optional(),
    base: nonEmptyStringSchema.optional(),
    path: nonEmptyStringSchema.optional(),
    source: CommandSourceSchema.optional(),
  })
  .strict();

export const RemoveWorktreePayloadSchema = z
  .object({
    worktreeId: WorktreeIdSchema,
    projectId: ProjectIdSchema.optional(),
    expectedPath: nonEmptyStringSchema,
    expectedBranch: nonEmptyStringSchema,
    expectedRegistrationIdentity: nonEmptyStringSchema,
    force: z.boolean().optional(),
    /** Opaque Observer reservation used when a renderer must settle external PTYs before removal. */
    removalReservationId: nonEmptyStringSchema.optional(),
  })
  .strict();

export type RemoveWorktreePayload = z.infer<typeof RemoveWorktreePayloadSchema>;

export const SourceSessionGroupPlacementIntentSchema = z
  .object({
    kind: z.literal("source"),
    sourceSessionId: SessionIdSchema,
    groupId: SessionGroupIdSchema,
  })
  .strict();

export type SourceSessionGroupPlacementIntent = z.infer<
  typeof SourceSessionGroupPlacementIntentSchema
>;

// Fork a worktree: new branch off the source HEAD, optionally seeding its working tree.
export const ForkWorktreePayloadSchema = z
  .object({
    projectId: ProjectIdSchema,
    sourceWorktreeId: WorktreeIdSchema,
    branch: nonEmptyStringSchema,
    launchHarness: ProviderIdSchema.optional(),
    base: nonEmptyStringSchema.optional(),
    copyDirty: z.boolean().optional(),
    group: SourceSessionGroupPlacementIntentSchema.optional(),
  })
  .strict();

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

/** Create/fork never infer presentation or focus from terminal configuration. */
export const SessionTerminalCommandOptionsSchema = z
  .object({
    provider: ProviderIdSchema,
    layout: z.enum(["default", "agent-only", "agent-build-shell"]).optional(),
  })
  .strict();

export const SessionGroupNameSchema = z.string().trim().min(1);

export const ExistingSessionGroupPlacementIntentSchema = z
  .object({
    kind: z.literal("existing"),
    groupId: SessionGroupIdSchema,
  })
  .strict();

export const CreateSessionGroupPlacementIntentSchema = z
  .object({
    kind: z.literal("create"),
    name: SessionGroupNameSchema,
  })
  .strict();

export const SessionGroupPlacementIntentSchema = z.discriminatedUnion("kind", [
  ExistingSessionGroupPlacementIntentSchema,
  CreateSessionGroupPlacementIntentSchema,
]);

export type SessionGroupPlacementIntent = z.infer<typeof SessionGroupPlacementIntentSchema>;

export const FreshSessionGroupPlacementIntentSchema = z.discriminatedUnion("kind", [
  ExistingSessionGroupPlacementIntentSchema,
  CreateSessionGroupPlacementIntentSchema,
  SourceSessionGroupPlacementIntentSchema,
]);

export type FreshSessionGroupPlacementIntent = z.infer<
  typeof FreshSessionGroupPlacementIntentSchema
>;

export const CreateSessionPayloadSchema = z
  .object({
    projectId: ProjectIdSchema,
    branch: nonEmptyStringSchema,
    title: userFacingTitleSchema.optional(),
    base: nonEmptyStringSchema.optional(),
    source: CommandSourceSchema.optional(),
    harness: HarnessCommandOptionsSchema,
    terminal: SessionTerminalCommandOptionsSchema,
    placement: TerminalPlacementRequestSchema,
    group: SessionGroupPlacementIntentSchema.optional(),
    initialPrompt: nonEmptyStringSchema.optional(),
  })
  .strict()
  .superRefine((payload, context) => {
    if (
      payload.placement.intent === "sibling" &&
      payload.placement.source.provider !== payload.terminal.provider
    ) {
      context.addIssue({
        code: "custom",
        message: "The placement source provider must match the selected terminal provider.",
        path: ["placement", "source", "provider"],
      });
    }
  });

export const SessionFreshStartConsentSchema = z
  .object({
    expectedSessionId: SessionIdSchema,
  })
  .strict();

export type SessionFreshStartConsent = z.infer<typeof SessionFreshStartConsentSchema>;

export const StartAgentPayloadSchema = z
  .object({
    projectId: ProjectIdSchema,
    worktreeId: WorktreeIdSchema,
    harness: StartAgentHarnessCommandOptionsSchema.optional(),
    terminal: TerminalCommandOptionsSchema.partial().optional(),
    freshStart: SessionFreshStartConsentSchema.optional(),
    initialPrompt: nonEmptyStringSchema.optional(),
  })
  .strict();

export const ResumeAgentPayloadSchema = z
  .object({
    projectId: ProjectIdSchema,
    worktreeId: WorktreeIdSchema,
    recoveryHandleId: nonEmptyStringSchema.optional(),
    terminal: TerminalCommandOptionsSchema.partial().optional(),
    initialPrompt: nonEmptyStringSchema.optional(),
  })
  .strict();

export const ImportRecoveryHandlePayloadSchema = z
  .object({
    projectId: ProjectIdSchema,
    worktreeId: WorktreeIdSchema,
    expectedPath: nonEmptyStringSchema,
    expectedRegistrationIdentity: nonEmptyStringSchema.optional(),
    title: userFacingTitleSchema.optional(),
    handle: SessionRecoveryHandleSchema,
  })
  .strict();

export const ForkSessionPayloadSchema = z
  .object({
    projectId: ProjectIdSchema,
    sourceWorktreeId: WorktreeIdSchema,
    branch: nonEmptyStringSchema,
    title: userFacingTitleSchema.optional(),
    base: nonEmptyStringSchema.optional(),
    copyDirty: z.boolean().optional(),
    group: SourceSessionGroupPlacementIntentSchema.optional(),
    harness: StartAgentHarnessCommandOptionsSchema.optional(),
    terminal: SessionTerminalCommandOptionsSchema,
    placement: TerminalPlacementRequestSchema,
    initialPrompt: nonEmptyStringSchema.optional(),
  })
  .strict()
  .superRefine((payload, context) => {
    if (
      payload.placement.intent === "sibling" &&
      payload.placement.source.provider !== payload.terminal.provider
    ) {
      context.addIssue({
        code: "custom",
        message: "The placement source provider must match the selected terminal provider.",
        path: ["placement", "source", "provider"],
      });
    }
  });

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

export const RenameSessionPayloadSchema = z
  .object({
    sessionId: SessionIdSchema,
    title: userFacingTitleSchema,
  })
  .strict();

export const AcknowledgeTurnPayloadSchema = z
  .object({
    sessionId: SessionIdSchema,
    token: nonEmptyStringSchema,
  })
  .strict();

export const ObserverReconcilePayloadSchema = z
  .object({
    reason: nonEmptyStringSchema.optional(),
  })
  .strict();

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

const uniqueSessionIdsSchema = z.array(SessionIdSchema).superRefine((sessionIds, context) => {
  if (new Set(sessionIds).size !== sessionIds.length) {
    context.addIssue({ code: "custom", message: "Session ids must be unique." });
  }
});

export const SessionGroupMembershipExpectationSchema = z
  .object({
    sessionId: SessionIdSchema,
    expectedGroupId: SessionGroupIdSchema.nullable(),
  })
  .strict();

export const CreateSessionGroupPayloadSchema = z
  .object({
    projectId: ProjectIdSchema,
    name: SessionGroupNameSchema,
    initialSessionIds: uniqueSessionIdsSchema.optional(),
  })
  .strict();

export type CreateSessionGroupPayload = z.infer<typeof CreateSessionGroupPayloadSchema>;

export const RenameSessionGroupPayloadSchema = z
  .object({
    projectId: ProjectIdSchema,
    groupId: SessionGroupIdSchema,
    expectedVersion: z.number().int().positive(),
    name: SessionGroupNameSchema,
  })
  .strict();

export type RenameSessionGroupPayload = z.infer<typeof RenameSessionGroupPayloadSchema>;

export const UpdateSessionGroupMembershipPayloadSchema = z
  .object({
    projectId: ProjectIdSchema,
    groupId: SessionGroupIdSchema,
    expectedVersion: z.number().int().positive(),
    add: z.array(SessionGroupMembershipExpectationSchema).optional(),
    remove: z.array(SessionGroupMembershipExpectationSchema).optional(),
  })
  .strict()
  .superRefine((payload, context) => {
    const seen = new Set<string>();
    for (const [collection, expectations] of [
      ["add", payload.add ?? []],
      ["remove", payload.remove ?? []],
    ] as const) {
      for (const [index, expectation] of expectations.entries()) {
        if (seen.has(expectation.sessionId)) {
          context.addIssue({
            code: "custom",
            message: "A membership update may mention each session only once.",
            path: [collection, index, "sessionId"],
          });
        }
        seen.add(expectation.sessionId);
        if (collection === "remove" && expectation.expectedGroupId !== payload.groupId) {
          context.addIssue({
            code: "custom",
            message: "Removed sessions must be expected in the target Group.",
            path: [collection, index, "expectedGroupId"],
          });
        }
      }
    }
  });

export type UpdateSessionGroupMembershipPayload = z.infer<
  typeof UpdateSessionGroupMembershipPayloadSchema
>;

export const ReparentSessionGroupPayloadSchema = z
  .object({
    projectId: ProjectIdSchema,
    groupId: SessionGroupIdSchema,
    expectedVersion: z.number().int().positive(),
    parentGroupId: SessionGroupIdSchema.optional(),
  })
  .strict();

export type ReparentSessionGroupPayload = z.infer<typeof ReparentSessionGroupPayloadSchema>;

export const DeleteSessionGroupPayloadSchema = z
  .object({
    projectId: ProjectIdSchema,
    groupId: SessionGroupIdSchema,
    expectedVersion: z.number().int().positive(),
  })
  .strict();

export type DeleteSessionGroupPayload = z.infer<typeof DeleteSessionGroupPayloadSchema>;

export const StationCommandTypeSchema = z.enum([
  "worktree.create",
  "worktree.fork",
  "worktree.remove",
  "session.create",
  "session.startAgent",
  "session.resumeAgent",
  "session.importRecoveryHandle",
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
  "sessionGroup.create",
  "sessionGroup.rename",
  "sessionGroup.updateMembership",
  "sessionGroup.reparent",
  "sessionGroup.delete",
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

export const ImportRecoveryHandleCommandSchema = z
  .object({
    type: z.literal("session.importRecoveryHandle"),
    payload: ImportRecoveryHandlePayloadSchema,
  })
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

export const CreateSessionGroupCommandSchema = z
  .object({ type: z.literal("sessionGroup.create"), payload: CreateSessionGroupPayloadSchema })
  .strict();

export const RenameSessionGroupCommandSchema = z
  .object({ type: z.literal("sessionGroup.rename"), payload: RenameSessionGroupPayloadSchema })
  .strict();

export const UpdateSessionGroupMembershipCommandSchema = z
  .object({
    type: z.literal("sessionGroup.updateMembership"),
    payload: UpdateSessionGroupMembershipPayloadSchema,
  })
  .strict();

export const ReparentSessionGroupCommandSchema = z
  .object({ type: z.literal("sessionGroup.reparent"), payload: ReparentSessionGroupPayloadSchema })
  .strict();

export const DeleteSessionGroupCommandSchema = z
  .object({ type: z.literal("sessionGroup.delete"), payload: DeleteSessionGroupPayloadSchema })
  .strict();

export const StationCommandSchema = z.discriminatedUnion("type", [
  CreateWorktreeCommandSchema,
  ForkWorktreeCommandSchema,
  RemoveWorktreeCommandSchema,
  CreateSessionCommandSchema,
  StartAgentCommandSchema,
  ResumeAgentCommandSchema,
  ImportRecoveryHandleCommandSchema,
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
  CreateSessionGroupCommandSchema,
  RenameSessionGroupCommandSchema,
  UpdateSessionGroupMembershipCommandSchema,
  ReparentSessionGroupCommandSchema,
  DeleteSessionGroupCommandSchema,
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
