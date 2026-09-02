import { isAbsolute } from "node:path";
import { z } from "zod";
import type { TerminalFocusOrigin } from "./commands/terminal.js";
import { SafeErrorSchema } from "./errors.js";
import type { HarnessRunId, ProviderId, SessionId, TerminalTargetId, WorktreeId } from "./ids.js";
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
  RepositoryRemote,
  TerminalIdentityBinding,
  TerminalTargetObservation,
  WorktreeChecksSummary,
  WorktreeObservation,
  WorktreePullRequest,
} from "./observations.js";
import { GitShaSchema, RepositoryRemoteSchema } from "./observations.js";
import type { ProviderHookHealth, ProviderHookReconciliationResult } from "./providerHooks.js";
import type { HarnessResumeOptions } from "./recovery.js";
import { nonEmptyStringSchema } from "./shared.js";
import { StationBuildIdentitySchema } from "./stationBuildIdentity.js";
import type {
  ResolvedTerminalPlacement,
  TerminalCallerContextRequest,
  TerminalPlacementIntent,
  TerminalPlacementRequest,
  TerminalPlacementSource,
} from "./terminalPlacement.js";

export const ProviderTypeSchema = z.enum(["worktree", "terminal", "harness", "repository"]);
export const ProviderHealthStatusSchema = z.enum(["healthy", "degraded", "unavailable", "unknown"]);

export const ProviderHealthSchema = z
  .object({
    provider: ProviderIdSchema,
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
    canLaunchProcessPersistently: z.boolean(),
    canDisplayPopup: z.boolean(),
  })
  .strict();

export type TerminalCapabilities = z.infer<typeof TerminalCapabilitiesSchema>;

export const HarnessCapabilitiesSchema = z
  .object({
    canLaunch: z.boolean(),
    canDiscoverRuns: z.boolean(),
    canEmitEvents: z.boolean(),
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
  project: ProviderProjectConfig;
  worktreeId: WorktreeId;
  expectedPath: string;
  expectedBranch: string;
  expectedRegistrationIdentity: string;
  force?: boolean;
};

export type RemoveWorktreeResult = {
  worktreeId: WorktreeId;
  removed: boolean;
  reason?: string;
};

export const DoctorCheckSchema = z
  .object({
    name: nonEmptyStringSchema,
    status: z.enum(["ok", "warn", "error"]),
    message: nonEmptyStringSchema,
    error: SafeErrorSchema.optional(),
  })
  .strict();
export type DoctorCheck = z.infer<typeof DoctorCheckSchema>;
export type ProviderDoctorCheck = z.infer<typeof DoctorCheckSchema>;

const providerHookAbsolutePathSchema = nonEmptyStringSchema.refine(
  isAbsolute,
  "Provider hook runtime paths must be absolute.",
);

export const ProviderHookArtifactOwnerSchema = z
  .object({
    schemaVersion: z.literal(1),
    launcher: providerHookAbsolutePathSchema,
    runtimeKind: z.enum(["compiled", "source"]),
    version: nonEmptyStringSchema,
    buildIdentity: StationBuildIdentitySchema,
  })
  .strict();

export type ProviderHookArtifactOwner = z.infer<typeof ProviderHookArtifactOwnerSchema>;

export const ProviderHookArtifactOwnershipSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("absent"),
      requested: ProviderHookArtifactOwnerSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("same-owner"),
      requested: ProviderHookArtifactOwnerSchema,
      currentLauncher: providerHookAbsolutePathSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("different-owner"),
      requested: ProviderHookArtifactOwnerSchema,
      currentLauncher: providerHookAbsolutePathSchema,
      current: ProviderHookArtifactOwnerSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("unknown-owner"),
      requested: ProviderHookArtifactOwnerSchema,
    })
    .strict(),
]);

export type ProviderHookArtifactOwnership = z.infer<typeof ProviderHookArtifactOwnershipSchema>;

export const ProviderHookRuntimeSchema = z
  .object({
    ingressLauncher: providerHookAbsolutePathSchema,
    observerSocketPath: providerHookAbsolutePathSchema,
    stateDir: providerHookAbsolutePathSchema,
    hookSpoolDir: providerHookAbsolutePathSchema,
    autoStartFromHooks: z.boolean(),
    stationConfigPath: providerHookAbsolutePathSchema.optional(),
    artifactOwner: ProviderHookArtifactOwnerSchema.optional(),
  })
  .strict();

export type ProviderHookRuntime = z.infer<typeof ProviderHookRuntimeSchema>;

export type ProviderDoctorContext = {
  stationConfigPath?: string;
  providerHookRuntime?: ProviderHookRuntime;
  projects?: readonly ProviderProjectConfig[];
  /** Cancels boundary work that has not begun a durable mutation. */
  signal?: AbortSignal;
  /** Bounds boundary work that has not begun a durable mutation. */
  timeoutMs?: number;
};

/** Provider-neutral context for a hook writer that must join the caller's durable commit. */
export type ProviderHookReconciliationContext = ProviderDoctorContext & {
  /** Called once immediately before the first durable provider artifact mutation. */
  beginMutation?: () => void;
};

/**
 * Import-safe hook-install status for launch gates: `installed` is the gate,
 * `requested` separates missing hooks from config that never asked for them, and
 * ownership preserves requester-versus-artifact provenance for setup diagnostics.
 */
export type HarnessHooksStatus = {
  provider: ProviderId;
  installed: boolean;
  requested: boolean;
  missing: string[];
  message: string;
  ownership?: ProviderHookArtifactOwnership;
};

export type OpenWorkspaceRequest = {
  project: ProviderProjectConfig;
  worktree: WorktreeObservation;
  harness: ProviderId;
  layout: string;
  sessionId?: SessionId;
};

export type OpenPlacedWorkspaceRequest = OpenWorkspaceRequest & {
  placement: TerminalPlacementRequest;
};

export type OpenWorkspaceResult = {
  target: TerminalIdentityBinding;
  agentEndpointId: string;
};

export type OpenPlacedWorkspaceResult = OpenWorkspaceResult & {
  placement: ResolvedTerminalPlacement;
  /** Opaque authority for releasing only this provisional placement binding. */
  bindingToken: string;
};

export type ReleasePlacedTerminalTargetRequest = {
  targetId: TerminalTargetId;
  sessionId: SessionId;
  generation: string;
  bindingToken: string;
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

export const HarnessModeSchema = z.enum(["interactive", "exec"]);

export type HarnessMode = z.infer<typeof HarnessModeSchema>;

export type BuildHarnessLaunchRequest = {
  project: ProviderProjectConfig;
  worktree: WorktreeObservation;
  terminalTarget?: TerminalTargetObservation;
  sessionId?: SessionId;
  mode?: HarnessMode;
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
    mode: HarnessModeSchema,
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

/** Provider-neutral output policy for the component that owns a terminal process. */
export const TerminalOutputCompatibilitySchema = z.enum(["top-region-scrollback"]);

export type TerminalOutputCompatibility = z.infer<typeof TerminalOutputCompatibilitySchema>;

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
    headSha: GitShaSchema.optional(),
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
    headSha: GitShaSchema.optional(),
    worktreeId: WorktreeIdSchema.optional(),
    projectId: ProjectIdSchema.optional(),
  })
  .strict();

export type RepositoryChecksRequest = z.infer<typeof RepositoryChecksRequestSchema> & {
  signal?: AbortSignal;
};

/**
 * DRIVEN PORT
 *
 * Supplies fresh worktree lifecycle evidence and mutations without exposing provider mechanics.
 * Callers provide project context for mutations; removal adapters must revalidate opaque registration identity,
 * path, and branch immediately before mutation.
 */
export interface WorktreeProvider {
  id: ProviderId;
  capabilities(): WorktreeCapabilities;
  health(): Promise<ProviderHealth>;
  doctorChecks?(context?: ProviderDoctorContext): Promise<ProviderDoctorCheck[]>;
  listWorktrees(project: ProviderProjectConfig): Promise<WorktreeObservation[]>;
  createWorktree(request: CreateWorktreeRequest): Promise<WorktreeObservation>;
  removeWorktree(request: RemoveWorktreeRequest): Promise<RemoveWorktreeResult>;
}

/**
 * DRIVEN PORT
 *
 * Supplies ordinary terminal topology and lifecycle through provider-owned target identities
 * without exposing provider mechanics. Target focusability describes external provider control,
 * not whether a particular renderer can reveal or attach to the target. A reconcile-specific read
 * may refuse adapter-retained targets that remain available to other callers; refused evidence is
 * excluded from both the current graph and debug projection. Caller-relative placement is a
 * separate optional role.
 */
export interface TerminalProvider {
  id: ProviderId;
  capabilities(): TerminalCapabilities;
  health(): Promise<ProviderHealth>;
  doctorChecks?(context?: ProviderDoctorContext): Promise<ProviderDoctorCheck[]>;
  listTargets(): Promise<TerminalTargetObservation[]>;
  listTargetsForReconcile?(): Promise<TerminalTargetObservation[]>;
  openWorkspace(request: OpenWorkspaceRequest): Promise<OpenWorkspaceResult>;
  launchProcess?(request: TerminalLaunchProcessRequest): Promise<TerminalLaunchProcessResult>;
  focusTarget(targetId: TerminalTargetId, context?: TerminalFocusContext): Promise<void>;
  closeTarget(targetId: TerminalTargetId): Promise<void>;
  captureTarget?(targetId: TerminalTargetId): Promise<TerminalCapture>;
  sendInput?(targetId: TerminalTargetId, input: string): Promise<void>;
}

/**
 * DRIVEN PORT
 *
 * Authorizes terminal placement through a registered provider capability without
 * exposing physical provider instances.
 *
 * Caller claims are untrusted, and clients cannot supply endpoints or
 * provider-private instance identifiers. Adapters mint short-lived authority
 * from live topology; source-free placement relies on Observer composition and
 * fresh adapter validation. Placement is validated before worktree mutation and
 * revalidated immediately before terminal mutation, with no inferred-target
 * fallback. Finalization is the commit point: an uncertain acknowledgement
 * retains session state and forbids rollback for the same launch attempt.
 */
export interface TerminalPlacementPort {
  id: ProviderId;
  supportedIntents: readonly TerminalPlacementIntent[];
  resolveCurrentPlacement?(
    caller: TerminalCallerContextRequest,
  ): Promise<TerminalPlacementSource | undefined>;
  validatePlacement(placement: TerminalPlacementRequest): Promise<void>;
  openPlacedWorkspace(request: OpenPlacedWorkspaceRequest): Promise<OpenPlacedWorkspaceResult>;
  finalizePlacedTarget(request: ReleasePlacedTerminalTargetRequest): Promise<void>;
  releasePlacedTarget(
    request: ReleasePlacedTerminalTargetRequest,
  ): Promise<{ status: "released" | "already-absent" }>;
}

export type ManagedTerminalLaunchProcessResult =
  | (Omit<TerminalLaunchProcessResult, "started" | "attachment"> & {
      started: false;
      attachment?: never;
      /** Compatibility the caller must apply when it owns the fallback process. */
      outputCompatibility?: TerminalOutputCompatibility;
    })
  | (Omit<TerminalLaunchProcessResult, "started" | "attachment"> & {
      started: true;
      attachment: ManagedTerminalAttachment;
      outputCompatibility?: never;
    });

export type ManagedOpenWorkspaceResult = OpenWorkspaceResult & {
  /** Opaque authority for committing or rolling back this exact opened binding. */
  bindingToken: string;
};

export type ManagedTerminalLaunchProcessRequest = TerminalLaunchProcessRequest & {
  bindingToken: string;
};

export type ReleaseManagedTerminalTargetRequest = {
  targetId: TerminalTargetId;
  expectedSessionId: SessionId;
  /** When present, release only the exact openWorkspace generation. */
  expectedBindingToken?: string | undefined;
};

/**
 * DRIVEN PORT
 *
 * Owns the single managed terminal target used for an external Station launch.
 * Its capabilities state whether process ownership survives the launching client;
 * attachments expose only adapter-owned target identity, and at most one target
 * may exist per worktree. A local fallback may instead carry a provider-neutral
 * output policy for the caller-owned process. `openManagedWorkspace` returns opaque
 * binding authority so launch and cleanup cannot mutate a superseding same-session attempt.
 * Release never terminates a process: `false` proves the qualified binding was
 * absent or superseded, while rejection leaves release uncertain. Target observations may report
 * a currently issuable attachment as true, a definitive absence as false, or omit unknown and
 * inapplicable evidence; activation must still resolve the opaque attachment afresh.
 */
export interface ManagedTerminalLifecycle extends TerminalProvider {
  /** Opens a provisional binding whose token qualifies its launch and rollback. */
  openManagedWorkspace(request: OpenWorkspaceRequest): Promise<ManagedOpenWorkspaceResult>;
  launchManagedProcess(
    request: ManagedTerminalLaunchProcessRequest,
  ): Promise<ManagedTerminalLaunchProcessResult>;
  attachmentForTarget(targetId: TerminalTargetId): Promise<ManagedTerminalAttachment | undefined>;
  releaseTarget(request: ReleaseManagedTerminalTargetRequest): Promise<boolean>;
}

/** Best-effort version probe result; omit fields (or the method) when unknown. */
export type HarnessVersionInfo = {
  installedVersion?: string;
  latestVersion?: string;
};

/**
 * DRIVEN PORT
 *
 * Supplies harness launch, discovery with present-tense status, and persisted-event compatibility policy
 * without exposing provider-native payloads to Observer application code.
 */
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
  /**
   * Read-only, provider-neutral hook evidence. Provider paths, native diagnostics,
   * and payload parsing must remain inside the integration.
   */
  hookHealth?(context?: ProviderDoctorContext): Promise<ProviderHookHealth>;
  /**
   * Reconcile through the provider-owned writer without takeover authority.
   * A successful mutation includes post-write doctor verification.
   */
  reconcileHooks?(
    context?: ProviderHookReconciliationContext,
  ): Promise<ProviderHookReconciliationResult>;
  buildLaunch(request: BuildHarnessLaunchRequest): Promise<HarnessLaunchPlan>;
  discoverRuns(context: HarnessDiscoveryContext): Promise<HarnessRunObservation[]>;
  /**
   * Pure compatibility policy for durable event observations written by earlier builds.
   * Omit when every previously accepted observation remains valid.
   */
  acceptsPersistedEvent?(observation: HarnessEventObservation): boolean;
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
