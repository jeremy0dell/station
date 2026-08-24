import { z } from "zod";
import { nonEmptyStringSchema, safeTextSchema } from "./shared.js";

export const UpdateChannelIdSchema = z.enum([
  "installer-binary",
  "dev-checkout",
  "homebrew",
  "npm-global",
  "mise",
]);

export type UpdateChannelId = z.infer<typeof UpdateChannelIdSchema>;

export type UpdateCommandArgv = readonly [command: string, ...args: string[]];
export const UpdateCommandArgvSchema = z
  .tuple([nonEmptyStringSchema], z.string())
  .transform((argv): UpdateCommandArgv => argv);

export const UpdateCommandStepIdSchema = z.enum([
  "detect",
  "plan",
  "apply",
  "hook-reconciliation",
  "observer-restart",
  "host-handoff",
]);

export const UpdateCommandStepStatusSchema = z.enum(["completed", "deferred", "skipped", "failed"]);

export type UpdateCommandStepStatus = z.infer<typeof UpdateCommandStepStatusSchema>;

export type UpdateCommandStep = {
  id: z.infer<typeof UpdateCommandStepIdSchema>;
  status: UpdateCommandStepStatus;
  detail: string;
  command?: UpdateCommandArgv;
};

export const UpdateCommandStepSchema: z.ZodType<UpdateCommandStep> = z
  .object({
    id: UpdateCommandStepIdSchema,
    status: UpdateCommandStepStatusSchema,
    detail: safeTextSchema,
    command: UpdateCommandArgvSchema.optional(),
  })
  .strict()
  .transform(
    (step): UpdateCommandStep => ({
      id: step.id,
      status: step.status,
      detail: step.detail,
      ...(step.command === undefined ? {} : { command: step.command }),
    }),
  );
