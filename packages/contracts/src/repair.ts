import { z } from "zod";
import {
  ProjectIdSchema,
  ProviderIdSchema,
  SessionIdSchema,
  TimestampSchema,
  WorktreeIdSchema,
} from "./ids.js";
import { nonEmptyStringSchema } from "./shared.js";

export const RepairSchemaVersionSchema = z.literal(1);

export const RepairRetainedSessionSchema = z
  .object({
    id: SessionIdSchema,
    projectId: ProjectIdSchema,
    worktreeId: WorktreeIdSchema,
    lifecycle: z.enum(["legacy", "open", "ended"]),
    harnessProvider: ProviderIdSchema.optional(),
    terminalProvider: ProviderIdSchema.optional(),
    createdAt: TimestampSchema,
    lastSeenAt: TimestampSchema,
    endedAt: TimestampSchema.optional(),
  })
  .strict();
export type RepairRetainedSession = z.infer<typeof RepairRetainedSessionSchema>;

/** Redacted recovery evidence; provider-native targets and local paths never cross this boundary. */
export const RepairRecoveryHandleSchema = z
  .object({
    id: nonEmptyStringSchema,
    provider: ProviderIdSchema,
    projectId: ProjectIdSchema,
    worktreeId: WorktreeIdSchema,
    sessionId: SessionIdSchema.optional(),
    targetKind: z.enum(["native-session", "session-file"]),
    observedAt: TimestampSchema,
    lastSeenAt: TimestampSchema,
  })
  .strict();
export type RepairRecoveryHandle = z.infer<typeof RepairRecoveryHandleSchema>;

export const ObserverRepairInventorySchema = z
  .object({
    schemaVersion: RepairSchemaVersionSchema,
    sessions: z.array(RepairRetainedSessionSchema),
    recoveryHandles: z.array(RepairRecoveryHandleSchema),
  })
  .strict()
  .superRefine((inventory, context) => {
    for (const [field, ids] of [
      ["sessions", inventory.sessions.map((session) => session.id)],
      ["recoveryHandles", inventory.recoveryHandles.map((handle) => handle.id)],
    ] as const) {
      if (ids.some((id, index) => index > 0 && (ids[index - 1] as string) >= id)) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: "Entries must be unique and deterministically sorted.",
        });
      }
    }
  });
export type ObserverRepairInventory = z.infer<typeof ObserverRepairInventorySchema>;
