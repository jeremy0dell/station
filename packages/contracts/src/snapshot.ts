import { z } from "zod";
import { ClientFeatureFlagsSchema } from "./featureFlags.js";
import {
  HarnessRunIdSchema,
  ProjectIdSchema,
  ProviderIdSchema,
  SchemaVersionSchema,
  SessionGroupIdSchema,
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
    /** External provider-focus evidence; renderer-local opening routes are separate. */
    focusable: z.boolean().optional(),
    closeable: z.boolean().optional(),
    /** Whether the provider can currently issue an opaque managed attachment. */
    hasManagedAttachment: z.boolean().optional(),
    hasWorkspace: z.boolean().optional(),
    hasPrimaryAgentEndpoint: z.boolean().optional(),
    confidence: ConfidenceSchema.optional(),
    reason: nonEmptyStringSchema.optional(),
    observedAt: TimestampSchema.optional(),
  })
  .strict();

export type TerminalAttachment = z.infer<typeof TerminalAttachmentSchema>;

export const TurnReadinessSchema = z
  .object({
    state: z.literal("ready_to_read"),
    token: nonEmptyStringSchema,
    completedAt: TimestampSchema,
  })
  .strict();

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
    title: nonEmptyStringSchema,
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

export type WorktreeRow = z.infer<typeof WorktreeRowSchema>;

export const SessionOriginSchema = z.enum(["station", "external"]);

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

export const SessionGroupViewSchema = z
  .object({
    id: SessionGroupIdSchema,
    projectId: ProjectIdSchema,
    name: z.string().trim().min(1),
    sessionIds: z.array(SessionIdSchema),
    parentGroupId: SessionGroupIdSchema.optional(),
    version: z.number().int().positive(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((group, context) => {
    if (new Set(group.sessionIds).size !== group.sessionIds.length) {
      context.addIssue({
        code: "custom",
        message: "Group session ids must be unique.",
        path: ["sessionIds"],
      });
    }
    if (Date.parse(group.updatedAt) < Date.parse(group.createdAt)) {
      context.addIssue({
        code: "custom",
        message: "Group updatedAt must not precede createdAt.",
        path: ["updatedAt"],
      });
    }
  });

export type SessionGroupView = z.infer<typeof SessionGroupViewSchema>;

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

export const SnapshotTerminalTargetDebugSchema = z
  .object({
    id: TerminalTargetIdSchema,
    provider: ProviderIdSchema,
    projectId: ProjectIdSchema.optional(),
    worktreeId: WorktreeIdSchema.optional(),
    sessionId: SessionIdSchema.optional(),
    state: TerminalStateSchema,
    focusable: z.boolean().optional(),
    closeable: z.boolean().optional(),
    hasManagedAttachment: z.boolean().optional(),
    confidence: ConfidenceSchema,
    reason: nonEmptyStringSchema,
    observedAt: TimestampSchema,
  })
  .strict();

export type SnapshotTerminalTargetDebug = z.infer<typeof SnapshotTerminalTargetDebugSchema>;

export const StationSnapshotDebugSchema = z
  .object({
    terminalTargets: z.array(SnapshotTerminalTargetDebugSchema),
  })
  .strict();

export type StationSnapshotDebug = z.infer<typeof StationSnapshotDebugSchema>;

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
    sessionGroups: z.array(SessionGroupViewSchema),
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
    /** Opt-in, redaction-safe evidence derived from the same reconcile as this snapshot. */
    debug: StationSnapshotDebugSchema.optional(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    // Individual schemas validate records; this pass protects relationships across the snapshot graph.
    const projectIds = new Set(snapshot.projects.map((project) => project.id));
    const sessions = new Map(snapshot.sessions.map((session) => [session.id, session]));
    const groups = new Map<string, SessionGroupView>();
    const assignedSessions = new Map<string, string>();

    for (const [index, group] of snapshot.sessionGroups.entries()) {
      if (groups.has(group.id)) {
        context.addIssue({
          code: "custom",
          message: "Group ids must be unique.",
          path: ["sessionGroups", index, "id"],
        });
      } else {
        groups.set(group.id, group);
      }
      if (!projectIds.has(group.projectId)) {
        context.addIssue({
          code: "custom",
          message: "Group project must exist in the snapshot.",
          path: ["sessionGroups", index, "projectId"],
        });
      }
      for (const [memberIndex, sessionId] of group.sessionIds.entries()) {
        const session = sessions.get(sessionId);
        if (session === undefined) {
          context.addIssue({
            code: "custom",
            message: "Group member must reference a snapshot session.",
            path: ["sessionGroups", index, "sessionIds", memberIndex],
          });
        } else if (session.projectId !== group.projectId) {
          context.addIssue({
            code: "custom",
            message: "Group member must belong to the Group project.",
            path: ["sessionGroups", index, "sessionIds", memberIndex],
          });
        }
        const assignedGroupId = assignedSessions.get(sessionId);
        if (assignedGroupId !== undefined && assignedGroupId !== group.id) {
          context.addIssue({
            code: "custom",
            message: "A session may belong to only one Group.",
            path: ["sessionGroups", index, "sessionIds", memberIndex],
          });
        } else {
          assignedSessions.set(sessionId, group.id);
        }
      }
    }

    for (const [index, group] of snapshot.sessionGroups.entries()) {
      if (group.parentGroupId === undefined) continue;
      const parent = groups.get(group.parentGroupId);
      if (parent === undefined) {
        context.addIssue({
          code: "custom",
          message: "Group parent must exist in the snapshot.",
          path: ["sessionGroups", index, "parentGroupId"],
        });
      } else if (parent.id === group.id) {
        context.addIssue({
          code: "custom",
          message: "A Group cannot parent itself.",
          path: ["sessionGroups", index, "parentGroupId"],
        });
      } else if (parent.projectId !== group.projectId) {
        context.addIssue({
          code: "custom",
          message: "Group parent must belong to the same project.",
          path: ["sessionGroups", index, "parentGroupId"],
        });
      }
    }

    for (const [index, group] of snapshot.sessionGroups.entries()) {
      const visited = new Set([group.id]);
      let parentId = group.parentGroupId;
      while (parentId !== undefined) {
        if (visited.has(parentId)) {
          context.addIssue({
            code: "custom",
            message: "Group parents must not form a cycle.",
            path: ["sessionGroups", index, "parentGroupId"],
          });
          break;
        }
        visited.add(parentId);
        parentId = groups.get(parentId)?.parentGroupId;
      }
    }
  });

export type StationSnapshot = z.infer<typeof StationSnapshotSchema>;
