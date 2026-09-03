import {
  compareCodeUnitStrings,
  ProviderHookReconciliationResultSchema,
  rejectExplicitUndefined,
  SafeErrorSchema,
  UpdateArtifactSchema,
  UpdateChannelIdSchema,
  UpdateCommandStepIdSchema,
  UpdateCommandStepStatusSchema,
  UpdateFinalInspectionSchema,
  type UpdateSuccessorRequest,
  UpdateSuccessorRequestSchema,
} from "@station/contracts";
import { type ExternalCommandRunner, runExternalCommand } from "@station/runtime";
import { z } from "zod";
import type { ExecutableArgv } from "../selfExec.js";

const successorInputLimit = 64 * 1024;
const successorOutputLimit = 256 * 1024;

const successorActionSchema = z
  .object({
    id: UpdateCommandStepIdSchema,
    status: UpdateCommandStepStatusSchema,
    detail: z.string().min(1).max(512),
  })
  .strict();

const successorActionOrder = [
  "detect",
  "plan",
  "apply",
  "hook-reconciliation",
  "observer-restart",
  "host-handoff",
  "persisted-state-reconcile",
  "final-verification",
] as const;

/** Strict, bounded, non-authorizing result returned by one target successor. */
const successorReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["completed", "failed"]),
    channel: UpdateChannelIdSchema,
    target: UpdateArtifactSchema,
    actions: z.array(successorActionSchema).max(64),
    hookReconciliations: z.array(ProviderHookReconciliationResultSchema).max(32),
    finalInspection: UpdateFinalInspectionSchema,
    error: SafeErrorSchema.optional(),
  })
  .strict()
  .superRefine((receipt, context) => {
    const providers = receipt.hookReconciliations.map((entry) => entry.provider);
    if (
      providers.some(
        (provider, index) =>
          index > 0 && compareCodeUnitStrings(providers[index - 1] ?? "", provider) >= 0,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["hookReconciliations"],
        message: "Successor hook results must be unique and deterministically sorted.",
      });
    }
    if (
      receipt.actions.some(
        (action, index) =>
          index > 0 &&
          successorActionOrder.indexOf(receipt.actions[index - 1]?.id ?? "detect") >=
            successorActionOrder.indexOf(action.id),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["actions"],
        message: "Successor actions must retain their canonical execution order.",
      });
    }
    if (
      receipt.status === "completed" &&
      (receipt.finalInspection.status !== "completed" ||
        receipt.finalInspection.plan.outcome !== "converged")
    ) {
      context.addIssue({
        code: "custom",
        path: ["finalInspection"],
        message: "Completed successor receipts require a converged final inspection.",
      });
    }
    if (receipt.status === "completed" && receipt.error !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Completed successor receipts cannot contain a failure.",
      });
    }
    if (
      receipt.finalInspection.status === "completed" &&
      receipt.finalInspection.plan.phases.artifactApplication.command.kind !== "none"
    ) {
      context.addIssue({
        code: "custom",
        path: ["finalInspection", "plan", "phases", "artifactApplication", "command"],
        message: "Successor receipts cannot carry executable install authority.",
      });
    }
    if (
      receipt.finalInspection.status === "completed" &&
      (!artifactsMatch(receipt.target, receipt.finalInspection.aggregate.target) ||
        !artifactsMatch(receipt.target, receipt.finalInspection.plan.selectedTarget.artifact))
    ) {
      context.addIssue({
        code: "custom",
        path: ["finalInspection"],
        message: "Successor final inspection must retain the requested target artifact.",
      });
    }
  });

export const UpdateSuccessorReceiptSchema = z
  .unknown()
  .superRefine(rejectExplicitUndefined)
  .pipe(successorReceiptSchema);

export type UpdateSuccessorReceipt = z.output<typeof successorReceiptSchema>;

export type UpdateSuccessorTransportInput = {
  launcher: ExecutableArgv;
  configPath?: string;
  request: UpdateSuccessorRequest;
  commandRunner?: ExternalCommandRunner;
};

/** ADAPTER: crosses once with a bounded request and accepts only a correlated strict receipt. */
export async function runUpdateSuccessorTransport(
  input: UpdateSuccessorTransportInput,
): Promise<UpdateSuccessorReceipt> {
  const request = UpdateSuccessorRequestSchema.parse(input.request);
  const [command, ...prefix] = input.launcher;
  const stdin = JSON.stringify(request);
  if (new TextEncoder().encode(stdin).byteLength > successorInputLimit) {
    throw new Error("The update successor request exceeds its size limit.");
  }
  const result = await runExternalCommand(
    {
      command,
      args: [
        ...prefix,
        ...(input.configPath === undefined ? [] : ["--config", input.configPath]),
        "update",
        "--successor",
      ],
      timeoutMs: 120_000,
      maxOutputChars: successorOutputLimit,
      stdin,
      allowedExitCodes: [1],
    },
    input.commandRunner,
  );
  if (new TextEncoder().encode(result.stdout).byteLength > successorOutputLimit) {
    throw new Error("The update successor receipt exceeds its size limit.");
  }
  const receipt = parseSuccessorReceipt(result.stdout, request, result.exitCode);
  return receipt as UpdateSuccessorReceipt;
}

function parseSuccessorReceipt(
  stdout: string,
  request: UpdateSuccessorRequest,
  exitCode: number,
): UpdateSuccessorReceipt {
  if (exitCode !== 0 && exitCode !== 1) {
    throw new Error("The successor process exited with an unexpected status.");
  }
  const receipt = UpdateSuccessorReceiptSchema.parse(JSON.parse(stdout));
  const target = request.target;
  const providers = receipt.hookReconciliations.map(({ provider }) => provider);
  const providersSorted = providers.every(
    (provider, index) =>
      index === 0 || compareCodeUnitStrings(providers[index - 1] ?? "", provider) < 0,
  );
  if (
    receipt.channel !== request.channel ||
    receipt.target.version !== target.version ||
    receipt.target.revision !== target.revision ||
    !providersSorted ||
    providers.some((provider) => !request.hookProviderIds.includes(provider)) ||
    (receipt.status === "completed" &&
      (providers.length !== request.hookProviderIds.length ||
        providers.some((provider, index) => provider !== request.hookProviderIds[index])))
  ) {
    throw new Error("The successor receipt does not correlate to the requested target.");
  }
  if ((exitCode === 0) !== (receipt.status === "completed")) {
    throw new Error("The successor receipt contradicted its process exit status.");
  }
  return receipt as UpdateSuccessorReceipt;
}

function artifactsMatch(
  left: { version: string; revision?: string },
  right: { version: string; revision?: string },
): boolean {
  return left.version === right.version && left.revision === right.revision;
}
