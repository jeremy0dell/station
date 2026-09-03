import { z } from "zod";
import { HostHandoffFidelitySchema } from "./hostHandoff.js";
import { ProviderIdSchema } from "./ids.js";
import { compareCodeUnitStrings, nonEmptyStringSchema, safeTextSchema } from "./shared.js";
import { type UpdateArtifact, UpdateArtifactSchema } from "./updateArtifact.js";

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
  "persisted-state-reconcile",
  "final-verification",
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

/**
 * Strict, non-authorizing request accepted only by the one target update successor. It carries
 * selection and policy, including an opaque installation-scope digest, never an executable
 * command, endpoint, process, or recovery authority.
 */
type UpdateSuccessorHandoff =
  | { action: "preserve"; fidelity: z.infer<typeof HostHandoffFidelitySchema> }
  | { action: "leave-in-place" };
export type UpdateSuccessorRequest = {
  schemaVersion: 1;
  channel: UpdateChannelId;
  target: UpdateArtifact;
  installedScopeDigest: string;
  handoff: UpdateSuccessorHandoff;
  hookProviderIds: z.infer<typeof ProviderIdSchema>[];
};

const successorRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    channel: UpdateChannelIdSchema,
    target: UpdateArtifactSchema,
    installedScopeDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    handoff: z.discriminatedUnion("action", [
      z.object({ action: z.literal("preserve"), fidelity: HostHandoffFidelitySchema }).strict(),
      z.object({ action: z.literal("leave-in-place") }).strict(),
    ]),
    hookProviderIds: z.array(ProviderIdSchema).max(32),
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.hookProviderIds.some(
        (provider, index) =>
          request.hookProviderIds[index - 1] !== undefined &&
          compareCodeUnitStrings(request.hookProviderIds[index - 1] ?? "", provider) >= 0,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["hookProviderIds"],
        message: "Successor hook providers must be unique and deterministically sorted.",
      });
    }
  })
  .transform((request): UpdateSuccessorRequest => {
    const target: UpdateArtifact = {
      version: request.target.version,
      ...(request.target.revision === undefined ? {} : { revision: request.target.revision }),
    };
    return { ...request, target };
  });

export const UpdateSuccessorRequestSchema = z
  .unknown()
  .superRefine(rejectExplicitUndefined)
  .pipe(successorRequestSchema);

export function rejectExplicitUndefined(
  value: unknown,
  context: z.RefinementCtx,
  path: (string | number)[] = [],
): void {
  if (value === undefined) {
    context.addIssue({
      code: "custom",
      path,
      message: "Optional fields must be absent.",
    });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      rejectExplicitUndefined(entry, context, [...path, index]);
    });
  } else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value))
      rejectExplicitUndefined(entry, context, [...path, key]);
  }
}
