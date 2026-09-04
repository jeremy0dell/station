import { z } from "zod";
import { SafeErrorSchema } from "./errors.js";
import { HostHandoffFidelitySchema } from "./hostHandoff.js";
import { nonEmptyStringSchema } from "./shared.js";
import { StationBuildIdentitySchema } from "./stationBuildIdentity.js";
import {
  type StationHostExactEvidence,
  StationHostExactEvidenceSchema,
  type StationHostTerminalLifetime,
  StationHostTerminalLifetimeSchema,
  stationHostTerminalLifetimeIdentitiesAreCanonical,
} from "./stationHostInspection.js";

export const StationHostTargetBuildSchema = z
  .object({
    buildVersion: nonEmptyStringSchema,
    buildIdentity: StationBuildIdentitySchema,
  })
  .strict();
export type StationHostTargetBuild = z.infer<typeof StationHostTargetBuildSchema>;

export function stationHostEvidenceMatchesTargetBuild(
  evidence: Pick<StationHostExactEvidence, "health" | "buildIdentity">,
  targetBuild: StationHostTargetBuild,
): boolean {
  return (
    evidence.health.buildVersion === targetBuild.buildVersion &&
    evidence.buildIdentity === targetBuild.buildIdentity
  );
}

export function stationHostTerminalsAreHandoffEligible(
  terminals: readonly StationHostTerminalLifetime[],
): boolean {
  return (
    terminals.length > 0 &&
    terminals.every(
      ({ alive, handoffSupport }) => alive && handoffSupport.kind === "bridge-releasable",
    )
  );
}

const deadline = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const eligibleHandoffEvidence = StationHostExactEvidenceSchema.refine(
  ({ terminals }) => stationHostTerminalsAreHandoffEligible(terminals),
  "Handoff requires live, bridge-releasable terminals.",
);
const common = {
  targetBuild: StationHostTargetBuildSchema,
  socketPath: nonEmptyStringSchema,
  expected: StationHostExactEvidenceSchema,
  deadlineMs: deadline,
};

/** Strict, unversioned authority for one exact Host-lifetime convergence. */
export const StationHostConvergenceCommandSchema = z.discriminatedUnion("action", [
  z
    .object({ ...common, action: z.literal("replace-idle") })
    .strict()
    .refine(
      ({ expected }) => expected.terminals.length === 0,
      "Idle replacement requires an empty terminal set.",
    ),
  z
    .object({
      ...common,
      action: z.literal("handoff"),
      expected: eligibleHandoffEvidence,
      fidelity: HostHandoffFidelitySchema,
    })
    .strict(),
]);
export type StationHostConvergenceCommand = z.infer<typeof StationHostConvergenceCommandSchema>;

/** Synchronously clones and contextually admits immutable authority without performing I/O. */
export function parseStationHostConvergenceCommand(
  input: unknown,
  context: {
    targetBuild: StationHostTargetBuild;
    socketPath: string;
    nowMs: number;
  },
): StationHostConvergenceCommand {
  const command = StationHostConvergenceCommandSchema.parse(input);
  if (
    command.targetBuild.buildVersion !== context.targetBuild.buildVersion ||
    command.targetBuild.buildIdentity !== context.targetBuild.buildIdentity ||
    command.socketPath !== context.socketPath ||
    command.expected.endpoint.socketPath !== context.socketPath
  )
    throw new Error("Station Host convergence authority does not match its context.");
  if (!Number.isSafeInteger(context.nowMs) || command.deadlineMs <= context.nowMs)
    throw new Error("Station Host convergence authority has expired.");
  if (stationHostEvidenceMatchesTargetBuild(command.expected, command.targetBuild))
    throw new Error("Station Host already has the exact target build.");
  return command;
}

const lifetimeIdentity = StationHostTerminalLifetimeSchema.pick({
  terminalTargetId: true,
  ptyId: true,
  ptyInstanceId: true,
});
const canonicalIdentities = z.array(lifetimeIdentity).superRefine((values, context) => {
  if (!stationHostTerminalLifetimeIdentitiesAreCanonical(values))
    context.addIssue({
      code: "custom",
      message: "Terminal identities must be canonical.",
    });
});
/** Manifest correlation evidence; it never authorizes successor ownership by itself. */
export const StationHostHandoffReceiptSchema = z
  .object({
    fidelity: HostHandoffFidelitySchema,
    terminals: canonicalIdentities.min(1),
  })
  .strict();
export type StationHostHandoffReceipt = z.infer<typeof StationHostHandoffReceiptSchema>;

export const StationHostConvergencePhaseSchema = z.enum([
  "admission",
  "incumbent-validation",
  "incumbent-release",
  "target-start",
  "target-validation",
  "adoption",
  "final-verification",
]);
export const StationHostTerminalDispositionSchema = z.enum([
  "none",
  "incumbent",
  "parked",
  "successor",
  "mixed",
  "unknown",
]);
const terminalRecovery = lifetimeIdentity.extend({
  /** Last disposition established by actual lifecycle or exact-evidence reads. */
  lastProvenDisposition: z.enum(["incumbent", "parked", "successor", "unknown"]),
});
/** Exact evidence carries only the physical source that actually produced it. */
export const StationHostSourcedExactEvidenceSchema = z
  .object({
    source: z.enum(["incumbent-session", "target-session", "independent-inspection"]),
    evidence: StationHostExactEvidenceSchema,
  })
  .strict();
const completed = {
  status: z.literal("completed"),
  targetBuild: StationHostTargetBuildSchema,
  finalEvidence: StationHostExactEvidenceSchema,
};
const failed = z
  .object({
    status: z.literal("failed"),
    action: z.enum(["replace-idle", "handoff"]),
    targetBuild: StationHostTargetBuildSchema,
    phase: StationHostConvergencePhaseSchema,
    incumbentDisposition: z.enum(["none", "preserved", "released", "unknown"]),
    terminalDisposition: StationHostTerminalDispositionSchema,
    recoveryAuthority: z.literal("none"),
    /** Canonical per-lifetime recovery truth, never inferred from an adoption acknowledgement. */
    terminalRecovery: z.array(terminalRecovery),
    /** Present only after a fully validated begin manifest. */
    handoffReceipt: StationHostHandoffReceiptSchema.optional(),
    lastExactEvidence: StationHostSourcedExactEvidenceSchema.optional(),
    error: SafeErrorSchema,
  })
  .strict();

export const StationHostConvergenceResultSchema = z.union([
  z.object({ ...completed, action: z.literal("replace-idle") }).strict(),
  z
    .object({
      ...completed,
      action: z.literal("handoff"),
      handoffReceipt: StationHostHandoffReceiptSchema,
    })
    .strict(),
  failed,
]);
export type StationHostConvergenceResult = z.infer<typeof StationHostConvergenceResultSchema>;

const stationHostUpdateCrossoverErrorSchema = z
  .object({
    tag: z.string().min(1).max(128),
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(4_096),
    hint: z.string().min(1).max(4_096).optional(),
  })
  .strict();

/** Strict private result returned to an update caller after Host crossover. */
export const StationHostUpdateCrossoverResultSchema = z.discriminatedUnion("status", [
  z.object({ schemaVersion: z.literal(1), status: z.literal("completed") }).strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      status: z.literal("failed"),
      error: stationHostUpdateCrossoverErrorSchema,
    })
    .strict(),
]);
export type StationHostUpdateCrossoverResult = z.infer<
  typeof StationHostUpdateCrossoverResultSchema
>;

/** Bounds the SafeError subset accepted across the update crossover process boundary. */
export function projectStationHostUpdateCrossoverError(
  error: z.infer<typeof SafeErrorSchema>,
): z.infer<typeof stationHostUpdateCrossoverErrorSchema> {
  const projected: z.infer<typeof stationHostUpdateCrossoverErrorSchema> = {
    tag: error.tag.slice(0, 128),
    code: error.code.slice(0, 128),
    message: error.message.slice(0, 4_096),
  };
  if (error.hint !== undefined) projected.hint = error.hint.slice(0, 4_096);
  return projected;
}
