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

const boundedCrossoverError = z
  .object({
    tag: z.string().min(1).max(128),
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(4_096),
    hint: z.string().min(1).max(4_096).optional(),
  })
  .strict();
const recoveryCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Bounded failure truth retained across the updater's successor-CLI process boundary. */
export const StationHostConvergenceFailureSummarySchema = z
  .object({
    status: z.literal("failed"),
    action: z.enum(["replace-idle", "handoff"]),
    phase: StationHostConvergencePhaseSchema,
    incumbentDisposition: z.enum(["none", "preserved", "released", "unknown"]),
    terminalDisposition: StationHostTerminalDispositionSchema,
    recoveryAuthority: z.literal("none"),
    terminalCount: recoveryCount,
    terminalRecoveryCounts: z
      .object({
        incumbent: recoveryCount,
        parked: recoveryCount,
        successor: recoveryCount,
        unknown: recoveryCount,
      })
      .strict(),
    handoffReceipt: z
      .object({
        retained: z.boolean(),
        terminalCount: recoveryCount,
        fidelity: HostHandoffFidelitySchema.optional(),
      })
      .strict(),
    error: boundedCrossoverError,
  })
  .strict();
export type StationHostConvergenceFailureSummary = z.infer<
  typeof StationHostConvergenceFailureSummarySchema
>;

/** Strict private result emitted by successor Host crossover for its invoking updater. */
export const StationHostUpdateCrossoverResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      schemaVersion: z.literal(1),
      status: z.literal("completed"),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      status: z.literal("failed"),
      error: boundedCrossoverError,
      convergenceFailure: StationHostConvergenceFailureSummarySchema.optional(),
    })
    .strict(),
]);
export type StationHostUpdateCrossoverResult = z.infer<
  typeof StationHostUpdateCrossoverResultSchema
>;

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

/** Removes per-terminal identity and bounds error text before crossing the updater subprocess seam. */
export function summarizeStationHostConvergenceFailure(
  result: Extract<StationHostConvergenceResult, { status: "failed" }>,
): StationHostConvergenceFailureSummary {
  const terminalRecoveryCounts = {
    incumbent: 0,
    parked: 0,
    successor: 0,
    unknown: 0,
  };
  for (const terminal of result.terminalRecovery) {
    terminalRecoveryCounts[terminal.lastProvenDisposition] += 1;
  }
  const error = projectStationHostCrossoverError(result.error);
  return StationHostConvergenceFailureSummarySchema.parse({
    status: result.status,
    action: result.action,
    phase: result.phase,
    incumbentDisposition: result.incumbentDisposition,
    terminalDisposition: result.terminalDisposition,
    recoveryAuthority: result.recoveryAuthority,
    terminalCount: result.terminalRecovery.length,
    terminalRecoveryCounts,
    handoffReceipt: {
      retained: result.handoffReceipt !== undefined,
      terminalCount: result.handoffReceipt?.terminals.length ?? 0,
      ...(result.handoffReceipt === undefined ? {} : { fidelity: result.handoffReceipt.fidelity }),
    },
    error,
  });
}

/** Bounds the SafeError subset admitted by the updater's fixed-size subprocess capture. */
export function projectStationHostCrossoverError(
  error: z.infer<typeof SafeErrorSchema>,
): z.infer<typeof boundedCrossoverError> {
  const projected: z.infer<typeof boundedCrossoverError> = {
    tag: boundedText(error.tag, 128),
    code: boundedText(error.code, 128),
    message: boundedText(error.message, 4_096),
  };
  if (error.hint !== undefined) projected.hint = boundedText(error.hint, 4_096);
  return projected;
}

function boundedText(value: string, maxLength: number): string {
  return value.slice(0, maxLength);
}
