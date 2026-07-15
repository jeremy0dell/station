import { z } from "zod";
import { ClientFeatureFlagsSchema } from "./featureFlags.js";
import {
  HarnessRunIdSchema,
  ProjectIdSchema,
  ProviderIdSchema,
  SchemaVersionSchema,
  SessionIdSchema,
  TerminalTargetIdSchema,
  TimestampSchema,
  WorktreeIdSchema,
} from "./ids.js";
import {
  AgentStateSchema,
  AttentionKindSchema,
  ConfidenceSchema,
  GitShaSchema,
  ObservedStatusSchema,
  RepositoryRemoteSchema,
  TerminalStateSchema,
  WorktreeChangeSummarySchema,
  WorktreeChecksSummarySchema,
  WorktreePullRequestSchema,
  WorktreeSourceSchema,
  WorktreeStateSchema,
} from "./observations.js";
import { HarnessCapabilitiesSchema, ProviderHealthSchema } from "./providers.js";
import { nonEmptyStringSchema, safeTextSchema } from "./shared.js";

export const ProjectDefaultsSchema = z
  .object({
    harness: ProviderIdSchema,
    terminal: ProviderIdSchema,
    layout: nonEmptyStringSchema,
  })
  .strict();

export const ProjectViewSchema = z
  .object({
    id: ProjectIdSchema,
    label: nonEmptyStringSchema,
    root: nonEmptyStringSchema,
    defaults: ProjectDefaultsSchema,
    health: ProviderHealthSchema,
    counts: z
      .object({
        sessions: z.number().int().nonnegative(),
        worktrees: z.number().int().nonnegative(),
        agents: z.number().int().nonnegative(),
        working: z.number().int().nonnegative(),
        idle: z.number().int().nonnegative(),
        attention: z.number().int().nonnegative(),
        unknown: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export type ProjectView = z.infer<typeof ProjectViewSchema>;

export const WorktreeRuntimeSchema = z
  .object({
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
  })
  .strict();

export const TerminalAttachmentSchema = z
  .object({
    provider: ProviderIdSchema,
    state: TerminalStateSchema,
    focusable: z.boolean().optional(),
    closeable: z.boolean().optional(),
    hasWorkspace: z.boolean().optional(),
    hasPrimaryAgentEndpoint: z.boolean().optional(),
    confidence: ConfidenceSchema.optional(),
    reason: nonEmptyStringSchema.optional(),
    observedAt: TimestampSchema.optional(),
  })
  .strict();

export const WorktreeTerminalSchema = TerminalAttachmentSchema;

export type TerminalAttachment = z.infer<typeof TerminalAttachmentSchema>;

export const TurnReadinessSchema = z
  .object({
    state: z.literal("ready_to_read"),
    token: nonEmptyStringSchema,
    completedAt: TimestampSchema,
  })
  .strict();

export type TurnReadiness = z.infer<typeof TurnReadinessSchema>;

export const WorktreeAgentSchema = z
  .object({
    harness: ProviderIdSchema,
    state: AgentStateSchema,
    pid: z.number().int().positive().optional(),
    runId: HarnessRunIdSchema.optional(),
    sessionId: SessionIdSchema.optional(),
    confidence: ConfidenceSchema,
    reason: nonEmptyStringSchema,
    updatedAt: TimestampSchema,
    attention: AttentionKindSchema.optional(),
    turnReadiness: TurnReadinessSchema.optional(),
  })
  .strict();

export const DisplayStatusLabelSchema = z.enum([
  "no agent",
  "starting",
  "idle",
  "working",
  "needs attention",
  "stuck",
  "exited",
  "unknown",
]);

export const WorktreeDisplaySchema = z
  .object({
    statusLabel: DisplayStatusLabelSchema,
    sortPriority: z.number().int(),
    alert: z.boolean(),
    warning: z.boolean().optional(),
    reason: nonEmptyStringSchema.optional(),
  })
  .strict();

export const WorktreeRecoveryActionSchema = z
  .object({
    kind: z.literal("agent-resume"),
    handleId: nonEmptyStringSchema,
    provider: ProviderIdSchema,
    targetKind: z.enum(["native-session", "session-file"]),
    sessionId: SessionIdSchema.optional(),
    lastSeenAt: TimestampSchema,
  })
  .strict();

export type WorktreeRecoveryAction = z.infer<typeof WorktreeRecoveryActionSchema>;

export const WorktreeRowSchema = z
  .object({
    id: WorktreeIdSchema,
    projectId: ProjectIdSchema,
    projectLabel: nonEmptyStringSchema,
    branch: nonEmptyStringSchema,
    path: nonEmptyStringSchema,
    registrationIdentity: nonEmptyStringSchema.optional(),
    worktree: WorktreeRuntimeSchema,
    terminal: TerminalAttachmentSchema.optional(),
    agent: WorktreeAgentSchema.optional(),
    recovery: WorktreeRecoveryActionSchema.optional(),
    display: WorktreeDisplaySchema,
  })
  .strict();

export const WorktreeViewSchema = WorktreeRowSchema;

export type WorktreeRow = z.infer<typeof WorktreeRowSchema>;
export type WorktreeView = WorktreeRow;

export const SessionOriginSchema = z.enum(["station", "external"]);

export type SessionOrigin = z.infer<typeof SessionOriginSchema>;

export const SessionViewSchema = z
  .object({
    id: SessionIdSchema,
    origin: SessionOriginSchema,
    projectId: ProjectIdSchema,
    worktreeId: WorktreeIdSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    harness: z
      .object({
        provider: ProviderIdSchema,
        mode: z.enum(["interactive", "exec", "unknown"]),
        pid: z.number().int().positive().optional(),
        runId: HarnessRunIdSchema.optional(),
        capabilities: HarnessCapabilitiesSchema,
      })
      .strict(),
    terminal: TerminalAttachmentSchema.optional(),
    status: ObservedStatusSchema,
    title: nonEmptyStringSchema,
    tags: z.array(nonEmptyStringSchema),
  })
  .strict();

export type SessionView = z.infer<typeof SessionViewSchema>;

export const StationAlertSchema = z
  .object({
    id: nonEmptyStringSchema,
    severity: z.enum(["info", "warn", "error"]),
    message: safeTextSchema,
    code: nonEmptyStringSchema.optional(),
    projectId: ProjectIdSchema.optional(),
    worktreeId: WorktreeIdSchema.optional(),
    sessionId: SessionIdSchema.optional(),
    provider: ProviderIdSchema.optional(),
    createdAt: TimestampSchema,
  })
  .strict();

export type StationAlert = z.infer<typeof StationAlertSchema>;

export const SnapshotHarnessSchema = z
  .object({
    id: ProviderIdSchema,
    label: nonEmptyStringSchema,
    /** Best-effort local CLI version; absent when the probe failed or hasn't run. */
    installedVersion: nonEmptyStringSchema.optional(),
    /** Best-effort registry version from a cached, offline-safe lookup. */
    latestVersion: nonEmptyStringSchema.optional(),
    /** Set only when both versions are known; consumers omit the badge otherwise. */
    updateAvailable: z.boolean().optional(),
  })
  .strict();

export type SnapshotHarness = z.infer<typeof SnapshotHarnessSchema>;

export const OrphanedRuntimeStateSchema = z
  .object({
    id: nonEmptyStringSchema,
    kind: z.enum(["terminal_target", "harness_run", "session"]),
    provider: ProviderIdSchema,
    projectId: ProjectIdSchema.optional(),
    worktreeId: WorktreeIdSchema.optional(),
    sessionId: SessionIdSchema.optional(),
    terminalTargetId: TerminalTargetIdSchema.optional(),
    harnessRunId: HarnessRunIdSchema.optional(),
    reason: nonEmptyStringSchema,
    observedAt: TimestampSchema,
  })
  .strict();

export type OrphanedRuntimeState = z.infer<typeof OrphanedRuntimeStateSchema>;

export const StationSnapshotSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    generatedAt: TimestampSchema,
    observer: z
      .object({
        pid: z.number().int().positive(),
        startedAt: TimestampSchema,
        version: nonEmptyStringSchema,
        healthy: z.boolean(),
      })
      .strict(),
    providerHealth: z.record(ProviderIdSchema, ProviderHealthSchema),
    harnesses: z.array(SnapshotHarnessSchema).optional(),
    projects: z.array(ProjectViewSchema),
    rows: z.array(WorktreeRowSchema),
    sessions: z.array(SessionViewSchema),
    counts: z
      .object({
        projects: z.number().int().nonnegative(),
        sessions: z.number().int().nonnegative(),
        worktrees: z.number().int().nonnegative(),
        agents: z.number().int().nonnegative(),
        working: z.number().int().nonnegative(),
        idle: z.number().int().nonnegative(),
        attention: z.number().int().nonnegative(),
        unknown: z.number().int().nonnegative(),
      })
      .strict(),
    alerts: z.array(StationAlertSchema),
    featureFlags: ClientFeatureFlagsSchema.optional(),
    orphans: z.array(OrphanedRuntimeStateSchema).optional(),
  })
  .strict();

export type StationSnapshot = z.infer<typeof StationSnapshotSchema>;
