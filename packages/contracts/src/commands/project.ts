import { z } from "zod";
import { ProjectIdSchema, ProviderIdSchema } from "../ids.js";
import { nonEmptyStringSchema } from "../shared.js";

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
