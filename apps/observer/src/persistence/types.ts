import type {
  AgentState,
  CommandId,
  Confidence,
  DiagnosticDetail,
  ErrorEnvelope,
  HarnessRunObservation,
  ProviderHealth,
  ProviderId,
  ProviderProjectConfig,
  SafeError,
  StationCommand,
  StationEvent,
  TerminalState,
  TerminalTargetObservation,
  WorktreeChangeSummary,
  WorktreeChecksSummary,
  WorktreeObservation,
  WorktreePullRequest,
  WorktreeSource,
  WorktreeState,
} from "@station/contracts";

export type PersistedCommandStatus = "accepted" | "started" | "succeeded" | "failed";

export type ObserverIdFactory = {
  commandId(): string;
  eventId(): string;
  errorId(): string;
  observationId(): string;
  breadcrumbId(): string;
};

export type PersistedCommand = {
  id: CommandId;
  type: StationCommand["type"];
  command: StationCommand;
  status: PersistedCommandStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  traceId?: string;
  spanId?: string;
  error?: SafeError;
  diagnostics?: DiagnosticDetail[];
};

export type PersistedEvent = {
  id: string;
  type: StationEvent["type"];
  source: string;
  event: StationEvent;
  createdAt: string;
  commandId?: CommandId;
  traceId?: string;
  spanId?: string;
};

export type IngressDedupeKind = "hook" | "harness_report";

export type IngressDedupeKey = {
  kind: IngressDedupeKind;
  id: string;
};

export type PersistedCommandError = {
  id: string;
  commandId: CommandId;
  envelope: ErrorEnvelope;
  createdAt: string;
};

export type ProviderObservationKind =
  | "worktree"
  | "terminal_target"
  | "harness_run"
  | "harness_event"
  | "provider_health";
export type CurrentProviderObservationKind = Extract<
  ProviderObservationKind,
  "worktree" | "terminal_target"
>;

export type ProviderObservationType = "worktree" | "terminal" | "harness" | "observer";

export type WorktreeMetadataCurrentKind = "change_summary" | "pull_request" | "checks";

export type WorktreeMetadataCurrentPayloadByKind = {
  change_summary: WorktreeChangeSummary;
  pull_request: WorktreePullRequest;
  checks: WorktreeChecksSummary;
};

export type WorktreeMetadataCurrentPayload =
  WorktreeMetadataCurrentPayloadByKind[WorktreeMetadataCurrentKind];

export type PersistedProviderObservation = {
  id: string;
  provider: ProviderId;
  providerType: ProviderObservationType;
  entityKind: ProviderObservationKind;
  entityKey: string;
  payload: unknown;
  observedAt: string;
  expiresAt?: string | undefined;
  expired: boolean;
};

export type RecordProviderObservationInput = {
  provider: ProviderId;
  providerType: ProviderObservationType;
  entityKind: ProviderObservationKind;
  entityKey: string;
  payload: unknown;
  observedAt?: string;
  expiresAt?: string | undefined;
};

export type EventRecordOptions = {
  source?: string;
  commandId?: CommandId;
  traceId?: string;
  spanId?: string;
  createdAt?: string;
};

export type EventIngressDedupeResult = {
  deduped: boolean;
  event?: PersistedEvent;
};

export type EventAndObservationIngressDedupeResult = EventIngressDedupeResult & {
  observation?: PersistedProviderObservation;
};

export type PersistedWorktreeMetadataCurrent<
  TKind extends WorktreeMetadataCurrentKind = WorktreeMetadataCurrentKind,
> = {
  worktreeId: string;
  kind: TKind;
  payload: WorktreeMetadataCurrentPayloadByKind[TKind];
  updatedAt: string;
  expired: boolean;
  stale: boolean;
  cacheKey?: string;
  expiresAt?: string;
  lastError?: SafeError;
};

export type PersistedProject = {
  id: string;
  label: string;
  root: string;
  repo?: string;
  lastSeenAt: string;
};

export type PersistedWorktree = {
  id: string;
  projectId: string;
  path: string;
  branch?: string;
  source?: WorktreeSource;
  state?: WorktreeState;
  dirty?: boolean;
  provider?: string;
  providerData?: unknown;
  lastSeenAt: string;
};

export type PersistedTerminalTarget = {
  id: string;
  sessionId?: string;
  projectId?: string;
  worktreeId?: string;
  provider: string;
  state?: TerminalState;
  providerKey?: string;
  providerData?: unknown;
  lastSeenAt: string;
};

export type PersistedHarnessRun = {
  id: string;
  sessionId?: string;
  projectId?: string;
  worktreeId?: string;
  harness: string;
  pid?: number;
  externalRunId?: string;
  state?: AgentState;
  confidence?: Confidence;
  reason?: string;
  providerData?: unknown;
  lastEventAt?: string;
  lastSeenAt: string;
};

export type PersistedSession = {
  id: string;
  projectId: string;
  worktreeId: string;
  title?: string;
  harness?: string;
  terminalProvider?: string;
  state?: string;
  createdAt: string;
  endedAt?: string;
  lastSeenAt: string;
};

export type PersistedRecoveryBreadcrumb = {
  id: string;
  projectId: string;
  worktreeId?: string;
  sessionId?: string;
  location: string;
  path: string;
  payload: unknown;
  createdAt: string;
  lastSeenAt: string;
};

export type PersistedSessionTurnReadiness = {
  sessionId: string;
  projectId: string;
  worktreeId: string;
  token: string;
  completedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type ListSessionRecoveryHandlesOptions = {
  projectId?: string;
  worktreeId?: string;
  provider?: string;
};

export type PersistReconcileResultInput = {
  projects: ProviderProjectConfig[];
  worktrees: WorktreeObservation[];
  terminalTargets: TerminalTargetObservation[];
  harnessRuns: HarnessRunObservation[];
  providerHealth?: Record<string, ProviderHealth>;
  observedAt?: string;
  expiresAt?: string | undefined;
  providerObservationRetentionDays?: number | undefined;
};
