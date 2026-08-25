import { z } from "zod";
import { ProjectIdSchema, SessionGroupIdSchema, SessionIdSchema } from "../ids.js";

export const SessionGroupNameSchema = z.string().trim().min(1);

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

export const SessionGroupCreateCommandResultSchema = z
  .object({
    type: z.literal("sessionGroup.create"),
    projectId: ProjectIdSchema,
    groupId: SessionGroupIdSchema,
    version: z.number().int().positive(),
  })
  .strict();

export type SessionGroupCreateCommandResult = z.infer<typeof SessionGroupCreateCommandResultSchema>;
