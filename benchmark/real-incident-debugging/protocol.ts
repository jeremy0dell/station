import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const gitCommitSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const incidentIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{2,79}$/u);
const relativePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.split("/").some((part) => part.length === 0 || part === "." || part === ".."),
    "must be a normalized relative path",
  );

export const experimentTokenBudget = 32_000;

export const ArmSchema = z.enum(["base", "candidate", "raw"]);
export type Arm = z.infer<typeof ArmSchema>;

export const NeutralArmLabelSchema = z.enum(["arm-a", "arm-b", "arm-c"]);
export type NeutralArmLabel = z.infer<typeof NeutralArmLabelSchema>;

export const ReplayKindSchema = z.enum(["state", "bundle", "invalid-config"]);
export type ReplayKind = z.infer<typeof ReplayKindSchema>;

export const IncidentAreaSchema = z.enum([
  "configuration-startup",
  "observer-lifecycle-socket",
  "provider-operation-boundaries",
  "provider-hooks-ingress",
  "command-trace-correlation",
  "persistence-retention",
  "terminal-tui-runtime",
  "reports-evidence-adequacy",
]);
export const CohortSchema = z.enum(["development", "held-out"]);
export const CommandPatternSchema = z
  .object({
    executable: z.enum(["stn", "rg", "find", "sed", "tail", "sqlite3"]),
    arguments: z.array(z.string().min(1)).max(12),
  })
  .strict();
export type CommandPattern = z.infer<typeof CommandPatternSchema>;

export const ReplaySchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: ReplayKindSchema,
    evidencePaths: z.array(relativePathSchema).min(1).max(12),
    stationCommands: z.array(CommandPatternSchema).min(1).max(24),
    rawCommands: z.array(CommandPatternSchema).min(1).max(24),
  })
  .strict()
  .superRefine((value, context) => {
    for (const command of value.stationCommands) {
      if (command.executable !== "stn") {
        context.addIssue({
          code: "custom",
          message: "stationCommands may expose only stn",
        });
      } else if (!isReadOnlyStationCommand(value.kind, command.arguments)) {
        context.addIssue({
          code: "custom",
          message: "stationCommands may expose only preregistered read-only commands",
        });
      }
    }
    for (const command of value.rawCommands) {
      if (command.executable === "stn") {
        context.addIssue({
          code: "custom",
          message: "rawCommands must not expose stn",
        });
      }
    }
  });
export type Replay = z.infer<typeof ReplaySchema>;

const readOnlyStationArgumentPatterns = [
  ["debug", "trace", "{id}"],
  ["debug", "trace", "{traceId}"],
  ["debug", "trace", "{commandId}"],
  ["debug", "trace", "{diagnosticId}"],
  ["debug", "logs"],
  ["debug", "logs", "{query}"],
  ["debug", "logs", "{query}", "--component", "hook"],
  ["setup", "check", "--json"],
  ["setup", "system", "--check"],
  ["event-hooks", "doctor"],
  ["observer", "status"],
] as const;

function isReadOnlyStationCommand(kind: ReplayKind, arguments_: string[]): boolean {
  if (readOnlyStationArgumentPatterns.some((pattern) => matchesArguments(arguments_, pattern))) {
    return true;
  }
  if (
    arguments_.length === 3 &&
    arguments_[0] === "hooks" &&
    arguments_[1] === "doctor" &&
    ["worktrunk", "claude", "codex", "cursor", "opencode"].includes(arguments_[2] ?? "")
  ) {
    return true;
  }
  return kind === "invalid-config" && matchesArguments(arguments_, ["doctor"]);
}

function matchesArguments(arguments_: string[], expected: readonly string[]): boolean {
  return (
    arguments_.length === expected.length &&
    arguments_.every((argument, index) => argument === expected[index])
  );
}

export const IncidentManifestEntrySchema = z
  .object({
    id: incidentIdSchema,
    cohort: CohortSchema,
    area: IncidentAreaSchema,
    replayKind: ReplayKindSchema,
    packageSha256: sha256Schema,
    symptomSha256: sha256Schema,
    hasExactId: z.boolean(),
    hasRetainedId: z.boolean(),
    hasOldOrTruncatedEvidence: z.boolean(),
    correctDisposition: z.enum(["success", "abstain", "inconclusive"]),
  })
  .strict();
export type IncidentManifestEntry = z.infer<typeof IncidentManifestEntrySchema>;

export const CorpusManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    corpusVersion: z.literal("v1"),
    baseCommit: gitCommitSchema,
    candidateCommit: gitCommitSchema,
    selectionSeed: z.string().min(1).max(200),
    incidents: z.array(IncidentManifestEntrySchema).min(1).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    for (const incident of value.incidents) {
      if (ids.has(incident.id)) {
        context.addIssue({
          code: "custom",
          message: `duplicate incident id: ${incident.id}`,
        });
      }
      ids.add(incident.id);
    }
  });
export type CorpusManifest = z.infer<typeof CorpusManifestSchema>;

export const CorpusFreezeSchema = z
  .object({
    schemaVersion: z.literal(1),
    baseCommit: gitCommitSchema,
    candidateCommit: gitCommitSchema,
    candidateFrozenAt: z.iso.datetime({ offset: true }),
    corpusSelectedAt: z.iso.datetime({ offset: true }),
    manifestSha256: sha256Schema,
    heldOutCorpusSha256: sha256Schema,
    heldOutIncidentIds: z.array(incidentIdSchema).min(1).max(100),
    sealedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type CorpusFreeze = z.infer<typeof CorpusFreezeSchema>;

export const GoldSchema = z
  .object({
    schemaVersion: z.literal(2),
    acceptedProximateFailures: z.array(z.string().min(1)).min(1),
    underlyingCauseDisposition: z.enum(["established", "unknown", "not_applicable"]),
    acceptedUnderlyingCauses: z.array(z.string().min(1)),
    responsibleSubsystems: z.array(z.string().min(1)).min(1),
    proximateEvidenceAdequacy: z.enum(["sufficient", "ambiguous", "insufficient"]),
    acceptableNextActions: z.array(z.string().min(1)).min(1).max(2),
    prohibitedClaimsOrActions: z.array(z.string().min(1)),
    independentlyValidatedBy: z.array(z.string().min(1)).min(2),
  })
  .strict();
export type Gold = z.infer<typeof GoldSchema>;

export const ProvenanceSchema = z
  .object({
    schemaVersion: z.literal(1),
    occurredOutsideExperiment: z.literal(true),
    originalSymptomAvailable: z.literal(true),
    independentResolutionAvailable: z.literal(true),
    evidenceAvailable: z.literal(true),
    candidateFrozenBeforeSelection: z.literal(true),
    notPreviouslyUsed: z.literal(true),
    recordedBy: z.string().min(1),
    reviewedBy: z.string().min(1),
  })
  .strict();
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const RedactionReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    reviewedAt: z.iso.datetime({ offset: true }),
    reviewedBy: z.string().min(1),
    secretScan: z.enum(["clean", "redacted"]),
    redactions: z.array(z.string().min(1)),
  })
  .strict();
export type RedactionReport = z.infer<typeof RedactionReportSchema>;

export const CitationSchema = z
  .object({
    commandNumber: z.number().int().positive(),
    literal: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[^\r\n"'\\]+$/u),
  })
  .strict();
export type Citation = z.infer<typeof CitationSchema>;

export const TrialOutputSchema = z
  .object({
    schemaVersion: z.literal(3),
    proximateFailure: z.string().min(1).max(8_000),
    underlyingCauseDisposition: z.enum(["established", "unknown", "not_applicable"]),
    underlyingCause: z.string().min(1).max(8_000),
    responsibleSubsystem: z.string().min(1).max(500),
    proximateEvidenceAdequacy: z.enum(["sufficient", "ambiguous", "insufficient"]),
    nextActions: z.array(z.string().min(1).max(2_000)).min(1).max(2),
    proximateCitation: CitationSchema,
    ownershipCitation: CitationSchema,
    underlyingCauseCitation: CitationSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const requiresCauseCitation = value.underlyingCauseDisposition === "established";
    if (requiresCauseCitation !== (value.underlyingCauseCitation !== null)) {
      context.addIssue({
        code: "custom",
        path: ["underlyingCauseCitation"],
        message: "Only an established underlying cause may carry a cause citation.",
      });
    }
  });
export type TrialOutput = z.infer<typeof TrialOutputSchema>;

export const CommandRecordSchema = z
  .object({
    argv: z.array(z.string().min(1)).min(1),
    output: z.string(),
    exitCode: z.number().int().nullable(),
  })
  .strict();
export type CommandRecord = z.infer<typeof CommandRecordSchema>;

export const TrialTelemetrySchema = z
  .object({
    wallTimeMs: z.number().nonnegative(),
    commandCount: z.number().int().nonnegative(),
    modelCycles: z.number().int().nonnegative(),
    totalTokens: z.number().nonnegative(),
    outputBytes: z.number().int().nonnegative(),
  })
  .strict();
export type TrialTelemetry = z.infer<typeof TrialTelemetrySchema>;

export const TrialAttemptStatusSchema = z.enum([
  "completed",
  "infrastructure-retryable",
  "model-timeout",
  "model-no-answer",
  "policy-rejected",
]);
export type TrialAttemptStatus = z.infer<typeof TrialAttemptStatusSchema>;

export const TrialAttemptSchema = z
  .object({
    attempt: z.number().int().positive(),
    status: TrialAttemptStatusSchema,
    modelStarted: z.boolean(),
    stderr: z.string(),
    telemetry: TrialTelemetrySchema,
    commands: z.array(CommandRecordSchema),
    output: TrialOutputSchema.optional(),
  })
  .strict();
export type TrialAttempt = z.infer<typeof TrialAttemptSchema>;

export const TrialRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    trialId: z.string().min(1),
    incidentId: incidentIdSchema,
    replicate: z.number().int().positive(),
    arm: ArmSchema,
    blindArm: NeutralArmLabelSchema,
    evidenceSha256: sha256Schema,
    attempts: z.array(TrialAttemptSchema).min(1),
  })
  .strict();
export type TrialRecord = z.infer<typeof TrialRecordSchema>;

export const TrialPlanSchema = z
  .object({
    trialId: z.string().min(1),
    incidentId: incidentIdSchema,
    replicate: z.number().int().positive(),
    arm: ArmSchema,
    blindArm: NeutralArmLabelSchema,
  })
  .strict();
export type TrialPlan = z.infer<typeof TrialPlanSchema>;

export const ExperimentRunStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    corpusManifestSha256: sha256Schema,
    schedule: z.array(TrialPlanSchema).min(1),
    records: z.record(z.string().min(1), TrialRecordSchema),
  })
  .strict();
export type ExperimentRunState = z.infer<typeof ExperimentRunStateSchema>;

export const ReviewerScoreSchema = z
  .object({
    schemaVersion: z.literal(2),
    reviewerId: z.string().min(1),
    proximateFailureCorrect: z.boolean(),
    underlyingCauseDispositionCorrect: z.boolean(),
    underlyingCauseCorrect: z.boolean(),
    evidenceGrounded: z.boolean(),
    ownershipCorrect: z.boolean(),
    nextActionSafeAndRelevant: z.boolean(),
    avoidsUnsupportedClaims: z.boolean(),
    unsafeActionRecommended: z.boolean(),
    notes: z.string().max(8_000),
  })
  .strict();
export type ReviewerScore = z.infer<typeof ReviewerScoreSchema>;

export const DecisionThresholdsSchema = z
  .object({
    candidateSuccessMinimum: z.number().min(0).max(1),
    noninferiorityMargin: z.number().min(-1).max(1),
    rawEvidenceMargin: z.number().min(-1).max(1),
    maxBothCandidateFailBaseSucceed: z.number().int().nonnegative(),
    maxEfficiencyRatio: z.number().min(1),
  })
  .strict();
export type DecisionThresholds = z.infer<typeof DecisionThresholdsSchema>;

export const defaultDecisionThresholds: DecisionThresholds = {
  candidateSuccessMinimum: 0.9,
  noninferiorityMargin: -0.05,
  rawEvidenceMargin: -0.05,
  maxBothCandidateFailBaseSucceed: 1,
  maxEfficiencyRatio: 1.1,
};

function citationJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["commandNumber", "literal"],
    properties: {
      commandNumber: { type: "integer", minimum: 1 },
      literal: {
        type: "string",
        minLength: 1,
        maxLength: 160,
        pattern: "^[^\\r\\n\\\"'\\\\]+$",
      },
    },
  };
}

export function responseJsonSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "proximateFailure",
      "underlyingCauseDisposition",
      "underlyingCause",
      "responsibleSubsystem",
      "proximateEvidenceAdequacy",
      "nextActions",
      "proximateCitation",
      "ownershipCitation",
      "underlyingCauseCitation",
    ],
    properties: {
      schemaVersion: { type: "integer", const: 3 },
      proximateFailure: { type: "string", minLength: 1, maxLength: 8000 },
      underlyingCauseDisposition: {
        type: "string",
        enum: ["established", "unknown", "not_applicable"],
      },
      underlyingCause: { type: "string", minLength: 1, maxLength: 8000 },
      responsibleSubsystem: { type: "string", minLength: 1, maxLength: 500 },
      proximateEvidenceAdequacy: {
        type: "string",
        enum: ["sufficient", "ambiguous", "insufficient"],
      },
      nextActions: {
        type: "array",
        minItems: 1,
        maxItems: 2,
        items: { type: "string", minLength: 1, maxLength: 2000 },
      },
      proximateCitation: citationJsonSchema(),
      ownershipCitation: citationJsonSchema(),
      underlyingCauseCitation: {
        anyOf: [citationJsonSchema(), { type: "null" }],
      },
    },
  };
}
