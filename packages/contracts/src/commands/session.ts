import { z } from "zod";
import {
  ProjectIdSchema,
  ProviderIdSchema,
  SessionGroupIdSchema,
  SessionIdSchema,
  TerminalTargetIdSchema,
  WorktreeIdSchema,
} from "../ids.js";
import { SessionRecoveryHandleSchema } from "../recovery.js";
import { RepairRecoveryMutationProofSchema } from "../repair.js";
import { nonEmptyStringSchema, userFacingTitleSchema } from "../shared.js";
import { TerminalPlacementRequestSchema } from "../terminalPlacement.js";
import { SessionGroupNameSchema } from "./sessionGroup.js";
import { CommandSourceSchema } from "./source.js";
import { SessionTerminalCommandOptionsSchema, TerminalCommandOptionsSchema } from "./terminal.js";

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
    expected: z
      .object({
        sessionId: SessionIdSchema,
        provider: ProviderIdSchema,
      })
      .strict()
      .optional(),
    repair: RepairRecoveryMutationProofSchema.optional(),
    terminal: TerminalCommandOptionsSchema.partial().optional(),
    initialPrompt: nonEmptyStringSchema.optional(),
  })
  .strict();

export const PruneRecoveryHandlePayloadSchema = z
  .object({
    projectId: ProjectIdSchema,
    worktreeId: WorktreeIdSchema,
    recoveryHandleId: nonEmptyStringSchema,
    expected: z.object({ sessionId: SessionIdSchema, provider: ProviderIdSchema }).strict(),
    repair: RepairRecoveryMutationProofSchema,
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

export const CreateSessionCommandSchema = z
  .object({
    type: z.literal("session.create"),
    payload: CreateSessionPayloadSchema,
  })
  .strict();

export const StartAgentCommandSchema = z
  .object({
    type: z.literal("session.startAgent"),
    payload: StartAgentPayloadSchema,
  })
  .strict();

export const ResumeAgentCommandSchema = z
  .object({
    type: z.literal("session.resumeAgent"),
    payload: ResumeAgentPayloadSchema,
  })
  .strict();

export const PruneRecoveryHandleCommandSchema = z
  .object({
    type: z.literal("session.pruneRecoveryHandle"),
    payload: PruneRecoveryHandlePayloadSchema,
  })
  .strict();

export const ImportRecoveryHandleCommandSchema = z
  .object({
    type: z.literal("session.importRecoveryHandle"),
    payload: ImportRecoveryHandlePayloadSchema,
  })
  .strict();

export const ForkSessionCommandSchema = z
  .object({
    type: z.literal("session.fork"),
    payload: ForkSessionPayloadSchema,
  })
  .strict();

export const CloseSessionCommandSchema = z
  .object({
    type: z.literal("session.close"),
    payload: CloseSessionPayloadSchema,
  })
  .strict();

export const RenameSessionCommandSchema = z
  .object({
    type: z.literal("session.rename"),
    payload: RenameSessionPayloadSchema,
  })
  .strict();

export const AcknowledgeTurnCommandSchema = z
  .object({
    type: z.literal("session.acknowledgeTurn"),
    payload: AcknowledgeTurnPayloadSchema,
  })
  .strict();

const ResolvedSessionCommandPlacementSchema = z
  .object({
    provider: ProviderIdSchema,
    targetId: TerminalTargetIdSchema,
    generation: nonEmptyStringSchema,
    presentation: z.enum(["presented", "detached"]),
  })
  .strict();

const SiblingSessionCommandPlacementResultFields = {
  requestedPlacement: z.literal("sibling"),
  resolvedPlacement: ResolvedSessionCommandPlacementSchema.extend({
    presentation: z.literal("presented"),
  }),
} as const;

const DetachedSessionCommandPlacementResultFields = {
  requestedPlacement: z.literal("detached"),
  resolvedPlacement: ResolvedSessionCommandPlacementSchema.extend({
    presentation: z.literal("detached"),
  }),
} as const;

export const SessionCommandPlacementResultSchema = z.discriminatedUnion("requestedPlacement", [
  z.object(SiblingSessionCommandPlacementResultFields).strict(),
  z.object(DetachedSessionCommandPlacementResultFields).strict(),
]);

export type SessionCommandPlacementResult = z.infer<typeof SessionCommandPlacementResultSchema>;

const SessionCommandResultFields = {
  projectId: ProjectIdSchema,
  worktreeId: WorktreeIdSchema,
  sessionId: SessionIdSchema,
  resolvedGroupId: SessionGroupIdSchema.optional(),
} as const;

type WithExactOptionalProperty<T, K extends keyof T> = T extends T
  ? Omit<T, K> & { [P in K]?: Exclude<T[P], undefined> }
  : never;

export const SessionCreateCommandResultSchema = z.discriminatedUnion("requestedPlacement", [
  z
    .object({
      type: z.literal("session.create"),
      ...SessionCommandResultFields,
      ...SiblingSessionCommandPlacementResultFields,
    })
    .strict(),
  z
    .object({
      type: z.literal("session.create"),
      ...SessionCommandResultFields,
      ...DetachedSessionCommandPlacementResultFields,
    })
    .strict(),
]);

export type SessionCreateCommandResult = WithExactOptionalProperty<
  z.infer<typeof SessionCreateCommandResultSchema>,
  "resolvedGroupId"
>;

export const SessionForkCommandResultSchema = z.discriminatedUnion("requestedPlacement", [
  z
    .object({
      type: z.literal("session.fork"),
      ...SessionCommandResultFields,
      ...SiblingSessionCommandPlacementResultFields,
    })
    .strict(),
  z
    .object({
      type: z.literal("session.fork"),
      ...SessionCommandResultFields,
      ...DetachedSessionCommandPlacementResultFields,
    })
    .strict(),
]);

export type SessionForkCommandResult = WithExactOptionalProperty<
  z.infer<typeof SessionForkCommandResultSchema>,
  "resolvedGroupId"
>;
