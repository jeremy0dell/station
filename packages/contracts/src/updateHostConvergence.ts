import { z } from "zod";
import { SafeErrorSchema } from "./errors.js";
import {
  HostHandoffFidelitySchema,
  PtyHandoffReceiptSchema,
  PtyLifetimeIdentitySchema,
  ptyLifetimeIdentitiesStrictlySorted,
  ptyLifetimeIdentitySetsMatch,
} from "./hostHandoff.js";
import { nonEmptyStringSchema } from "./shared.js";

const committedHostValueSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("known"), value: nonEmptyStringSchema }).strict(),
  z.object({ status: z.literal("absent") }).strict(),
]);

export const HostPtyInventoryCommitmentSchema = z
  .object({ terminals: z.array(PtyLifetimeIdentitySchema) })
  .strict()
  .superRefine((inventory, context) => {
    if (!ptyLifetimeIdentitiesStrictlySorted(inventory.terminals)) {
      context.addIssue({
        code: "custom",
        path: ["terminals"],
        message: "Committed Host terminals must be unique and sorted by immutable identity.",
      });
    }
  });
export type HostPtyInventoryCommitment = z.infer<typeof HostPtyInventoryCommitmentSchema>;

/** Exact pre-mutation Host and selected-build facts authorized by one update convergence plan. */
export const UpdateHostConvergenceCommitmentSchema = z
  .object({
    incumbent: z
      .object({
        buildVersion: committedHostValueSchema,
        buildIdentity: committedHostValueSchema,
        protocolVersion: z.number().int(),
        inventory: HostPtyInventoryCommitmentSchema,
      })
      .strict(),
    target: z
      .object({
        buildVersion: nonEmptyStringSchema,
        buildIdentity: z.string().regex(/^[0-9a-f]{64}$/u),
      })
      .strict(),
  })
  .strict();
export type UpdateHostConvergenceCommitment = z.infer<typeof UpdateHostConvergenceCommitmentSchema>;

export const UpdateHostConvergenceCommandSchema = z
  .discriminatedUnion("action", [
    z
      .object({
        schemaVersion: z.literal(1),
        action: z.literal("replace-idle"),
        commitment: UpdateHostConvergenceCommitmentSchema,
      })
      .strict(),
    z
      .object({
        schemaVersion: z.literal(1),
        action: z.literal("handoff"),
        fidelity: HostHandoffFidelitySchema,
        commitment: UpdateHostConvergenceCommitmentSchema,
      })
      .strict(),
  ])
  .superRefine((command, context) => {
    const terminalCount = command.commitment.incumbent.inventory.terminals.length;
    if (
      (command.action === "replace-idle" && terminalCount !== 0) ||
      (command.action === "handoff" && terminalCount === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["commitment", "incumbent", "inventory"],
        message:
          "Idle replacement requires an empty inventory and live handoff requires a non-empty inventory.",
      });
    }
  });
export type UpdateHostConvergenceCommand = z.infer<typeof UpdateHostConvergenceCommandSchema>;

export const UpdateHostConvergenceReceiptSchema = z
  .discriminatedUnion("ensuredBy", [
    z
      .object({
        ensuredBy: z.literal("idle-replace"),
        validatedCommitment: UpdateHostConvergenceCommitmentSchema,
        actualInventory: HostPtyInventoryCommitmentSchema,
      })
      .strict(),
    z
      .object({
        ensuredBy: z.literal("handoff"),
        validatedCommitment: UpdateHostConvergenceCommitmentSchema,
        actualInventory: HostPtyInventoryCommitmentSchema,
        handoffReceipt: PtyHandoffReceiptSchema,
      })
      .strict(),
  ])
  .superRefine((receipt, context) => {
    const authorized = receipt.validatedCommitment.incumbent.inventory.terminals;
    if (!ptyLifetimeIdentitySetsMatch(authorized, receipt.actualInventory.terminals)) {
      context.addIssue({
        code: "custom",
        path: ["actualInventory"],
        message: "Host convergence must retain the exact authorized immutable inventory.",
      });
    }
    if (receipt.ensuredBy === "idle-replace") {
      if (authorized.length !== 0) {
        context.addIssue({
          code: "custom",
          path: ["validatedCommitment", "incumbent", "inventory"],
          message: "Idle replacement requires an exactly empty authorized inventory.",
        });
      }
      return;
    }
    if (
      !ptyLifetimeIdentitySetsMatch(
        receipt.actualInventory.terminals,
        receipt.handoffReceipt.terminals,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["handoffReceipt"],
        message: "Live handoff must receipt the exact validated immutable inventory.",
      });
    }
  });
export type UpdateHostConvergenceReceipt = z.infer<typeof UpdateHostConvergenceReceiptSchema>;

/** Strict machine boundary returned by the update-only constrained Host executor. */
export const UpdateHostConvergenceCommandResultSchema = z
  .discriminatedUnion("status", [
    z
      .object({
        schemaVersion: z.literal(1),
        action: z.literal("update-converge"),
        requestedAction: z.enum(["replace-idle", "handoff"]),
        status: z.literal("completed"),
        receipt: UpdateHostConvergenceReceiptSchema,
      })
      .strict(),
    z
      .object({
        schemaVersion: z.literal(1),
        action: z.literal("update-converge"),
        requestedAction: z.enum(["replace-idle", "handoff"]),
        status: z.enum(["drifted", "failed"]),
        error: SafeErrorSchema,
      })
      .strict(),
  ])
  .superRefine((result, context) => {
    if (
      result.status === "completed" &&
      ((result.requestedAction === "replace-idle" && result.receipt.ensuredBy !== "idle-replace") ||
        (result.requestedAction === "handoff" && result.receipt.ensuredBy !== "handoff"))
    ) {
      context.addIssue({
        code: "custom",
        path: ["receipt", "ensuredBy"],
        message: "Host convergence receipt must identify the exact requested action.",
      });
    }
  });
export type UpdateHostConvergenceCommandResult = z.infer<
  typeof UpdateHostConvergenceCommandResultSchema
>;
