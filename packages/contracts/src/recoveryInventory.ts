import { z } from "zod";
import {
  ProjectIdSchema,
  ProviderIdSchema,
  SessionIdSchema,
  TimestampSchema,
  WorktreeIdSchema,
} from "./ids.js";
import { compareCodeUnitStrings, nonEmptyStringSchema } from "./shared.js";

export const ObserverRecoveryInventorySessionSchema = z
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
export type ObserverRecoveryInventorySession = z.infer<
  typeof ObserverRecoveryInventorySessionSchema
>;

/** Redacted recovery evidence; provider-native targets and local paths never cross this boundary. */
export const ObserverRecoveryInventoryHandleSchema = z
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
export type ObserverRecoveryInventoryHandle = z.infer<typeof ObserverRecoveryInventoryHandleSchema>;

/** Keeps public repair planning and private Observer resolution on one deterministic ordering. */
export function compareSessionRecoveryHandleRecency(
  left: Pick<ObserverRecoveryInventoryHandle, "id" | "observedAt" | "lastSeenAt">,
  right: Pick<ObserverRecoveryInventoryHandle, "id" | "observedAt" | "lastSeenAt">,
): number {
  return (
    Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt) ||
    Date.parse(right.observedAt) - Date.parse(left.observedAt) ||
    compareCodeUnitStrings(left.id, right.id)
  );
}

export const ObserverRecoveryInventorySchema = z
  .object({
    schemaVersion: z.literal(1),
    sessions: z.array(ObserverRecoveryInventorySessionSchema),
    recoveryHandles: z.array(ObserverRecoveryInventoryHandleSchema),
  })
  .strict()
  .superRefine((inventory, context) => {
    for (const [field, ids] of [
      ["sessions", inventory.sessions.map((session) => session.id)],
      ["recoveryHandles", inventory.recoveryHandles.map((handle) => handle.id)],
    ] as const) {
      if (
        ids.some((id, index) => {
          const previousId = ids[index - 1];
          return previousId !== undefined && compareCodeUnitStrings(previousId, id) >= 0;
        })
      ) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: "Entries must be unique and deterministically sorted.",
        });
      }
    }
  });
export type ObserverRecoveryInventory = z.infer<typeof ObserverRecoveryInventorySchema>;
