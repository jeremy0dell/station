import { z } from "zod";
import {
  ProjectIdSchema,
  ProviderIdSchema,
  SessionIdSchema,
  TimestampSchema,
  WorktreeIdSchema,
} from "./ids.js";
import { nonEmptyStringSchema } from "./shared.js";

export const RecoveryBreadcrumbSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: ProjectIdSchema,
    worktreeId: WorktreeIdSchema.optional(),
    sessionId: SessionIdSchema.optional(),
    createdBy: z.literal("station"),
    createdAt: TimestampSchema,
    provider: ProviderIdSchema.optional(),
    note: nonEmptyStringSchema.max(240).optional(),
  })
  .strict();

export type RecoveryBreadcrumb = z.infer<typeof RecoveryBreadcrumbSchema>;
