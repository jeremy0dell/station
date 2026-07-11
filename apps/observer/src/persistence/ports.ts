import type {
  CommandId,
  ErrorEnvelope,
  ObserverHealth,
  ProviderId,
  SafeError,
  SessionRecoveryHandle,
  StationCommand,
  StationEvent,
} from "@station/contracts";
import type {
  CurrentProviderObservationKind,
  EventAndObservationIngressDedupeResult,
  EventIngressDedupeResult,
  EventRecordOptions,
  IngressDedupeKey,
  ListSessionRecoveryHandlesOptions,
  PersistedCommand,
  PersistedCommandError,
  PersistedEvent,
  PersistedProviderObservation,
  PersistedSession,
  PersistedSessionTurnReadiness,
  PersistedWorktreeMetadataCurrent,
  PersistReconcileResultInput,
  ProviderObservationKind,
  RecordProviderObservationInput,
  WorktreeMetadataCurrentKind,
  WorktreeMetadataCurrentPayloadByKind,
} from "./types.js";

/**
 * DRIVEN PORT
 *
 * Preserves the durable lifecycle and diagnostic history of Observer commands.
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
  markCommandSucceeded(commandId: CommandId, finishedAt?: string): Promise<PersistedCommand>;
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
 * Atomically deduplicates accepted ingress with its durable event and observation evidence.
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
    dedupe: IngressDedupeKey;
  }): Promise<EventAndObservationIngressDedupeResult>;
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
  listCurrentProviderEntityObservations(options?: {
    entityKind?: CurrentProviderObservationKind | readonly CurrentProviderObservationKind[];
    includeExpired?: boolean;
    now?: string;
  }): Promise<PersistedProviderObservation[]>;
  pruneExpiredProviderObservations(now?: string): Promise<number>;
}

/**
 * DRIVEN PORT
 *
 * Persists the Observer's correlated reconcile projection as one atomic capability.
 */
export interface ReconcileStore {
  persistReconcileResult(input: PersistReconcileResultInput): Promise<void>;
}

/**
 * DRIVEN PORT
 *
 * Maintains Observer-owned sessions, titles, remembered harness selection, recovery handles, and turn readiness.
 */
export interface SessionStore {
  listSessions(): Promise<PersistedSession[]>;
  findRememberedHarnessProviderForWorktree(input: {
    projectId: string;
    worktreeId: string;
    worktreePath: string;
  }): Promise<ProviderId | undefined>;
  seedSessionTitle(input: {
    sessionId: string;
    projectId: string;
    worktreeId: string;
    title: string;
    createdAt: string;
    lastSeenAt: string;
  }): Promise<PersistedSession>;
  deleteSessionTitleSeed(sessionId: string): Promise<number>;
  renameSession(input: { sessionId: string; title: string }): Promise<PersistedSession | undefined>;
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
  WorktreeMetadataStore;

/**
 * DRIVEN PORT
 *
 * Reports durable persistence health to Observer runtime and diagnostics without exposing adapter handles.
 */
export interface PersistenceHealthSource {
  health(): NonNullable<ObserverHealth["sqlite"]>;
}
