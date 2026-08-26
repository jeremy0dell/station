import { z } from "zod";
import {
  type CommandId,
  CommandIdSchema,
  type HarnessRunId,
  HarnessRunIdSchema,
  type ProjectId,
  ProjectIdSchema,
  type ProviderId,
  ProviderIdSchema,
  type SessionGroupId,
  SessionGroupIdSchema,
  type SessionId,
  SessionIdSchema,
  type TerminalTargetId,
  TerminalTargetIdSchema,
  TimestampSchema,
  type WorktreeId,
  WorktreeIdSchema,
} from "./ids.js";
import { nonEmptyStringSchema } from "./shared.js";
import { StationBuildIdentitySchema } from "./stationBuildIdentity.js";

export const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

export const LogComponentSchema = z.enum([
  "observer",
  "cli",
  "tui",
  "hook",
  "provider",
  "station-host",
]);
export type LogComponent = z.infer<typeof LogComponentSchema>;

const MAX_CLI_IDENTIFIER_BYTES = 256;
const MAX_CLI_PATH_SEGMENTS = 8;
const MAX_CLI_OPTIONS = 32;
const suspiciousExactIdentifierPattern =
  /(?:bearer\s+|\b(?:ghp|github_pat)_[a-z0-9_]{8,}\b|\bsk-[a-z0-9_-]{12,}\b|(?:token|secret|password|api[_-]?key|access[_-]?key)=|^[a-z0-9+/=]{40,}$)/iu;

function boundedExactIdentifier<T extends z.ZodType<string>>(schema: T): T {
  return schema.refine(
    (value) =>
      new TextEncoder().encode(value).byteLength <= MAX_CLI_IDENTIFIER_BYTES &&
      !suspiciousExactIdentifierPattern.test(value),
    "CLI audit identifiers must be bounded and must not look like secrets.",
  ) as T;
}

const CliAuditIdentifierSchema = boundedExactIdentifier(nonEmptyStringSchema);
const CliAuditCommandIdSchema = boundedExactIdentifier(CommandIdSchema);
const CliAuditProjectIdSchema = boundedExactIdentifier(ProjectIdSchema);
const CliAuditWorktreeIdSchema = boundedExactIdentifier(WorktreeIdSchema);
const CliAuditSessionIdSchema = boundedExactIdentifier(SessionIdSchema);
const CliAuditSessionGroupIdSchema = boundedExactIdentifier(SessionGroupIdSchema);
const CliAuditTerminalTargetIdSchema = boundedExactIdentifier(TerminalTargetIdSchema);
const CliAuditHarnessRunIdSchema = boundedExactIdentifier(HarnessRunIdSchema);
const CliAuditProviderIdSchema = boundedExactIdentifier(ProviderIdSchema);
const CliAuditErrorLabelSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u);

export const CliInvocationIdSchema = z.uuid();
export type CliInvocationId = z.infer<typeof CliInvocationIdSchema>;

export const CliInvocationEffectSchema = z.enum(["none", "read", "recovery", "mutation"]);
export type CliInvocationEffect = z.infer<typeof CliInvocationEffectSchema>;

export const CliInvocationTerminalStatusSchema = z.enum([
  "help",
  "version",
  "succeeded",
  "failed",
  "rejected",
  "timed_out",
  "parse_failure",
  "config_failure",
  "unknown_command",
  "diagnostic_recovery",
  "process_exception",
]);
export type CliInvocationTerminalStatus = z.infer<typeof CliInvocationTerminalStatusSchema>;

export type CliInvocationCommandCorrelation = {
  commandId: CommandId;
  traceId?: string;
};

export const CliInvocationCommandCorrelationSchema = z
  .object({
    commandId: CliAuditCommandIdSchema,
    traceId: CliAuditIdentifierSchema.optional(),
  })
  .strict() as z.ZodType<CliInvocationCommandCorrelation>;

export type CliInvocationResourceIds = {
  projectId?: ProjectId;
  worktreeId?: WorktreeId;
  sessionId?: SessionId;
  groupId?: SessionGroupId;
  targetId?: TerminalTargetId;
  runId?: HarnessRunId;
  provider?: ProviderId;
};

export const CliInvocationResourceIdsSchema = z
  .object({
    projectId: CliAuditProjectIdSchema.optional(),
    worktreeId: CliAuditWorktreeIdSchema.optional(),
    sessionId: CliAuditSessionIdSchema.optional(),
    groupId: CliAuditSessionGroupIdSchema.optional(),
    targetId: CliAuditTerminalTargetIdSchema.optional(),
    runId: CliAuditHarnessRunIdSchema.optional(),
    provider: CliAuditProviderIdSchema.optional(),
  })
  .strict()
  .refine(
    (value) => Object.values(value).some((identifier) => identifier !== undefined),
    "At least one exact resource id is required.",
  ) as z.ZodType<CliInvocationResourceIds>;

export const CliInvocationResourceIdsProjectionInputSchema = z
  .object({
    projectId: z.unknown().optional(),
    worktreeId: z.unknown().optional(),
    sessionId: z.unknown().optional(),
    groupId: z.unknown().optional(),
    targetId: z.unknown().optional(),
    runId: z.unknown().optional(),
    provider: z.unknown().optional(),
  })
  .strip();

export const CliInvocationCollectionSummarySchema = z
  .object({
    resource: z.enum(["projects", "worktrees", "sessions", "groups", "commands"]),
    count: z.number().int().nonnegative(),
    identifiersOmitted: z.literal(true),
  })
  .strict();
export type CliInvocationCollectionSummary = z.infer<typeof CliInvocationCollectionSummarySchema>;

type CliInvocationResolvedPlacement = {
  provider: ProviderId;
  targetId: TerminalTargetId;
  generation: string;
  presentation: "presented" | "detached";
};

const CliInvocationResolvedPlacementSchema = z
  .object({
    provider: CliAuditProviderIdSchema,
    targetId: CliAuditTerminalTargetIdSchema,
    generation: CliAuditIdentifierSchema,
    presentation: z.enum(["presented", "detached"]),
  })
  .strict() as z.ZodType<CliInvocationResolvedPlacement>;

export type CliInvocationPlacement = {
  requested: "sibling" | "detached";
  resolved?: CliInvocationResolvedPlacement;
};

export const CliInvocationPlacementSchema = z
  .object({
    requested: z.enum(["sibling", "detached"]),
    resolved: CliInvocationResolvedPlacementSchema.optional(),
  })
  .strict()
  .superRefine((placement, context) => {
    if (
      placement.resolved !== undefined &&
      ((placement.requested === "sibling" && placement.resolved.presentation !== "presented") ||
        (placement.requested === "detached" && placement.resolved.presentation !== "detached"))
    ) {
      context.addIssue({
        code: "custom",
        message: "Requested and resolved CLI placement presentations must agree.",
        path: ["resolved", "presentation"],
      });
    }
  }) as z.ZodType<CliInvocationPlacement>;

export type CliInvocationCallerContext = {
  presentation: "presented";
  session?: {
    sessionId: SessionId;
    projectId: ProjectId;
    worktreeId: WorktreeId;
    groupId?: SessionGroupId;
  };
};

export const CliInvocationCallerContextSchema = z
  .object({
    presentation: z.literal("presented"),
    session: z
      .object({
        sessionId: CliAuditSessionIdSchema,
        projectId: CliAuditProjectIdSchema,
        worktreeId: CliAuditWorktreeIdSchema,
        groupId: CliAuditSessionGroupIdSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict() as z.ZodType<CliInvocationCallerContext>;

export const CliInvocationCallerContextProjectionInputSchema = z
  .object({
    presentation: z.unknown().optional(),
    session: z.unknown().optional(),
  })
  .strip();

export type CliInvocationErrorSummary = {
  tag: string;
  code: string;
  commandId?: CommandId;
  traceId?: string;
  diagnosticId?: string;
  projectId?: ProjectId;
  worktreeId?: WorktreeId;
  sessionId?: SessionId;
  provider?: ProviderId;
};

export const CliInvocationErrorSummarySchema = z
  .object({
    tag: CliAuditErrorLabelSchema,
    code: CliAuditErrorLabelSchema,
    commandId: CliAuditCommandIdSchema.optional(),
    traceId: CliAuditIdentifierSchema.optional(),
    diagnosticId: CliAuditIdentifierSchema.optional(),
    projectId: CliAuditProjectIdSchema.optional(),
    worktreeId: CliAuditWorktreeIdSchema.optional(),
    sessionId: CliAuditSessionIdSchema.optional(),
    provider: CliAuditProviderIdSchema.optional(),
  })
  .strict() as z.ZodType<CliInvocationErrorSummary>;

export const CliInvocationErrorSummaryProjectionInputSchema = z
  .object({
    tag: z.unknown().optional(),
    code: z.unknown().optional(),
    commandId: z.unknown().optional(),
    traceId: z.unknown().optional(),
    diagnosticId: z.unknown().optional(),
    projectId: z.unknown().optional(),
    worktreeId: z.unknown().optional(),
    sessionId: z.unknown().optional(),
    provider: z.unknown().optional(),
  })
  .strip();

export const CliRunAuditCommandStatusSchema = z.enum([
  "accepted",
  "rejected",
  "succeeded",
  "failed",
]);

export type CliRunAuditMetadata = {
  commandStatus?: "accepted" | "rejected" | "succeeded" | "failed";
  command?: CliInvocationCommandCorrelation;
  resources?: CliInvocationResourceIds;
  collection?: CliInvocationCollectionSummary;
  placement?: CliInvocationPlacement;
  callerContext?: CliInvocationCallerContext;
  error?: CliInvocationErrorSummary;
};

export const CliRunAuditMetadataSchema = z
  .object({
    commandStatus: CliRunAuditCommandStatusSchema.optional(),
    command: CliInvocationCommandCorrelationSchema.optional(),
    resources: CliInvocationResourceIdsSchema.optional(),
    collection: CliInvocationCollectionSummarySchema.optional(),
    placement: CliInvocationPlacementSchema.optional(),
    callerContext: CliInvocationCallerContextSchema.optional(),
    error: CliInvocationErrorSummarySchema.optional(),
  })
  .strict()
  .superRefine((metadata, context) => {
    if (
      metadata.command !== undefined &&
      metadata.error?.commandId !== undefined &&
      metadata.command.commandId !== metadata.error.commandId
    ) {
      context.addIssue({
        code: "custom",
        message: "CLI audit command and error command ids must agree.",
        path: ["error", "commandId"],
      });
    }
    if (
      metadata.command?.traceId !== undefined &&
      metadata.error?.traceId !== undefined &&
      metadata.command.traceId !== metadata.error.traceId
    ) {
      context.addIssue({
        code: "custom",
        message: "CLI audit command and error trace ids must agree.",
        path: ["error", "traceId"],
      });
    }
  }) as z.ZodType<CliRunAuditMetadata>;

export const CliRunAuditMetadataProjectionInputSchema = z
  .object({
    commandStatus: z.unknown().optional(),
    command: z.unknown().optional(),
    resources: z.unknown().optional(),
    collection: z.unknown().optional(),
    placement: z.unknown().optional(),
    callerContext: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .strip();

export const CliInvocationArgumentShapeSchema = z
  .object({
    argumentCount: z.number().int().nonnegative(),
    positionalCount: z.number().int().nonnegative(),
    recognizedOptions: z.array(z.string().regex(/^--?[a-z][a-z0-9-]{0,63}$/u)).max(MAX_CLI_OPTIONS),
    stdinRequested: z.boolean(),
  })
  .strict();
export type CliInvocationArgumentShape = z.infer<typeof CliInvocationArgumentShapeSchema>;

export const CliInvocationBuildEvidenceSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("available"),
      version: z.string().trim().min(1).max(256),
      compiled: z.boolean(),
      buildIdentity: StationBuildIdentitySchema,
    })
    .strict(),
  z.object({ status: z.literal("unavailable") }).strict(),
]);
export type CliInvocationBuildEvidence = z.infer<typeof CliInvocationBuildEvidenceSchema>;

export type CliInvocationSinkEvidence =
  | {
      source: "configured";
      configResolution: "explicit" | "default";
    }
  | {
      source: "bootstrap_default";
      configResolution: "explicit" | "default";
      fallbackReason: "missing_default_config" | "config_load_failed";
    };

export const CliInvocationSinkEvidenceSchema = z
  .object({
    source: z.enum(["configured", "bootstrap_default"]),
    configResolution: z.enum(["explicit", "default"]),
    fallbackReason: z.enum(["missing_default_config", "config_load_failed"]).optional(),
  })
  .strict()
  .superRefine((sink, context) => {
    if ((sink.source === "bootstrap_default") !== (sink.fallbackReason !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Only a bootstrap CLI audit sink has a fallback reason.",
        path: ["fallbackReason"],
      });
    }
  }) as z.ZodType<CliInvocationSinkEvidence>;

const CliInvocationPathSchema = z
  .array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u))
  .max(MAX_CLI_PATH_SEGMENTS);

export const CliInvocationStartSchema = z
  .object({
    kind: z.literal("start"),
    invocationId: CliInvocationIdSchema,
    startedAt: TimestampSchema,
    build: CliInvocationBuildEvidenceSchema,
    intentPath: CliInvocationPathSchema,
    arguments: CliInvocationArgumentShapeSchema,
    effect: CliInvocationEffectSchema,
    sink: CliInvocationSinkEvidenceSchema,
    callerClaims: z
      .object({
        tmux: z.boolean(),
        tmuxPane: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type CliInvocationStart = z.infer<typeof CliInvocationStartSchema>;

export type CliInvocationOutcome = {
  kind: "outcome";
  invocationId: CliInvocationId;
  finishedAt: string;
  durationMs: number;
  status: CliInvocationTerminalStatus;
  exitCode: number;
  resolvedPath: string[];
  audit?: CliRunAuditMetadata;
};

export const CliInvocationOutcomeSchema = z
  .object({
    kind: z.literal("outcome"),
    invocationId: CliInvocationIdSchema,
    finishedAt: TimestampSchema,
    durationMs: z.number().int().nonnegative(),
    status: CliInvocationTerminalStatusSchema,
    exitCode: z.number().int(),
    resolvedPath: CliInvocationPathSchema,
    audit: CliRunAuditMetadataSchema.optional(),
  })
  .strict() as z.ZodType<CliInvocationOutcome>;

export type CliInvocationLifecycle = CliInvocationStart | CliInvocationOutcome;

export const CliInvocationLifecycleSchema = z.union([
  CliInvocationStartSchema,
  CliInvocationOutcomeSchema,
]) as z.ZodType<CliInvocationLifecycle>;
