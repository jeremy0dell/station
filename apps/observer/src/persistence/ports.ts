import type {
  CommandId,
  ErrorEnvelope,
  ObserverHealth,
  ProviderId,
  SafeError,
  SessionGroupId,
  SessionGroupView,
  SessionId,
  SessionRecoveryHandle,
  StationCommand,
  StationCommandResult,
  StationEvent,
} from "@station/contracts";
import type {
  EventAndObservationIngressDedupeResult,
  EventIngressDedupeResult,
  EventRecordOptions,
  HarnessExecutionIngress,
  IngressDedupeKey,
  ListSessionRecoveryHandlesOptions,
  ObserverRecoveryInventoryPersistenceSnapshot,
  PersistedCommand,
  PersistedCommandError,
  PersistedEvent,
  PersistedProviderObservation,
  PersistedSession,
  PersistedSessionHarnessExecution,
  PersistedSessionTurnReadiness,
  PersistedWorktreeDisplayTitle,
  PersistedWorktreeMetadataCurrent,
  PersistReconcileResultInput,
  ProviderObservationKind,
  ProviderObservationsIngressDedupeResult,
  RecordProviderObservationInput,
  SessionGroupMemberExpectation,
  SessionGroupRepairInput,
  SessionGroupRepairResult,
  SessionGroupStoreResult,
  SessionHarnessDerivedStateRepair,
  SessionSeedGroupPlacement,
  SessionSeedGroupProvenance,
  SessionSeedResult,
  SessionTurnReadinessMutation,
  WorktreeMetadataCurrentKind,
  WorktreeMetadataCurrentPayloadByKind,
} from "./types.js";

/**
 * DRIVEN PORT
 *
 * Preserves durable Observer command lifecycle, diagnostic history, and typed
 * success results before terminal completion is observable.
 */
export interface CommandJournal {
  recordCommandAccepted(input: {
    commandId: CommandId;
    command: StationCommand;
    createdAt?: string;
    traceId?: string;
    spanId?: string;
  }): Promise<PersistedCommand>;
  markCommandStarted(commandId: CommandId, startedAt?: string): Promise<PersistedCommand>;
  markCommandSucceeded(
    commandId: CommandId,
    finishedAt?: string,
    result?: StationCommandResult,
  ): Promise<PersistedCommand>;
  markCommandFailed(input: {
    commandId: CommandId;
    safeError: SafeError;
    envelope: ErrorEnvelope;
    finishedAt?: string;
  }): Promise<PersistedCommand>;
  getCommand(commandId: CommandId): Promise<PersistedCommand | undefined>;
  listCommands(): Promise<PersistedCommand[]>;
  listCommandErrors(commandId?: CommandId): Promise<PersistedCommandError[]>;
}

/**
 * DRIVEN PORT
 *
 * Records and retrieves Observer event history for queries and diagnostics.
 */
export interface EventJournal {
  recordEvent(event: StationEvent, options?: EventRecordOptions): Promise<PersistedEvent>;
  listEvents(filter?: {
    commandId?: CommandId;
    type?: StationEvent["type"];
  }): Promise<PersistedEvent[]>;
}

/**
 * DRIVEN PORT
 *
 * Atomically records ingress acceptance, observations, native execution binding, recovery, and readiness under dedupe keys.
 */
export interface IngressJournal {
  recordEventWithIngressDedupe(
    event: StationEvent,
    options: EventRecordOptions & {
      dedupe: IngressDedupeKey;
    },
  ): Promise<EventIngressDedupeResult>;
  recordEventAndProviderObservationWithIngressDedupe(input: {
    event: StationEvent;
    eventOptions: EventRecordOptions;
    observation: RecordProviderObservationInput;
    harnessExecution?: HarnessExecutionIngress;
    dedupe: IngressDedupeKey;
  }): Promise<EventAndObservationIngressDedupeResult>;
  recordProviderObservationsWithIngressDedupe(input: {
    observations: RecordProviderObservationInput[];
    harnessExecutions?: HarnessExecutionIngress[];
    turnReadiness?: SessionTurnReadinessMutation[];
    dedupe: IngressDedupeKey;
    createdAt?: string;
  }): Promise<ProviderObservationsIngressDedupeResult>;
}

/**
 * DRIVEN PORT
 *
 * Retains typed provider observations with their lookup and expiry semantics.
 */
export interface ObservationStore {
  recordProviderObservation(
    input: RecordProviderObservationInput,
  ): Promise<PersistedProviderObservation>;
  listProviderObservations(options?: {
    entityKind?: ProviderObservationKind | readonly ProviderObservationKind[];
    includeExpired?: boolean;
    latestOnly?: boolean;
    now?: string;
  }): Promise<PersistedProviderObservation[]>;
  pruneExpiredProviderObservations(now?: string): Promise<number>;
}

/**
 * DRIVEN PORT
 *
 * Persists reconcile-owned provider evidence and insert-initializes missing canonical worktree
 * titles from one reconcile result as an atomic capability.
 */
export interface ReconcileStore {
  persistReconcileResult(input: PersistReconcileResultInput): Promise<void>;
}

/**
 * DRIVEN PORT
 *
 * Admits Observer-owned sessions with selected provider identity and maintains their lifecycle,
 * native execution bindings, canonical worktree-scoped titles, recovery, and readiness. Seed,
 * explicit root Group placement or current source-Group inheritance, and provenance-safe discard
 * are one atomic conversation; canonical-title handoff and recovery import also commit before
 * recovery reconciles. Exact session lookup lets serialized launch projection consume current
 * durable lifecycle and title authority without scanning unrelated sessions. Recovery inventory
 * reads sessions and handles from one snapshot without classifying eligibility, so one result never
 * combines different persistence lifetimes. Digest-guarded repair composes this session lifecycle
 * with `RecoveryRepairStore`, which owns coherent snapshots and exact-handle pruning after the
 * command boundary verifies its private repair proof.
 * Provider-native recovery keys permanently bind project and worktree, may fill Station session
 * identity once, and reject contradictory identity before mutable evidence can refresh.
 */
export interface SessionStore {
  readRecoveryInventory(): Promise<ObserverRecoveryInventoryPersistenceSnapshot>;
  getSession(sessionId: SessionId): Promise<PersistedSession | undefined>;
  listSessions(): Promise<PersistedSession[]>;
  listWorktreeDisplayTitles(): Promise<PersistedWorktreeDisplayTitle[]>;
  getSessionHarnessExecution(input: {
    provider: ProviderId;
    sessionId: string;
  }): Promise<PersistedSessionHarnessExecution | undefined>;
  listSessionHarnessExecutions(): Promise<PersistedSessionHarnessExecution[]>;
  /** Clears superseded provider-native identity after explicit user consent to start fresh. */
  resetSessionForFreshStart(input: {
    provider: ProviderId;
    sessionId: string;
  }): Promise<{ changed: boolean }>;
  /** Idempotently replaces binding and readiness derived from superseded persisted events. */
  repairSessionHarnessDerivedState(
    input: SessionHarnessDerivedStateRepair,
  ): Promise<{ changed: boolean }>;
  findRememberedHarnessProviderForWorktree(input: {
    projectId: string;
    worktreeId: string;
    worktreePath: string;
  }): Promise<ProviderId | undefined>;
  seedSession(input: {
    sessionId: string;
    projectId: string;
    worktreeId: string;
    initialTitle: string;
    harness: ProviderId;
    terminalProvider: ProviderId;
    createdAt: string;
    lastSeenAt: string;
    group?: SessionSeedGroupPlacement;
  }): Promise<SessionSeedResult>;
  /** Discards only the placement described by the seed result; any Group drift aborts atomically. */
  discardSessionSeed(input: {
    sessionId: string;
    groupProvenance?: SessionSeedGroupProvenance;
    discardedAt?: string;
    removedWorktree?: { projectId: string; worktreeId: string };
  }): Promise<{ discardedSessions: number; discardedWorktreeTitles: number }>;
  markSessionsEnded(input: {
    subject:
      | { kind: "session"; sessionId: string }
      | { kind: "worktree"; projectId: string; worktreeId: string };
    endedAt: string;
  }): Promise<number>;
  reopenSession(sessionId: string): Promise<PersistedSession | undefined>;
  renameSession(input: {
    sessionId: string;
    title: string;
    renamedAt: string;
  }): Promise<PersistedSession | undefined>;
  retireRemovedWorktreeSessionState(input: {
    projectId: string;
    worktreeId: string;
    endedAt: string;
  }): Promise<{ endedSessions: number; deletedWorktreeTitles: number }>;
  importSessionRecoveryHandle(input: {
    handle: SessionRecoveryHandle;
    title?: string;
    importedAt: string;
  }): Promise<SessionRecoveryHandle>;
  upsertSessionRecoveryHandle(input: SessionRecoveryHandle): Promise<SessionRecoveryHandle>;
  getSessionRecoveryHandle(handleId: string): Promise<SessionRecoveryHandle | undefined>;
  listSessionRecoveryHandles(
    options?: ListSessionRecoveryHandlesOptions,
  ): Promise<SessionRecoveryHandle[]>;
  upsertSessionTurnReadiness(input: {
    sessionId: string;
    projectId: string;
    worktreeId: string;
    token: string;
    completedAt: string;
    createdAt?: string;
    updatedAt?: string;
  }): Promise<PersistedSessionTurnReadiness>;
  listSessionTurnReadiness(): Promise<PersistedSessionTurnReadiness[]>;
  deleteSessionTurnReadiness(input: { sessionId: string; token?: string }): Promise<number>;
}

/**
 * DRIVEN PORT
 *
 * Reads and mutates recovery handles against one coherent private snapshot and its public digest.
 */
export interface RecoveryRepairStore {
  readRecoveryRepairSnapshot(): Promise<{
    snapshot: ObserverRecoveryInventoryPersistenceSnapshot;
    recoveryInventoryDigest: string;
  }>;
  pruneSessionRecoveryHandle(input: {
    recoveryHandleId: string;
    expectedRecoveryInventoryDigest: string;
    expected: {
      projectId: string;
      worktreeId: string;
      sessionId: string;
      provider: string;
    };
  }): Promise<{ deleted: boolean; recoveryInventoryDigest: string }>;
}

/**
 * DRIVEN PORT
 *
 * Maintains recorded project-local Group mutation and atomic reconcile repair of definitions,
 * exclusive membership, and parentage. Reconcile must name the projects whose complete provider
 * evidence authorizes absent-member pruning; identity and parent corruption repair remains
 * unconditional. Fresh-session placement is owned by SessionStore.
 */
export interface SessionGroupStore {
  listSessionGroups(): Promise<SessionGroupView[]>;
  createSessionGroup(input: {
    id: SessionGroupId;
    projectId: string;
    name: string;
    initialMembers?: SessionGroupMemberExpectation[];
    parentGroupId?: SessionGroupId;
    createdAt?: string;
  }): Promise<SessionGroupStoreResult>;
  renameSessionGroup(input: {
    id: SessionGroupId;
    expectedVersion: number;
    name: string;
    updatedAt?: string;
  }): Promise<SessionGroupStoreResult>;
  updateSessionGroupMembership(input: {
    id: SessionGroupId;
    expectedVersion: number;
    add?: SessionGroupMemberExpectation[];
    remove?: SessionGroupMemberExpectation[];
    updatedAt?: string;
  }): Promise<SessionGroupStoreResult>;
  reparentSessionGroup(input: {
    id: SessionGroupId;
    expectedVersion: number;
    parentGroupId?: SessionGroupId;
    updatedAt?: string;
  }): Promise<SessionGroupStoreResult>;
  deleteSessionGroup(input: {
    id: SessionGroupId;
    expectedVersion: number;
    updatedAt?: string;
  }): Promise<SessionGroupStoreResult>;
  repairSessionGroups(input: SessionGroupRepairInput): Promise<SessionGroupRepairResult>;
}

/**
 * DRIVEN PORT
 *
 * Maintains the current worktree metadata cache independently of repository adapters.
 */
export interface WorktreeMetadataStore {
  upsertWorktreeMetadataCurrent<TKind extends WorktreeMetadataCurrentKind>(input: {
    worktreeId: string;
    kind: TKind;
    payload: WorktreeMetadataCurrentPayloadByKind[TKind];
    cacheKey?: string;
    updatedAt?: string;
    expiresAt?: string | undefined;
    stale?: boolean;
    lastError?: SafeError;
  }): Promise<PersistedWorktreeMetadataCurrent<TKind>>;
  listWorktreeMetadataCurrent<TKind extends WorktreeMetadataCurrentKind>(options?: {
    kind?: TKind | readonly TKind[];
    includeExpired?: boolean;
    now?: string;
  }): Promise<PersistedWorktreeMetadataCurrent<TKind>[]>;
  deleteWorktreeMetadataCurrent(input: {
    worktreeId: string;
    kind?: WorktreeMetadataCurrentKind;
  }): Promise<number>;
}

export type ObserverPersistenceBundle = CommandJournal &
  EventJournal &
  IngressJournal &
  ObservationStore &
  ReconcileStore &
  SessionStore &
  RecoveryRepairStore &
  SessionGroupStore &
  WorktreeMetadataStore;

/**
 * DRIVEN PORT
 *
 * Reports durable persistence health to Observer runtime and diagnostics without exposing adapter handles.
 */
export interface PersistenceHealthSource {
  health(): NonNullable<ObserverHealth["sqlite"]>;
}
