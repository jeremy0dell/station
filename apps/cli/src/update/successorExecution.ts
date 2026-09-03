import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  compareCodeUnitStrings,
  ProviderHookReconciliationResultSchema,
  rejectExplicitUndefined,
  SafeErrorSchema,
  stationHostTerminalLifetimeIdentitiesAreCanonical,
  UpdateArtifactSchema,
  UpdateChannelIdSchema,
  UpdateCommandStepIdSchema,
  UpdateCommandStepStatusSchema,
  type UpdateConvergencePlan,
  UpdateConvergencePlanningInputSchema,
  UpdateFinalInspectionSchema,
  type UpdateReapRecoveryPreflight,
  UpdateReapTerminalEvidenceSchema,
  type UpdateSuccessorRequest,
  UpdateSuccessorRequestSchema,
} from "@station/contracts";
import { type ExternalCommandRunner, runExternalCommand } from "@station/runtime";
import { z } from "zod";
import type { ExecutableArgv } from "../selfExec.js";
import { formatCliJson } from "../terminalOutput.js";
import { deriveUpdateConvergencePlan } from "./convergencePlan.js";
import { updateRecoveryActionCommitments } from "./recoveryPreflight.js";

const successorInputLimit = 64 * 1024;
const successorOutputLimit = 256 * 1024;
const successorTransportOutputLimit = 384 * 1024;
const successorOutputEvidenceReserve = 64 * 1024;
export const UPDATE_SUCCESSOR_PRIVATE_ENV = "STATION_UPDATE_SUCCESSOR_PRIVATE";
const successorTransportKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const successorTransportEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    algorithm: z.literal("aes-256-gcm"),
    iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/u),
    ciphertext: z.string().regex(/^[A-Za-z0-9_-]+$/u),
    authenticationTag: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
  })
  .strict();

const successorActionSchema = z
  .object({
    id: UpdateCommandStepIdSchema,
    status: UpdateCommandStepStatusSchema,
    detail: z.string().min(1).max(512),
  })
  .strict();
const successorParkedTerminalSchema = UpdateReapTerminalEvidenceSchema;

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
    parkedTerminals: z
      .array(successorParkedTerminalSchema)
      .max(1_024)
      .refine(stationHostTerminalLifetimeIdentitiesAreCanonical),
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
        !["converged", "intentionally-incomplete"].includes(receipt.finalInspection.plan.outcome))
    ) {
      context.addIssue({
        code: "custom",
        path: ["finalInspection"],
        message: "Completed successor receipts require a terminal final inspection.",
      });
    }
    if (
      receipt.status === "completed" &&
      receipt.finalInspection.status === "completed" &&
      receipt.finalInspection.plan.outcome === "intentionally-incomplete" &&
      (receipt.finalInspection.plan.phases.artifactApplication.action !== "no-op" ||
        receipt.finalInspection.plan.phases.hookReconciliation.action !== "no-op" ||
        receipt.finalInspection.plan.phases.observerConvergence.action !== "no-op" ||
        receipt.finalInspection.plan.phases.terminalConvergence.action !== "leave-in-place" ||
        receipt.finalInspection.plan.phases.hostConvergence.action !== "leave-in-place")
    ) {
      context.addIssue({
        code: "custom",
        path: ["finalInspection", "plan", "phases"],
        message: "Completed no-handoff receipts may leave only Host convergence incomplete.",
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
        !artifactsMatch(receipt.target, receipt.finalInspection.aggregate.installed) ||
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
  .pipe(successorReceiptSchema)
  .superRefine((receipt, context) => {
    if (!updateSuccessorReceiptFitsOutput(receipt)) {
      context.addIssue({
        code: "custom",
        message: "Successor receipt exceeds its size limit.",
      });
    }
  });

export type UpdateSuccessorReceipt = z.output<typeof successorReceiptSchema>;

export type UpdateSuccessorTransportInput = {
  launcher: ExecutableArgv;
  configPath?: string;
  request: UpdateSuccessorRequest;
  commandRunner?: ExternalCommandRunner;
};

/**
 * ADAPTER
 *
 * Crosses once through a protected bounded request and accepts only a correlated strict receipt.
 */
export async function runUpdateSuccessorTransport(
  input: UpdateSuccessorTransportInput,
): Promise<UpdateSuccessorReceipt> {
  const request = UpdateSuccessorRequestSchema.parse(input.request);
  const [command, ...prefix] = input.launcher;
  const stdin = JSON.stringify(request);
  const transportKey = createUpdateSuccessorTransportKey();
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
      maxOutputChars: successorTransportOutputLimit,
      stdin,
      env: { [UPDATE_SUCCESSOR_PRIVATE_ENV]: transportKey },
      allowedExitCodes: [1],
    },
    input.commandRunner,
  );
  if (new TextEncoder().encode(result.stdout).byteLength > successorTransportOutputLimit) {
    throw new Error("The protected update successor receipt exceeds its size limit.");
  }
  const plaintext = openUpdateSuccessorOutput(result.stdout, transportKey);
  if (new TextEncoder().encode(plaintext).byteLength > successorOutputLimit) {
    throw new Error("The update successor receipt exceeds its size limit.");
  }
  const receipt = parseSuccessorReceipt(plaintext, request, result.exitCode);
  return receipt as UpdateSuccessorReceipt;
}

export function createUpdateSuccessorTransportKey(): string {
  return randomBytes(32).toString("base64url");
}

export function updateSuccessorTransportKeyIsValid(value: string | undefined): value is string {
  return successorTransportKeySchema.safeParse(value).success;
}

export function sealUpdateSuccessorOutput(value: unknown, transportKey: string): unknown {
  const key = Buffer.from(successorTransportKeySchema.parse(transportKey), "base64url");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(formatCliJson(value), "utf8"), cipher.final()]);
  return successorTransportEnvelopeSchema.parse({
    schemaVersion: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    authenticationTag: cipher.getAuthTag().toString("base64url"),
  });
}

function openUpdateSuccessorOutput(stdout: string, transportKey: string): string {
  const envelope = successorTransportEnvelopeSchema.parse(JSON.parse(stdout));
  const key = Buffer.from(successorTransportKeySchema.parse(transportKey), "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(envelope.authenticationTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
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
  if (receipt.status === "completed") validateCompletedReceipt(receipt, request);
  return receipt as UpdateSuccessorReceipt;
}

function validateCompletedReceipt(
  receipt: Extract<UpdateSuccessorReceipt, { status: "completed" }> | UpdateSuccessorReceipt,
  request: UpdateSuccessorRequest,
): void {
  if (receipt.finalInspection.status !== "completed") {
    throw new Error("The completed successor receipt omitted final evidence.");
  }
  if (!sameProviders(receipt.finalInspection.aggregate.hookProviderIds, request.hookProviderIds)) {
    throw new Error("The successor final aggregate changed the requested hook providers.");
  }
  const planning = UpdateConvergencePlanningInputSchema.parse({
    preflight: receipt.finalInspection.aggregate,
    targetRuntime: receipt.finalInspection.plan.selectedTarget.runtimeBuild,
    installation: {
      whenRequired: "apply",
      owner: request.channel,
      command: { kind: "none" },
    },
    handoff: request.handoff,
  });
  const expected = deriveUpdateConvergencePlan(planning);
  if (!isDeepStrictEqual(receipt.finalInspection.plan, expected)) {
    throw new Error("The successor final plan was not derived from its final aggregate.");
  }
}

export function updateSuccessorEvidenceFitsOutput(
  aggregate: UpdateReapRecoveryPreflight,
  plan: UpdateConvergencePlan,
): boolean {
  const parkedTerminals = updateRecoveryActionCommitments(aggregate).parkedTerminals ?? [];
  return (
    parkedTerminals.length <= 1_024 &&
    outputByteLength({ aggregate, plan, parkedTerminals }) <=
      successorOutputLimit - successorOutputEvidenceReserve
  );
}

export function updateSuccessorReceiptFitsOutput(receipt: UpdateSuccessorReceipt): boolean {
  return outputByteLength(receipt) <= successorOutputLimit;
}

function outputByteLength(value: unknown): number {
  return new TextEncoder().encode(`${formatCliJson(value)}\n`).byteLength;
}

function artifactsMatch(
  left: { version: string; revision?: string },
  right: { version: string; revision?: string },
): boolean {
  return left.version === right.version && left.revision === right.revision;
}

function sameProviders(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((provider, index) => provider === right[index]);
}
