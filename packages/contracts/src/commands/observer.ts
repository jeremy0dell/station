import { z } from "zod";
import { nonEmptyStringSchema } from "../shared.js";

export const ObserverReconcilePayloadSchema = z
  .object({
    reason: nonEmptyStringSchema.optional(),
  })
  .strict();

export const ObserverReconcileCommandSchema = z
  .object({ type: z.literal("observer.reconcile"), payload: ObserverReconcilePayloadSchema })
  .strict();
