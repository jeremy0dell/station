import { z } from "zod";
import {
  CommandIdSchema,
  ProjectIdSchema,
  ProviderIdSchema,
  SessionIdSchema,
  TimestampSchema,
  WorktreeIdSchema,
} from "./ids.js";
import { nonEmptyStringSchema, safeTextSchema } from "./shared.js";

export const ErrorSeveritySchema = z.enum(["debug", "info", "warn", "error", "fatal"]);

export const WorktreeRemovalRefusalReasonSchema = z.enum([
  "ambiguous_identity",
  "branch_changed",
  "default_branch",
  "identity_changed",
  "missing_target",
  "path_changed",
  "primary_checkout",
  "protection_unverified",
  "registration_changed",
  "registration_unverified",
  "snapshot_changed",
]);

export type WorktreeRemovalRefusalReason = z.infer<typeof WorktreeRemovalRefusalReasonSchema>;

export const SafeErrorSchema = z
  .object({
    tag: nonEmptyStringSchema,
    code: nonEmptyStringSchema,
    message: safeTextSchema,
    hint: safeTextSchema.optional(),
    commandId: CommandIdSchema.optional(),
    projectId: ProjectIdSchema.optional(),
    worktreeId: WorktreeIdSchema.optional(),
    sessionId: SessionIdSchema.optional(),
    provider: ProviderIdSchema.optional(),
    traceId: nonEmptyStringSchema.optional(),
    diagnosticId: nonEmptyStringSchema.optional(),
  })
  .strict();

export type SafeError = z.infer<typeof SafeErrorSchema>;

export const ExternalCommandDiagnosticDetailSchema = z
  .object({
    type: z.literal("external_command"),
    provider: ProviderIdSchema.optional(),
    operation: nonEmptyStringSchema,
    command: nonEmptyStringSchema,
    cwd: nonEmptyStringSchema.optional(),
    exitCode: z.number().int().optional(),
    signal: nonEmptyStringSchema.optional(),
    stdoutSnippet: nonEmptyStringSchema.optional(),
    stderrSnippet: nonEmptyStringSchema.optional(),
    durationMs: z.number().nonnegative().optional(),
  })
  .strict();

export type ExternalCommandDiagnosticDetail = z.infer<typeof ExternalCommandDiagnosticDetailSchema>;

export const WorktreeRemovalRefusalDiagnosticDetailSchema = z
  .object({
    type: z.literal("worktree_removal_refusal"),
    provider: ProviderIdSchema.optional(),
    projectId: ProjectIdSchema.optional(),
    worktreeId: WorktreeIdSchema,
    canonicalPath: nonEmptyStringSchema,
    observedBranch: nonEmptyStringSchema,
    refusalReason: WorktreeRemovalRefusalReasonSchema,
  })
  .strict();

export type WorktreeRemovalRefusalDiagnosticDetail = z.infer<
  typeof WorktreeRemovalRefusalDiagnosticDetailSchema
>;

export const DiagnosticDetailSchema = z.discriminatedUnion("type", [
  ExternalCommandDiagnosticDetailSchema,
  WorktreeRemovalRefusalDiagnosticDetailSchema,
]);

export type DiagnosticDetail = z.infer<typeof DiagnosticDetailSchema>;

export const ErrorEnvelopeSchema = z
  .object({
    id: nonEmptyStringSchema,
    tag: nonEmptyStringSchema,
    code: nonEmptyStringSchema,
    message: nonEmptyStringSchema,
    severity: ErrorSeveritySchema,
    commandId: CommandIdSchema.optional(),
    traceId: nonEmptyStringSchema.optional(),
    spanId: nonEmptyStringSchema.optional(),
    projectId: ProjectIdSchema.optional(),
    worktreeId: WorktreeIdSchema.optional(),
    sessionId: SessionIdSchema.optional(),
    provider: ProviderIdSchema.optional(),
    cause: z.unknown().optional(),
    stack: z.string().optional(),
    raw: z.unknown().optional(),
    diagnostics: z.array(DiagnosticDetailSchema).optional(),
    redacted: z.boolean(),
    createdAt: TimestampSchema,
  })
  .strict();

export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
