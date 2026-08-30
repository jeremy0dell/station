import { z } from "zod";
import { SafeErrorSchema } from "./errors.js";
import { ProviderIdSchema } from "./ids.js";

export const ProviderHookFollowUpSchema = z
  .object({
    action: z.enum(["enable-hooks", "run-doctor", "run-explicit-takeover", "retry"]),
  })
  .strict();

const configuredDisabledHealthSchema = z
  .object({
    provider: ProviderIdSchema,
    status: z.literal("configured-disabled"),
    followUp: ProviderHookFollowUpSchema.extend({ action: z.literal("enable-hooks") }),
  })
  .strict();

const unsupportedHealthSchema = z
  .object({
    provider: ProviderIdSchema,
    status: z.literal("unsupported"),
  })
  .strict();

const healthyHealthSchema = z
  .object({
    provider: ProviderIdSchema,
    status: z.literal("healthy"),
  })
  .strict();

const needsRepairHealthSchema = z
  .object({
    provider: ProviderIdSchema,
    status: z.literal("needs-repair"),
    reason: z.enum(["missing", "owned-drift"]),
  })
  .strict();

const ownershipConflictHealthSchema = z
  .object({
    provider: ProviderIdSchema,
    status: z.literal("ownership-conflict"),
    ownership: z.enum(["different-owner", "unknown-owner"]),
    followUp: ProviderHookFollowUpSchema.extend({ action: z.literal("run-explicit-takeover") }),
  })
  .strict();

const inspectionFailedHealthSchema = z
  .object({
    provider: ProviderIdSchema,
    status: z.literal("inspection-failed"),
    error: SafeErrorSchema,
    followUp: ProviderHookFollowUpSchema.extend({ action: z.literal("run-doctor") }),
  })
  .strict();

/** Provider-neutral, redaction-safe evidence about configured harness hook delivery. */
export const ProviderHookHealthSchema = z.discriminatedUnion("status", [
  configuredDisabledHealthSchema,
  unsupportedHealthSchema,
  healthyHealthSchema,
  needsRepairHealthSchema,
  ownershipConflictHealthSchema,
  inspectionFailedHealthSchema,
]);

export type ProviderHookHealth = z.infer<typeof ProviderHookHealthSchema>;

const configuredDisabledReconciliationSchema = z
  .object({
    provider: ProviderIdSchema,
    status: z.literal("configured-disabled"),
    changed: z.literal(false),
    verified: z.literal(false),
    followUp: ProviderHookFollowUpSchema.extend({ action: z.literal("enable-hooks") }),
  })
  .strict();

const unsupportedReconciliationSchema = z
  .object({
    provider: ProviderIdSchema,
    status: z.literal("unsupported"),
    changed: z.literal(false),
    verified: z.literal(false),
  })
  .strict();

const healthyReconciliationSchema = z
  .object({
    provider: ProviderIdSchema,
    status: z.literal("healthy"),
    changed: z.literal(false),
    verified: z.literal(true),
  })
  .strict();

const repairedReconciliationSchema = z
  .object({
    provider: ProviderIdSchema,
    status: z.literal("repaired"),
    changed: z.literal(true),
    verified: z.literal(true),
  })
  .strict();

const ownershipConflictReconciliationSchema = z
  .object({
    provider: ProviderIdSchema,
    status: z.literal("ownership-conflict"),
    changed: z.literal(false),
    verified: z.literal(false),
    followUp: ProviderHookFollowUpSchema.extend({ action: z.literal("run-explicit-takeover") }),
  })
  .strict();

const writeFailedReconciliationSchema = z
  .object({
    provider: ProviderIdSchema,
    status: z.literal("write-failed"),
    changed: z.boolean(),
    verified: z.literal(false),
    error: SafeErrorSchema,
    followUp: ProviderHookFollowUpSchema.extend({ action: z.literal("retry") }),
  })
  .strict();

const postWriteDoctorFailedReconciliationSchema = z
  .object({
    provider: ProviderIdSchema,
    status: z.literal("post-write-doctor-failed"),
    changed: z.boolean(),
    verified: z.literal(false),
    error: SafeErrorSchema,
    followUp: ProviderHookFollowUpSchema.extend({ action: z.literal("run-doctor") }),
  })
  .strict();

const inspectionFailedReconciliationSchema = z
  .object({
    provider: ProviderIdSchema,
    status: z.literal("inspection-failed"),
    changed: z.literal(false),
    verified: z.literal(false),
    error: SafeErrorSchema,
    followUp: ProviderHookFollowUpSchema.extend({ action: z.literal("run-doctor") }),
  })
  .strict();

/** Provider-neutral outcome of the provider-owned plan/write/doctor operation. */
export const ProviderHookReconciliationResultSchema = z.discriminatedUnion("status", [
  configuredDisabledReconciliationSchema,
  unsupportedReconciliationSchema,
  healthyReconciliationSchema,
  repairedReconciliationSchema,
  ownershipConflictReconciliationSchema,
  writeFailedReconciliationSchema,
  postWriteDoctorFailedReconciliationSchema,
  inspectionFailedReconciliationSchema,
]);

export type ProviderHookReconciliationResult = z.infer<
  typeof ProviderHookReconciliationResultSchema
>;

export type SuccessfulProviderHookReconciliationResult = Extract<
  ProviderHookReconciliationResult,
  { status: "configured-disabled" | "unsupported" | "healthy" | "repaired" }
>;

/**
 * POLICY
 *
 * Decides whether a provider hook reconciliation permits its caller to continue.
 */
export function providerHookReconciliationSucceeded(
  result: ProviderHookReconciliationResult,
): result is SuccessfulProviderHookReconciliationResult {
  switch (result.status) {
    case "configured-disabled":
    case "unsupported":
    case "healthy":
    case "repaired":
      return true;
    case "ownership-conflict":
    case "write-failed":
    case "post-write-doctor-failed":
    case "inspection-failed":
      return false;
  }
}
