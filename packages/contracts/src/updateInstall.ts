import { z } from "zod";
import { nonEmptyStringSchema } from "./shared.js";

export const UpdateChannelIdSchema = z.enum([
  "installer-binary",
  "dev-checkout",
  "homebrew",
  "npm-global",
  "mise",
]);
export type UpdateChannelId = z.infer<typeof UpdateChannelIdSchema>;

export const UpdateCommandArgvSchema = z.tuple([nonEmptyStringSchema], z.string());
export type UpdateCommandArgv = readonly [command: string, ...args: string[]];

export type UpdateInstallMutation = {
  owner: UpdateChannelId;
  action: "no-op" | "apply" | "defer";
  managerCommand?: UpdateCommandArgv;
};

const updateInstallMutationInputSchema = z
  .object({
    owner: UpdateChannelIdSchema,
    action: z.enum(["no-op", "apply", "defer"]),
    managerCommand: UpdateCommandArgvSchema.optional(),
  })
  .strict()
  .superRefine((mutation, context) => {
    const managerOwned =
      mutation.owner === "homebrew" || mutation.owner === "npm-global" || mutation.owner === "mise";
    if (managerOwned !== (mutation.managerCommand !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["managerCommand"],
        message: "Manager-owned install mutations require exact manager argv, forbidden elsewhere.",
      });
    }
    if (mutation.action === "defer" && !managerOwned) {
      context.addIssue({
        code: "custom",
        path: ["action"],
        message: "Only a package-manager install owner may select deferral.",
      });
    }
  });

/** Exact install owner, selected mutation, and manager argv bound to one convergence plan. */
export const UpdateInstallMutationSchema: z.ZodType<UpdateInstallMutation> =
  updateInstallMutationInputSchema.transform((mutation): UpdateInstallMutation => {
    const result: UpdateInstallMutation = {
      owner: mutation.owner,
      action: mutation.action,
    };
    if (mutation.managerCommand !== undefined) result.managerCommand = mutation.managerCommand;
    return result;
  });

export function updateInstallMutationsMatch(
  left: UpdateInstallMutation,
  right: UpdateInstallMutation,
): boolean {
  return (
    left.owner === right.owner &&
    left.action === right.action &&
    updateCommandArgvMatch(left.managerCommand, right.managerCommand)
  );
}

export function updateInstallOwnersMatch(
  left: Pick<UpdateInstallMutation, "owner" | "managerCommand">,
  right: Pick<UpdateInstallMutation, "owner" | "managerCommand">,
): boolean {
  return (
    left.owner === right.owner && updateCommandArgvMatch(left.managerCommand, right.managerCommand)
  );
}

export function updateCommandArgvMatch(
  left: UpdateCommandArgv | undefined,
  right: UpdateCommandArgv | undefined,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.length === right.length &&
      left.every((value, index) => value === right[index]))
  );
}
