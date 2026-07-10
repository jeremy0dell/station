import { z } from "zod";
import type { TerminalFocusOrigin } from "./commands.js";
import type { SafeError } from "./errors.js";
import { SafeErrorSchema } from "./errors.js";
import type {
  HarnessRunId,
  ProjectId,
  ProviderId,
  SessionId,
  TerminalTargetId,
  WorktreeId,
} from "./ids.js";
import {
  ProjectIdSchema,
  ProviderIdSchema,
  TerminalTargetIdSchema,
  TimestampSchema,
  WorktreeIdSchema,
} from "./ids.js";
import type {
  HarnessEventObservation,
  HarnessRunObservation,
  HarnessStatusObservation,
  RepositoryRemote,
  TerminalIdentityBinding,
  TerminalTargetObservation,
  WorktreeChecksSummary,
  WorktreeObservation,
  WorktreePullRequest,
} from "./observations.js";
import { RepositoryRemoteSchema } from "./observations.js";
import type { HarnessResumeOptions } from "./recovery.js";
import { nonEmptyStringSchema } from "./shared.js";

export const ProviderTypeSchema = z.enum(["worktree", "terminal", "harness", "repository"]);
export const ProviderHealthStatusSchema = z.enum(["healthy", "degraded", "unavailable", "unknown"]);

export const ProviderHealthSchema = z
  .object({
    providerId: ProviderIdSchema,
    providerType: ProviderTypeSchema,
    status: ProviderHealthStatusSchema,
    lastCheckedAt: TimestampSchema,
    lastError: SafeErrorSchema.optional(),
    latencyMs: z.number().nonnegative().optional(),
    capabilities: z.record(nonEmptyStringSchema, z.boolean()).optional(),
    diagnostics: z.record(nonEmptyStringSchema, z.string()).optional(),
  })
  .strict();

export type ProviderHealth = z.infer<typeof ProviderHealthSchema>;

export const WorktreeCapabilitiesSchema = z
  .object({
    canCreate: z.boolean(),
    canRemove: z.boolean(),
    canList: z.boolean(),
    canEmitLifecycleEvents: z.boolean(),
    canExposeDirtyState: z.boolean(),
    canSeedWorkingTree: z.boolean(),
  })
  .strict();

export type WorktreeCapabilities = z.infer<typeof WorktreeCapabilitiesSchema>;

export const TerminalCapabilitiesSchema = z
  .object({
    canOpenWorkspace: z.boolean(),
    canFocusTarget: z.boolean(),
    canCloseTarget: z.boolean(),
    canCaptureOutput: z.boolean(),
    canSendInput: z.boolean(),
    canPersistIdentityBinding: z.boolean(),
    canDisplayPopup: z.boolean(),
  })
  .strict();

export type TerminalCapabilities = z.infer<typeof TerminalCapabilitiesSchema>;

export const HarnessCapabilitiesSchema = z
  .object({
    canLaunch: z.boolean(),
    canDiscoverRuns: z.boolean(),
    canEmitEvents: z.boolean(),
    canClassifyStatus: z.boolean(),
    canReceivePrompt: z.boolean(),
    canResume: z.boolean(),
    canStop: z.boolean(),
    canRunNonInteractive: z.boolean(),
    canExposeApprovalState: z.boolean(),
    supportsModifiedEnterSoftNewline: z.boolean(),
  })
  .strict();

export type HarnessCapabilities = z.infer<typeof HarnessCapabilitiesSchema>;

export const RepositoryCapabilitiesSchema = z
  .object({
    canDiscoverPullRequests: z.boolean(),
    canReadChecks: z.boolean(),
    canUseCliAuth: z.boolean(),
  })
  .strict();

export type RepositoryCapabilities = z.infer<typeof RepositoryCapabilitiesSchema>;

export const HarnessPermissionModeSchema = z.enum(["standard", "yolo"]);

export type HarnessPermissionMode = z.infer<typeof HarnessPermissionModeSchema>;

export const ProviderProjectDefaultsSchema = z
  .object({
    harness: ProviderIdSchema,
    terminal: ProviderIdSchema,
    layout: nonEmptyStringSchema,
  })
  .strict();

export const ProviderProjectWorktrunkConfigSchema = z
  .object({
    enabled: z.boolean(),
    base: nonEmptyStringSchema.optional(),
    managedRoot: nonEmptyStringSchema.optional(),
    includeMain: z.boolean().optional(),
    includeExternal: z.boolean().optional(),
  })
  .strict();

export const ProviderProjectRecoveryBreadcrumbsSchema = z
  .object({
    location: z.enum(["external", "worktree", "provider-native", "disabled"]),
    path: nonEmptyStringSchema.optional(),
  })
  .strict();

export const ProviderProjectConfigSchema = z
  .object({
    id: ProjectIdSchema,
    label: nonEmptyStringSchema,
    root: nonEmptyStringSchema,
    defaultBranch: nonEmptyStringSchema.optional(),
    defaults: ProviderProjectDefaultsSchema,
    worktrunk: ProviderProjectWorktrunkConfigSchema,
    recoveryBreadcrumbs: ProviderProjectRecoveryBreadcrumbsSchema.optional(),
  })
  .strict();

export type ProviderProjectConfig = z.infer<typeof ProviderProjectConfigSchema>;

export type CreateWorktreeRequest = {
  project: ProviderProjectConfig;
  branch: string;
  base?: string;
  path?: string;
  // When set, the provider seeds the new worktree's working tree (staged,
  // unstaged, and untracked changes) from this source path after creation.
  // The observer resolves the source worktree's absolute path; the UI never
  // supplies filesystem paths directly.
  seedFrom?: { path: string; worktreeId?: WorktreeId };
};

export type RemoveWorktreeRequest = {
  worktreeId: WorktreeId;
  projectId?: ProjectId;
  force?: boolean;
};

export type RemoveWorktreeResult = {
  worktreeId: WorktreeId;
  removed: boolean;
  reason?: string;
};

export type GetWorktreeRequest = {
  worktreeId?: WorktreeId;
  projectId?: ProjectId;
  path?: string;
};

export type RawWorktreeEvent = {
  provider: ProviderId;
  event: unknown;
  observedAt?: string;
};

export type WorktreeEventContext = {
  projects: ProviderProjectConfig[];
};

export type ProviderDoctorCheck = {
  name: string;
  status: "ok" | "warn" | "error";
  message: string;
  error?: SafeError;
};

export type ProviderDoctorContext = {
  stationConfigPath?: string;
};

/**
 * Import-safe hook-install status for launch gates: `installed` is the gate,
 * `requested` separates missing hooks from config that never asked for them.
 */
export type HarnessHooksStatus = {
  provider: ProviderId;
  installed: boolean;
  requested: boolean;
  missing: string[];
  message: string;
};

export type OpenWorkspaceRequest = {
  project: ProviderProjectConfig;
  worktree: WorktreeObservation;
  harness: ProviderId;
  layout: string;
  sessionId?: SessionId;
};

export type OpenWorkspaceResult = {
  target: TerminalIdentityBinding;
  agentEndpointId: string;
  providerData?: unknown;
};

export type RawTerminalEvent = {
  provider: ProviderId;
  event: unknown;
  observedAt?: string;
};

export type TerminalEventContext = {
  projects: ProviderProjectConfig[];
  worktrees: WorktreeObservation[];
};

export type TerminalCapture = {
  targetId: TerminalTargetId;
  capturedAt: string;
  text: string;
  providerData?: unknown;
};

export type TerminalFocusContext = {
  origin?: TerminalFocusOrigin;
};

export type BuildHarnessLaunchRequest = {
  project: ProviderProjectConfig;
  worktree: WorktreeObservation;
  terminalTarget?: TerminalTargetObservation;
  sessionId?: SessionId;
  mode?: "interactive" | "exec";
  initialPrompt?: string;
  profile?: string;
  permissionMode?: HarnessPermissionMode;
  approvalPolicy?: string;
  sandboxMode?: string;
  resume?: HarnessResumeOptions;
};

export const HarnessLaunchPlanSchema = z
  .object({
    provider: ProviderIdSchema,
    command: nonEmptyStringSchema,
    args: z.array(z.string()),
    cwd: nonEmptyStringSchema.optional(),
    env: z.record(nonEmptyStringSchema, z.string()).optional(),
    mode: z.enum(["interactive", "exec"]),
    displayTitle: nonEmptyStringSchema.optional(),
    providerData: z.unknown().optional(),
  })
  .strict();

export type HarnessLaunchPlan = z.infer<typeof HarnessLaunchPlanSchema>;

export type TerminalLaunchProcessRequest = {
  project: ProviderProjectConfig;
  worktree: WorktreeObservation;
  terminalTarget: TerminalIdentityBinding;
  agentEndpointId: string;
  launchPlan: HarnessLaunchPlan;
  signal?: AbortSignal;
};

export const ManagedTerminalAttachmentSchema = z
  .object({
    kind: z.literal("managed-terminal"),
    terminalTargetId: TerminalTargetIdSchema,
  })
  .strict();

export type ManagedTerminalAttachment = z.infer<typeof ManagedTerminalAttachmentSchema>;

export type TerminalLaunchProcessResult = {
  terminalTargetId: TerminalTargetId;
  agentEndpointId: string;
  started: boolean;
  /** When `started` and managed, the opaque target a client may attach to. */
  attachment?: ManagedTerminalAttachment;
  providerData?: unknown;
};

export type HarnessDiscoveryContext = {
  projects: ProviderProjectConfig[];
  worktrees: WorktreeObservation[];
  terminalTargets: TerminalTargetObservation[];
};

export type HarnessClassificationContext = {
  projects: ProviderProjectConfig[];
  worktrees: WorktreeObservation[];
  terminalTargets: TerminalTargetObservation[];
};

export type RawHarnessEvent = {
  provider: ProviderId;
  event: unknown;
  observedAt?: string;
};

export type HarnessEventContext = {
  projects: ProviderProjectConfig[];
  worktrees: WorktreeObservation[];
  terminalTargets: TerminalTargetObservation[];
};

export type HarnessStopRequest = {
  runId: HarnessRunId;
  sessionId?: SessionId;
  force?: boolean;
};

export type HarnessStopResult = {
  runId: HarnessRunId;
  stopped: boolean;
  reason?: string;
};

export const RepositoryPullRequestRequestSchema = z
  .object({
    remote: RepositoryRemoteSchema,
    branch: nonEmptyStringSchema,
    headSha: z
      .string()
      .regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/)
      .optional(),
    worktreeId: WorktreeIdSchema.optional(),
    projectId: ProjectIdSchema.optional(),
  })
  .strict();

export type RepositoryPullRequestRequest = z.infer<typeof RepositoryPullRequestRequestSchema> & {
  signal?: AbortSignal;
};

export const RepositoryChecksRequestSchema = z
  .object({
    remote: RepositoryRemoteSchema,
    pullRequestNumber: z.number().int().positive(),
    branch: nonEmptyStringSchema.optional(),
    headSha: z
      .string()
      .regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/)
      .optional(),
    worktreeId: WorktreeIdSchema.optional(),
    projectId: ProjectIdSchema.optional(),
  })
  .strict();

export type RepositoryChecksRequest = z.infer<typeof RepositoryChecksRequestSchema> & {
  signal?: AbortSignal;
};

export interface WorktreeProvider {
  id: ProviderId;
  capabilities(): WorktreeCapabilities;
  health(): Promise<ProviderHealth>;
  doctorChecks?(context?: ProviderDoctorContext): Promise<ProviderDoctorCheck[]>;
  ingestEvent?(
    event: RawWorktreeEvent,
    context: WorktreeEventContext,
  ): Promise<WorktreeObservation[]>;
  listWorktrees(project: ProviderProjectConfig): Promise<WorktreeObservation[]>;
  createWorktree(request: CreateWorktreeRequest): Promise<WorktreeObservation>;
  removeWorktree(request: RemoveWorktreeRequest): Promise<RemoveWorktreeResult>;
  getWorktree?(request: GetWorktreeRequest): Promise<WorktreeObservation | null>;
}

export interface TerminalProvider {
  id: ProviderId;
  capabilities(): TerminalCapabilities;
  health(): Promise<ProviderHealth>;
  doctorChecks?(context?: ProviderDoctorContext): Promise<ProviderDoctorCheck[]>;
  ingestEvent?(
    event: RawTerminalEvent,
    context: TerminalEventContext,
  ): Promise<TerminalTargetObservation[]>;
  listTargets(): Promise<TerminalTargetObservation[]>;
  openWorkspace(request: OpenWorkspaceRequest): Promise<OpenWorkspaceResult>;
  launchProcess?(request: TerminalLaunchProcessRequest): Promise<TerminalLaunchProcessResult>;
  focusTarget(targetId: TerminalTargetId, context?: TerminalFocusContext): Promise<void>;
  closeTarget(targetId: TerminalTargetId): Promise<void>;
  captureTarget?(targetId: TerminalTargetId): Promise<TerminalCapture>;
  sendInput?(targetId: TerminalTargetId, input: string): Promise<void>;
}

export type ManagedTerminalLaunchProcessResult =
  | (Omit<TerminalLaunchProcessResult, "started" | "attachment"> & {
      started: false;
      attachment?: never;
    })
  | (Omit<TerminalLaunchProcessResult, "started" | "attachment"> & {
      started: true;
      attachment: ManagedTerminalAttachment;
    });

/**
 * DRIVEN PORT
 *
 * Owns the single managed terminal target used for an external Station launch.
 * Attachments expose only adapter-owned target identity, and at most one target
 * may exist per worktree.
 */
export interface ManagedTerminalLifecycle extends TerminalProvider {
  launchProcess(request: TerminalLaunchProcessRequest): Promise<ManagedTerminalLaunchProcessResult>;
  attachmentForTarget(targetId: TerminalTargetId): Promise<ManagedTerminalAttachment | undefined>;
  /** Forgets an abandoned or already-exited target without terminating its process. */
  releaseTarget(targetId: TerminalTargetId): Promise<boolean>;
}

/** Best-effort version probe result; omit fields (or the method) when unknown. */
export type HarnessVersionInfo = {
  installedVersion?: string;
  latestVersion?: string;
};

export interface HarnessProvider {
  id: ProviderId;
  capabilities(): HarnessCapabilities;
  health(): Promise<ProviderHealth>;
  doctorChecks?(context?: ProviderDoctorContext): Promise<ProviderDoctorCheck[]>;
  /**
   * Best-effort, offline-safe version probe: installed from the local CLI,
   * latest from a cached registry lookup. The observer calls this once in the
   * background and caches the result — it must never gate reconciliation, and
   * failures should resolve to an empty object rather than throw.
   */
  versionInfo?(): Promise<HarnessVersionInfo>;
  /**
   * Report whether this harness's status hooks are installed. Optional: a
   * harness that cannot determine hook installation omits it, and callers
   * gating on hooks should fail open for such providers.
   */
  hooksStatus?(context?: ProviderDoctorContext): Promise<HarnessHooksStatus>;
  buildLaunch(request: BuildHarnessLaunchRequest): Promise<HarnessLaunchPlan>;
  discoverRuns(context: HarnessDiscoveryContext): Promise<HarnessRunObservation[]>;
  classifyRun(
    run: HarnessRunObservation,
    context: HarnessClassificationContext,
  ): Promise<HarnessStatusObservation>;
  ingestEvent?(
    event: RawHarnessEvent,
    context: HarnessEventContext,
  ): Promise<HarnessEventObservation[]>;
  stop?(request: HarnessStopRequest): Promise<HarnessStopResult>;
}

/**
 * DRIVEN PORT
 *
 * Supplies code-host metadata and declares deterministic, I/O-free remote
 * support so application policy can select an adapter.
 */
export interface RepositoryProvider {
  id: ProviderId;
  supportsRemote(remote: RepositoryRemote): boolean;
  capabilities(): RepositoryCapabilities;
  health(): Promise<ProviderHealth>;
  doctorChecks?(context?: ProviderDoctorContext): Promise<ProviderDoctorCheck[]>;
  discoverPullRequest(request: RepositoryPullRequestRequest): Promise<WorktreePullRequest | null>;
  readChecks(request: RepositoryChecksRequest): Promise<WorktreeChecksSummary | null>;
}
