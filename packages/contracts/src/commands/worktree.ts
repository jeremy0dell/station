import { z } from "zod";
import { ProjectIdSchema, ProviderIdSchema, WorktreeIdSchema } from "../ids.js";
import { nonEmptyStringSchema } from "../shared.js";
import { SourceSessionGroupPlacementIntentSchema } from "./sessionGroup.js";
import { CommandSourceSchema } from "./source.js";

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

export const CreateWorktreeCommandSchema = z
  .object({ type: z.literal("worktree.create"), payload: CreateWorktreePayloadSchema })
  .strict();

export const ForkWorktreeCommandSchema = z
  .object({ type: z.literal("worktree.fork"), payload: ForkWorktreePayloadSchema })
  .strict();

export const RemoveWorktreeCommandSchema = z
  .object({ type: z.literal("worktree.remove"), payload: RemoveWorktreePayloadSchema })
  .strict();

export const WorktreeCreateCommandResultSchema = z
  .object({
    type: z.literal("worktree.create"),
    projectId: ProjectIdSchema,
    worktreeId: WorktreeIdSchema,
  })
  .strict();

export type WorktreeCreateCommandResult = z.infer<typeof WorktreeCreateCommandResultSchema>;

export const WorktreeForkCommandResultSchema = z
  .object({
    type: z.literal("worktree.fork"),
    projectId: ProjectIdSchema,
    worktreeId: WorktreeIdSchema,
  })
  .strict();

export type WorktreeForkCommandResult = z.infer<typeof WorktreeForkCommandResultSchema>;
