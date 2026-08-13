import type {
  AgentState,
  CommandId,
  DiagnosticDetail,
  ErrorEnvelope,
  HarnessEventObservation,
  HarnessRunObservation,
  ObservedStatus,
  ProviderHealth,
  ProviderId,
  SafeError,
  SessionGroupId,
  SessionGroupView,
  SessionId,
  SessionRecoveryHandle,
  StationCommand,
  StationEvent,
  TerminalTargetObservation,
  WorktreeChangeSummary,
  WorktreeChecksSummary,
  WorktreeObservation,
  WorktreePullRequest,
} from "@station/contracts";

export type SessionGroupMemberExpectation = {
  sessionId: SessionId;
  projectId: string;
  expectedGroupId: SessionGroupId | null;
};

export type SessionGroupStoreConflictReason =
  | "already_exists"
  | "not_found"
  | "stale_version"
  | "unexpected_assignment";

export type SessionGroupStoreResult =
  | { ok: true; groups: SessionGroupView[] }
  | { ok: false; reason: SessionGroupStoreConflictReason };

export type SessionGroupRepairEvidence =
  | {
      reason: "invalid_membership";
      groupId: SessionGroupId;
      projectId: string;
    }
  | {
      reason: "missing_parent" | "cross_project_parent" | "parent_cycle";
      groupId: SessionGroupId;
      projectId: string;
      parentGroupId: SessionGroupId;
    };

export type SessionGroupRepairResult = {
  groups: SessionGroupView[];
  repairs: SessionGroupRepairEvidence[];
};

export type PersistedCommandStatus = "accepted" | "started" | "succeeded" | "failed";

export type ObserverIdFactory = {
  commandId(): string;
  eventId(): string;
  errorId(): string;
  observationId(): string;
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

export type IngressDedupeKind = "hook" | "hook_processing" | "harness_report";

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

export type ProviderObservationPayloadByKind = {
  worktree: WorktreeObservation;
  terminal_target: TerminalTargetObservation;
  harness_run: HarnessRunObservation;
  harness_event: HarnessEventObservation;
  provider_health: ProviderHealth;
};

export type ProviderObservation = {
  [TKind in keyof ProviderObservationPayloadByKind]: {
    entityKind: TKind;
    payload: ProviderObservationPayloadByKind[TKind];
  };
}[keyof ProviderObservationPayloadByKind];

export type ProviderObservationKind = ProviderObservation["entityKind"];
export type ProviderObservationType = "worktree" | "terminal" | "harness" | "observer";

export type WorktreeMetadataCurrentKind = "change_summary" | "pull_request" | "checks";

export type WorktreeMetadataCurrentPayloadByKind = {
  change_summary: WorktreeChangeSummary;
  pull_request: WorktreePullRequest;
  checks: WorktreeChecksSummary;
};

type PersistedProviderObservationFields = {
  id: string;
  provider: ProviderId;
  providerType: ProviderObservationType;
  entityKey: string;
  observedAt: string;
  expiresAt?: string | undefined;
  expired: boolean;
};

export type PersistedProviderObservation = PersistedProviderObservationFields & ProviderObservation;

type RecordProviderObservationFields = {
  provider: ProviderId;
  providerType: ProviderObservationType;
  entityKey: string;
  observedAt?: string;
  expiresAt?: string | undefined;
  /** Refresh the latest row when only top-level observation timestamps or latency changed. */
  coalesceUnchanged?: boolean;
};

export type RecordProviderObservationInput = RecordProviderObservationFields & ProviderObservation;

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

export type ProviderObservationsIngressDedupeResult = {
  deduped: boolean;
  observations?: PersistedProviderObservation[];
};

export type SessionTurnReadinessMutation =
  | {
      action: "upsert";
      value: {
        sessionId: string;
        projectId: string;
        worktreeId: string;
        token: string;
        completedAt: string;
        updatedAt: string;
      };
    }
  | {
      action: "delete";
      sessionId: string;
    };

export type SessionHarnessExecutionEvidence = {
  provider: ProviderId;
  sessionId?: string;
  nativeSessionId?: string;
  status?: ObservedStatus;
};

export type PersistedSessionHarnessExecution = {
  provider: ProviderId;
  sessionId: string;
  nativeSessionId: string;
  state: AgentState;
  statusUpdatedAt: string;
};

export type HarnessExecutionIngress = {
  evidence: SessionHarnessExecutionEvidence;
  recoveryHandle?: SessionRecoveryHandle;
  turnReadiness?: SessionTurnReadinessMutation;
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

export type PersistedSessionLifecycle = "legacy" | "open" | "ended";

export type PersistedWorktreeDisplayTitle = {
  projectId: string;
  worktreeId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type PersistedSession = {
  id: string;
  projectId: string;
  worktreeId: string;
  lifecycle: PersistedSessionLifecycle;
  title?: string;
  harness?: string;
  terminalProvider?: string;
  state?: string;
  createdAt: string;
  endedAt?: string;
  lastSeenAt: string;
};

export type SessionSeedGroupPlacement =
  | { kind: "existing"; groupId: SessionGroupId }
  | { kind: "create"; groupId: SessionGroupId; name: string };

/** Exact Group state established by a session seed and required for provenance-safe discard. */
export type SessionSeedGroupProvenance =
  | { kind: "existing"; groupId: SessionGroupId }
  | {
      kind: "created";
      groupId: SessionGroupId;
      projectId: string;
      name: string;
      version: number;
      createdAt: string;
      updatedAt: string;
    };

export type SessionSeedResult =
  | { ok: true; session: PersistedSession; groupProvenance?: SessionSeedGroupProvenance }
  | {
      ok: false;
      reason:
        | "group_not_found"
        | "group_project_mismatch"
        | "group_not_root"
        | "group_id_collision"
        | "unexpected_assignment";
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

export type SessionHarnessDerivedStateRepair = {
  provider: ProviderId;
  sessionId: string;
  harnessExecution?: PersistedSessionHarnessExecution;
  turnReadiness?: PersistedSessionTurnReadiness;
};

export type ListSessionRecoveryHandlesOptions = {
  projectId?: string;
  worktreeId?: string;
  provider?: string;
};

export type PersistReconcileResultInput = {
  worktrees: WorktreeObservation[];
  terminalTargets: TerminalTargetObservation[];
  harnessRuns: HarnessRunObservation[];
  worktreeDisplayTitles?: PersistedWorktreeDisplayTitle[];
  providerHealth?: Record<string, ProviderHealth>;
  observedAt?: string;
  expiresAt?: string | undefined;
  providerObservationRetentionDays?: number | undefined;
};
