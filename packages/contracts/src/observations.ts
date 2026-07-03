import { z } from "zod";
import { TerminalHarnessBindingSchema } from "./harnessTerminalBinding.js";
import {
  HarnessRunIdSchema,
  ProjectIdSchema,
  ProviderIdSchema,
  SessionIdSchema,
  TerminalTargetIdSchema,
  TimestampSchema,
  WorktreeIdSchema,
} from "./ids.js";
import { nonEmptyStringSchema, optionalProviderDataSchema } from "./shared.js";

export const ConfidenceSchema = z.enum(["high", "medium", "low"]);
export const WorktreeStateSchema = z.enum(["exists", "missing", "orphaned"]);
export const TerminalStateSchema = z.enum(["none", "open", "detached", "stale", "unknown"]);
export const AgentStateSchema = z.enum([
  "none",
  "starting",
  "idle",
  "working",
  "needs_attention",
  "stuck",
  "exited",
  "unknown",
]);
export const ObservedStatusSourceSchema = z.enum([
  "harness_hook",
  "harness_event",
  "harness_process",
  "terminal_capture",
  "worktree_provider",
  "observer_command",
  "reconcile",
  "unknown",
]);

export type Confidence = z.infer<typeof ConfidenceSchema>;
export type WorktreeState = z.infer<typeof WorktreeStateSchema>;
export type TerminalState = z.infer<typeof TerminalStateSchema>;
export type AgentState = z.infer<typeof AgentStateSchema>;
export type ObservedStatusSource = z.infer<typeof ObservedStatusSourceSchema>;

export const WorktreeSourceSchema = z.enum(["worktrunk", "station", "manual", "unknown"]);
export type WorktreeSource = z.infer<typeof WorktreeSourceSchema>;

export const RepositoryRemoteSchema = z
  .object({
    host: nonEmptyStringSchema,
    owner: nonEmptyStringSchema,
    repo: nonEmptyStringSchema,
    url: nonEmptyStringSchema.optional(),
  })
  .strict();

export type RepositoryRemote = z.infer<typeof RepositoryRemoteSchema>;

export const WorktreePullRequestSchema = z
  .object({
    number: z.number().int().positive(),
    url: z.string().url().optional(),
    host: nonEmptyStringSchema.optional(),
    state: z.enum(["open", "closed", "merged", "draft", "unknown"]).optional(),
    baseRef: nonEmptyStringSchema.optional(),
    headRef: nonEmptyStringSchema.optional(),
    updatedAt: TimestampSchema.optional(),
    checkedAt: TimestampSchema.optional(),
    stale: z.boolean().optional(),
  })
  .strict();

export const GitShaSchema = z.string().regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/);

export const WorktreeChangeSummarySchema = z
  .object({
    kind: z.literal("branch_diff"),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    filesChanged: z.number().int().nonnegative().optional(),
    binaryFiles: z.number().int().nonnegative().optional(),
    baseRef: nonEmptyStringSchema.optional(),
    baseSha: GitShaSchema.optional(),
    mergeBaseSha: GitShaSchema.optional(),
    headRef: nonEmptyStringSchema.optional(),
    headSha: GitShaSchema.optional(),
    source: nonEmptyStringSchema,
    checkedAt: TimestampSchema,
    stale: z.boolean().optional(),
  })
  .strict();

export const WorktreeChecksStateSchema = z.enum([
  "pass",
  "fail",
  "running",
  "none",
  "unknown",
  "skipped",
  "cancelled",
]);

export const WorktreeChecksSummarySchema = z
  .object({
    state: WorktreeChecksStateSchema,
    url: z.string().url().optional(),
    total: z.number().int().nonnegative().optional(),
    passed: z.number().int().nonnegative().optional(),
    failed: z.number().int().nonnegative().optional(),
    pending: z.number().int().nonnegative().optional(),
    skipped: z.number().int().nonnegative().optional(),
    cancelled: z.number().int().nonnegative().optional(),
    reason: nonEmptyStringSchema.optional(),
    source: nonEmptyStringSchema,
    checkedAt: TimestampSchema,
    stale: z.boolean().optional(),
  })
  .strict();

export type WorktreePullRequest = z.infer<typeof WorktreePullRequestSchema>;
export type WorktreeChangeSummary = z.infer<typeof WorktreeChangeSummarySchema>;
export type WorktreeChecksState = z.infer<typeof WorktreeChecksStateSchema>;
export type WorktreeChecksSummary = z.infer<typeof WorktreeChecksSummarySchema>;

// Closed taxonomy for user-blocking states, normalized at each provider
// boundary so core and the TUI never match on provider prose.
export const AttentionKindSchema = z.enum(["question", "plan_approval", "tool_approval", "input"]);

export type AttentionKind = z.infer<typeof AttentionKindSchema>;

export const ObservedStatusSchema = z
  .object({
    value: AgentStateSchema,
    confidence: ConfidenceSchema,
    reason: nonEmptyStringSchema,
    source: ObservedStatusSourceSchema,
    updatedAt: TimestampSchema,
    attention: AttentionKindSchema.optional(),
  })
  .strict();

export type ObservedStatus = z.infer<typeof ObservedStatusSchema>;

export const HarnessEventDiagnosticsSchema = z
  .object({
    rawEventType: nonEmptyStringSchema.optional(),
    payloadBytes: z.number().int().nonnegative().optional(),
    compactedBytes: z.number().int().nonnegative().optional(),
    compacted: z.boolean().optional(),
    truncated: z.boolean().optional(),
    omittedFieldNames: z.array(nonEmptyStringSchema).optional(),
  })
  .strict();

export type HarnessEventDiagnostics = z.infer<typeof HarnessEventDiagnosticsSchema>;

export const HarnessTurnSchema = z
  .object({
    kind: z.literal("turn_completed"),
  })
  .strict();

export type HarnessTurn = z.infer<typeof HarnessTurnSchema>;

export const WorktreeObservationSchema = z
  .object({
    id: WorktreeIdSchema,
    provider: ProviderIdSchema,
    projectId: ProjectIdSchema,
    branch: nonEmptyStringSchema,
    path: nonEmptyStringSchema,
    state: WorktreeStateSchema,
    source: WorktreeSourceSchema,
    dirty: z.boolean().optional(),
    ahead: z.number().int().nonnegative().optional(),
    behind: z.number().int().nonnegative().optional(),
    remote: RepositoryRemoteSchema.optional(),
    headSha: GitShaSchema.optional(),
    pr: WorktreePullRequestSchema.optional(),
    changeSummary: WorktreeChangeSummarySchema.optional(),
    checks: WorktreeChecksSummarySchema.optional(),
    confidence: ConfidenceSchema.optional(),
    reason: nonEmptyStringSchema.optional(),
    observedAt: TimestampSchema,
    providerData: optionalProviderDataSchema,
  })
  .strict();

export type WorktreeObservation = z.infer<typeof WorktreeObservationSchema>;

export const TerminalTargetObservationSchema = z
  .object({
    id: TerminalTargetIdSchema,
    provider: ProviderIdSchema,
    projectId: ProjectIdSchema.optional(),
    worktreeId: WorktreeIdSchema.optional(),
    sessionId: SessionIdSchema.optional(),
    harnessRunId: HarnessRunIdSchema.optional(),
    state: TerminalStateSchema,
    focusable: z.boolean().optional(),
    closeable: z.boolean().optional(),
    cwd: nonEmptyStringSchema.optional(),
    pid: z.number().int().positive().optional(),
    title: nonEmptyStringSchema.optional(),
    confidence: ConfidenceSchema,
    reason: nonEmptyStringSchema,
    observedAt: TimestampSchema,
    harnessBinding: TerminalHarnessBindingSchema.optional(),
    providerData: optionalProviderDataSchema,
  })
  .strict();

export type TerminalTargetObservation = z.infer<typeof TerminalTargetObservationSchema>;

export const HarnessRunObservationSchema = z
  .object({
    id: HarnessRunIdSchema,
    provider: ProviderIdSchema,
    projectId: ProjectIdSchema.optional(),
    worktreeId: WorktreeIdSchema.optional(),
    sessionId: SessionIdSchema.optional(),
    pid: z.number().int().positive().optional(),
    cwd: nonEmptyStringSchema.optional(),
    state: AgentStateSchema,
    confidence: ConfidenceSchema,
    reason: nonEmptyStringSchema,
    observedAt: TimestampSchema,
    providerData: optionalProviderDataSchema,
  })
  .strict();

export type HarnessRunObservation = z.infer<typeof HarnessRunObservationSchema>;

export const HarnessStatusObservationSchema = z
  .object({
    provider: ProviderIdSchema,
    runId: HarnessRunIdSchema.optional(),
    projectId: ProjectIdSchema.optional(),
    worktreeId: WorktreeIdSchema.optional(),
    sessionId: SessionIdSchema.optional(),
    status: ObservedStatusSchema,
    observedAt: TimestampSchema,
    providerData: optionalProviderDataSchema,
  })
  .strict();

export type HarnessStatusObservation = z.infer<typeof HarnessStatusObservationSchema>;

export const HarnessEventObservationSchema = z
  .object({
    provider: ProviderIdSchema,
    reportId: nonEmptyStringSchema.optional(),
    eventType: nonEmptyStringSchema.optional(),
    projectId: ProjectIdSchema.optional(),
    sessionId: SessionIdSchema.optional(),
    worktreeId: WorktreeIdSchema.optional(),
    terminalTargetId: TerminalTargetIdSchema.optional(),
    harnessRunId: HarnessRunIdSchema.optional(),
    nativeSessionId: nonEmptyStringSchema.optional(),
    nativeSessionFile: nonEmptyStringSchema.optional(),
    cwd: nonEmptyStringSchema.optional(),
    pid: z.number().int().positive().optional(),
    status: ObservedStatusSchema.optional(),
    turn: HarnessTurnSchema.optional(),
    rawEventType: nonEmptyStringSchema.optional(),
    diagnostics: HarnessEventDiagnosticsSchema.optional(),
    providerData: optionalProviderDataSchema,
    observedAt: TimestampSchema,
  })
  .strict();

export type HarnessEventObservation = z.infer<typeof HarnessEventObservationSchema>;

export const TerminalIdentityBindingSchema = z
  .object({
    provider: ProviderIdSchema,
    targetId: TerminalTargetIdSchema,
    projectId: ProjectIdSchema.optional(),
    worktreeId: WorktreeIdSchema.optional(),
    sessionId: SessionIdSchema.optional(),
    harnessRunId: HarnessRunIdSchema.optional(),
    harnessBinding: TerminalHarnessBindingSchema.optional(),
    providerData: optionalProviderDataSchema,
    confidence: ConfidenceSchema,
    reason: nonEmptyStringSchema,
  })
  .strict();

export type TerminalIdentityBinding = z.infer<typeof TerminalIdentityBindingSchema>;
