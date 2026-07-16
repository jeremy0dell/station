import { createHash } from "node:crypto";
import type {
  CommandId,
  DiagnosticDetail,
  HarnessRunObservation,
  ProviderId,
  SessionRecoveryHandle,
  StationEvent,
  TerminalTargetObservation,
  WorktreeObservation,
} from "@station/contracts";
import {
  ErrorEnvelopeSchema,
  HarnessRunObservationSchema,
  SafeErrorSchema,
  SessionRecoveryHandleSchema,
  StationCommandSchema,
  StationEventSchema,
  sameObservedPath,
  stationEventCommandId,
  stationEventTimestamp,
  TerminalTargetObservationSchema,
  WorktreeChangeSummarySchema,
  WorktreeChecksSummarySchema,
  WorktreeObservationSchema,
  WorktreePullRequestSchema,
} from "@station/contracts";
import {
  Effect,
  type RuntimeClock,
  safeErrorFromUnknown,
  systemClock,
  toIsoTimestamp,
} from "@station/runtime";
import { decideSessionHarnessExecution } from "../../src/harnessExecutionIdentity.js";
import { defaultIdFactory } from "../../src/persistence/idFactory.js";
import { parseJson, stringifyJson } from "../../src/persistence/json.js";
import {
  parseProviderObservation,
  stableProviderObservationPayloadKey,
} from "../../src/persistence/observationParser.js";
import type { ObserverPersistenceBundle } from "../../src/persistence/ports.js";
import {
  providerObservationExpiresAt,
  providerObservationRetentionDays,
} from "../../src/persistence/retention.js";
import {
  sessionHarnessExecutionEqual,
  sessionTurnReadinessEqual,
  turnReadinessWasAcknowledged,
} from "../../src/persistence/sessionHarnessDerivedState.js";
import { stripTerminalProviderData } from "../../src/persistence/terminalObservations.js";
import type {
  CurrentProviderObservationKind,
  EventRecordOptions,
  HarnessExecutionIngress,
  IngressDedupeKey,
  ListSessionRecoveryHandlesOptions,
  ObserverIdFactory,
  PersistedCommand,
  PersistedCommandError,
  PersistedEvent,
  PersistedProviderObservation,
  PersistedSession,
  PersistedSessionHarnessExecution,
  PersistedSessionTurnReadiness,
  PersistedWorktreeMetadataCurrent,
  PersistReconcileResultInput,
  ProviderObservationKind,
  ProviderObservationType,
  RecordProviderObservationInput,
  SessionHarnessExecutionEvidence,
  SessionTurnReadinessMutation,
  WorktreeMetadataCurrentKind,
  WorktreeMetadataCurrentPayloadByKind,
} from "../../src/persistence/types.js";
import {
  harnessRunCanActivateSession,
  terminalCanActivateSession,
} from "../../src/sessionActivation.js";

type CreateInMemoryObserverPersistenceOptions = {
  clock?: RuntimeClock;
  idFactory?: Partial<ObserverIdFactory>;
};

type ProjectState = {
  id: string;
  label: string;
  root: string;
  lastSeenAt: string;
};

type InMemoryObserverPersistenceState = {
  commands: Map<string, PersistedCommand>;
  commandErrors: Map<string, PersistedCommandError>;
  events: Map<string, PersistedEvent>;
  ingressDedupe: Set<string>;
  observations: Map<string, PersistedProviderObservation>;
  projects: Map<string, ProjectState>;
  worktrees: Map<string, WorktreeObservation>;
  terminalTargets: Map<string, TerminalTargetObservation>;
  harnessRuns: Map<string, HarnessRunObservation>;
  sessions: Map<string, PersistedSession>;
  sessionHarnessExecutions: Map<string, PersistedSessionHarnessExecution>;
  recoveryHandles: Map<string, SessionRecoveryHandle>;
  turnReadiness: Map<string, PersistedSessionTurnReadiness>;
  worktreeMetadata: Map<string, PersistedWorktreeMetadataCurrent>;
};

type InsertProviderObservationInput = RecordProviderObservationInput & {
  id: string;
  observedAt: string;
  coalesceUnchanged?: boolean;
};

export function createInMemoryObserverPersistence(
  options: CreateInMemoryObserverPersistenceOptions = {},
): ObserverPersistenceBundle {
  const clock = options.clock ?? systemClock;
  const idFactory = { ...defaultIdFactory, ...options.idFactory };
  const now = () => toIsoTimestamp(clock.now());
  let state = emptyState();

  const transaction = <T>(task: (draft: InMemoryObserverPersistenceState) => T): Promise<T> =>
    Effect.runPromise(
      Effect.try({
        try: () => {
          // Commit only after result detachment succeeds; generated IDs remain outside rollback.
          const draft = structuredClone(state);
          const value = task(draft);
          const detached = structuredClone(value);
          state = draft;
          return detached;
        },
        catch: (error) =>
          safeErrorFromUnknown(error, {
            tag: "PersistenceError",
            code: "PERSISTENCE_TRANSACTION_FAILED",
            message: "Observer in-memory persistence transaction failed.",
          }),
      }),
    );

  return {
    recordCommandAccepted: (input) =>
      transaction((draft) => {
        const command = StationCommandSchema.parse(input.command);
        if (draft.commands.has(input.commandId)) {
          throw new Error(`Command ${input.commandId} already exists.`);
        }
        const persisted: PersistedCommand = {
          id: input.commandId,
          type: command.type,
          command,
          status: "accepted",
          createdAt: input.createdAt ?? now(),
        };
        if (input.traceId !== undefined) persisted.traceId = input.traceId;
        if (input.spanId !== undefined) persisted.spanId = input.spanId;
        draft.commands.set(input.commandId, persisted);
        return commandWithDiagnostics(draft, persisted);
      }),

    markCommandStarted: (commandId, startedAt) =>
      transaction((draft) => {
        const command = requireCommand(draft, commandId);
        command.status = "started";
        command.startedAt = startedAt ?? now();
        return commandWithDiagnostics(draft, command);
      }),

    markCommandSucceeded: (commandId, finishedAt) =>
      transaction((draft) => {
        const command = requireCommand(draft, commandId);
        command.status = "succeeded";
        command.finishedAt = finishedAt ?? now();
        delete command.error;
        return commandWithDiagnostics(draft, command);
      }),

    markCommandFailed: (input) =>
      transaction((draft) => {
        const safeError = SafeErrorSchema.parse(input.safeError);
        const envelope = ErrorEnvelopeSchema.parse(input.envelope);
        const command = requireCommand(draft, input.commandId);
        command.status = "failed";
        command.finishedAt = input.finishedAt ?? now();
        command.error = safeError;
        draft.commandErrors.set(envelope.id, {
          id: envelope.id,
          commandId: input.commandId,
          envelope,
          createdAt: envelope.createdAt,
        });
        return commandWithDiagnostics(draft, command);
      }),

    getCommand: (commandId) =>
      transaction((draft) => {
        const command = draft.commands.get(commandId);
        return command === undefined ? undefined : commandWithDiagnostics(draft, command);
      }),

    listCommands: () =>
      transaction((draft) =>
        [...draft.commands.values()]
          .sort(
            (left, right) =>
              compareAsc(left.createdAt, right.createdAt) || compareAsc(left.id, right.id),
          )
          .map((command) => commandWithDiagnostics(draft, command)),
      ),

    listCommandErrors: (commandId) =>
      transaction((draft) =>
        sortedCommandErrors(draft).filter(
          (error) => commandId === undefined || error.commandId === commandId,
        ),
      ),

    recordEvent: (event, eventOptions = {}) =>
      transaction((draft) => {
        const parsedEvent = StationEventSchema.parse(event);
        const eventId = idFactory.eventId();
        return insertEvent(draft, parsedEvent, eventId, eventOptions, now);
      }),

    recordEventWithIngressDedupe: (event, eventOptions) =>
      transaction((draft) => {
        const parsedEvent = StationEventSchema.parse(event);
        const eventId = idFactory.eventId();
        const createdAt = eventOptions.createdAt ?? stationEventTimestamp(parsedEvent) ?? now();
        if (!claimIngressDedupeKey(draft, eventOptions.dedupe)) {
          return { deduped: true };
        }
        return {
          deduped: false,
          event: insertEvent(draft, parsedEvent, eventId, { ...eventOptions, createdAt }, now),
        };
      }),

    recordEventAndProviderObservationWithIngressDedupe: (input) =>
      transaction((draft) => {
        const parsedEvent = StationEventSchema.parse(input.event);
        const eventId = idFactory.eventId();
        const createdAt =
          input.eventOptions.createdAt ?? stationEventTimestamp(parsedEvent) ?? now();
        if (!claimIngressDedupeKey(draft, input.dedupe)) {
          return { deduped: true };
        }
        const event = insertEvent(
          draft,
          parsedEvent,
          eventId,
          { ...input.eventOptions, createdAt },
          now,
        );
        const observation = insertProviderObservation(draft, {
          ...input.observation,
          id: idFactory.observationId(),
          observedAt: input.observation.observedAt ?? now(),
        });
        const harnessExecution = input.harnessExecution;
        if (harnessExecution !== undefined) {
          applyHarnessExecutionIngress(draft, harnessExecution, now());
        }
        return { deduped: false, event, observation };
      }),

    recordProviderObservationsWithIngressDedupe: (input) =>
      transaction((draft) => {
        if (!claimIngressDedupeKey(draft, input.dedupe)) {
          return { deduped: true };
        }
        const observations = input.observations.map((observation) =>
          insertProviderObservation(draft, {
            ...observation,
            id: idFactory.observationId(),
            observedAt: observation.observedAt ?? now(),
          }),
        );
        for (const harnessExecution of input.harnessExecutions ?? []) {
          applyHarnessExecutionIngress(draft, harnessExecution, now());
        }
        for (const mutation of input.turnReadiness ?? []) {
          applySessionTurnReadinessMutation(draft, mutation, now());
        }
        return { deduped: false, observations };
      }),

    listEvents: (filter = {}) =>
      transaction((draft) =>
        [...draft.events.values()]
          .sort(
            (left, right) =>
              compareAsc(left.createdAt, right.createdAt) || compareAsc(left.id, right.id),
          )
          .filter((event) => filter.commandId === undefined || event.commandId === filter.commandId)
          .filter((event) => filter.type === undefined || event.type === filter.type),
      ),

    recordProviderObservation: (input) =>
      transaction((draft) =>
        insertProviderObservation(draft, {
          ...input,
          id: idFactory.observationId(),
          observedAt: input.observedAt ?? now(),
        }),
      ),

    listProviderObservations: (listOptions = {}) =>
      transaction((draft) =>
        listProviderObservations(draft, {
          ...listOptions,
          referenceTime: listOptions.now ?? now(),
        }),
      ),

    listCurrentProviderEntityObservations: (listOptions = {}) =>
      transaction((draft) =>
        listCurrentProviderEntityObservations(draft, {
          ...listOptions,
          referenceTime: listOptions.now ?? now(),
        }),
      ),

    pruneExpiredProviderObservations: (expiresBefore) =>
      transaction((draft) => {
        let deleted = 0;
        const referenceTime = expiresBefore ?? now();
        for (const [id, observation] of draft.observations) {
          if (observation.expiresAt !== undefined && observation.expiresAt <= referenceTime) {
            draft.observations.delete(id);
            deleted += 1;
          }
        }
        return deleted;
      }),

    persistReconcileResult: (input) =>
      transaction((draft) => {
        const reconcileInput =
          input.expiresAt === undefined && input.providerObservationRetentionDays === undefined
            ? {
                ...input,
                providerObservationRetentionDays: providerObservationRetentionDays(),
              }
            : input;
        persistReconcileResult(draft, reconcileInput, {
          observedAt: input.observedAt ?? now(),
          idFactory,
        });
      }),

    listSessions: () =>
      transaction((draft) =>
        [...draft.sessions.values()].sort((left, right) => compareAsc(left.id, right.id)),
      ),

    getSessionHarnessExecution: (input) =>
      transaction((draft) => draft.sessionHarnessExecutions.get(sessionHarnessExecutionKey(input))),

    listSessionHarnessExecutions: () =>
      transaction((draft) =>
        [...draft.sessionHarnessExecutions.values()].sort(
          (left, right) =>
            compareAsc(left.provider, right.provider) ||
            compareAsc(left.sessionId, right.sessionId),
        ),
      ),

    repairSessionHarnessDerivedState: (input) =>
      transaction((draft) => {
        const key = sessionHarnessExecutionKey(input);
        const currentExecution = draft.sessionHarnessExecutions.get(key);
        const requestedReadiness =
          input.turnReadiness !== undefined &&
          turnReadinessWasAcknowledged([...draft.commands.values()], input.turnReadiness)
            ? undefined
            : input.turnReadiness;
        const currentReadiness = draft.turnReadiness.get(input.sessionId);
        if (
          sessionHarnessExecutionEqual(currentExecution, input.harnessExecution) &&
          sessionTurnReadinessEqual(currentReadiness, requestedReadiness)
        ) {
          return { changed: false };
        }
        draft.sessionHarnessExecutions.delete(key);
        if (input.harnessExecution !== undefined) {
          draft.sessionHarnessExecutions.set(key, input.harnessExecution);
        }
        draft.turnReadiness.delete(input.sessionId);
        if (requestedReadiness !== undefined) {
          draft.turnReadiness.set(input.sessionId, requestedReadiness);
        }
        return { changed: true };
      }),

    findRememberedHarnessProviderForWorktree: (input) =>
      transaction((draft) => findRememberedHarnessProviderForWorktree(draft, input)),

    seedSessionTitle: (input) =>
      transaction((draft) => {
        const existing = draft.sessions.get(input.sessionId);
        if (existing === undefined) {
          const session: PersistedSession = {
            id: input.sessionId,
            projectId: input.projectId,
            worktreeId: input.worktreeId,
            lifecycle: "open",
            title: input.title,
            createdAt: input.createdAt,
            lastSeenAt: input.lastSeenAt,
          };
          draft.sessions.set(input.sessionId, session);
          return session;
        }
        existing.projectId = input.projectId;
        existing.worktreeId = input.worktreeId;
        if (existing.title === undefined) existing.title = input.title;
        existing.lastSeenAt = input.lastSeenAt;
        if (existing.lifecycle !== "ended") existing.lifecycle = "open";
        return existing;
      }),

    deleteSessionTitleSeed: (sessionId) =>
      transaction((draft) => (draft.sessions.delete(sessionId) ? 1 : 0)),

    markSessionsEnded: (input) =>
      transaction((draft) => {
        let changed = 0;
        for (const session of draft.sessions.values()) {
          const matches =
            input.subject.kind === "session"
              ? session.id === input.subject.sessionId
              : session.projectId === input.subject.projectId &&
                session.worktreeId === input.subject.worktreeId;
          if (!matches || session.lifecycle === "ended") continue;
          session.lifecycle = "ended";
          session.endedAt = input.endedAt;
          changed += 1;
        }
        return changed;
      }),

    reopenSession: (sessionId) =>
      transaction((draft) => {
        const session = draft.sessions.get(sessionId);
        if (session === undefined) return undefined;
        session.lifecycle = "open";
        delete session.endedAt;
        return session;
      }),

    renameSession: (input) =>
      transaction((draft) => {
        const session = draft.sessions.get(input.sessionId);
        if (session === undefined) return undefined;
        session.title = input.title;
        return session;
      }),

    upsertSessionRecoveryHandle: (input) =>
      transaction((draft) => upsertSessionRecoveryHandle(draft, input)),

    getSessionRecoveryHandle: (handleId) =>
      transaction((draft) => draft.recoveryHandles.get(handleId)),

    listSessionRecoveryHandles: (listOptions = {}) =>
      transaction((draft) =>
        [...draft.recoveryHandles.values()]
          .sort(
            (left, right) =>
              compareDesc(left.lastSeenAt, right.lastSeenAt) || compareAsc(left.id, right.id),
          )
          .filter((handle) => matchesRecoveryHandleOptions(handle, listOptions)),
      ),

    upsertSessionTurnReadiness: (input) =>
      transaction((draft) =>
        upsertSessionTurnReadiness(draft, {
          ...input,
          createdAt: input.createdAt ?? now(),
        }),
      ),

    listSessionTurnReadiness: () =>
      transaction((draft) =>
        [...draft.turnReadiness.values()].sort(
          (left, right) =>
            compareDesc(left.completedAt, right.completedAt) ||
            compareAsc(left.sessionId, right.sessionId),
        ),
      ),

    deleteSessionTurnReadiness: (input) =>
      transaction((draft) => deleteSessionTurnReadiness(draft, input)),

    upsertWorktreeMetadataCurrent: (input) =>
      transaction((draft) => {
        const updatedAt = input.updatedAt ?? now();
        const payload = validateWorktreeMetadataPayload(input.kind, input.payload);
        const lastError =
          input.lastError === undefined ? undefined : SafeErrorSchema.parse(input.lastError);
        const current: PersistedWorktreeMetadataCurrent<typeof input.kind> = {
          worktreeId: input.worktreeId,
          kind: input.kind,
          payload,
          updatedAt,
          expired:
            input.expiresAt === undefined
              ? false
              : Date.parse(input.expiresAt) <= Date.parse(updatedAt),
          stale: input.stale === true,
        };
        if (input.cacheKey !== undefined) current.cacheKey = input.cacheKey;
        if (input.expiresAt !== undefined) current.expiresAt = input.expiresAt;
        if (lastError !== undefined) current.lastError = lastError;
        draft.worktreeMetadata.set(metadataKey(input.worktreeId, input.kind), current);
        return current;
      }),

    listWorktreeMetadataCurrent: (listOptions = {}) =>
      transaction((draft) =>
        listWorktreeMetadataCurrent(draft, {
          ...listOptions,
          referenceTime: listOptions.now ?? now(),
        }),
      ),

    deleteWorktreeMetadataCurrent: (input) =>
      transaction((draft) => {
        if (input.kind !== undefined) {
          return draft.worktreeMetadata.delete(metadataKey(input.worktreeId, input.kind)) ? 1 : 0;
        }
        let deleted = 0;
        for (const kind of ["change_summary", "pull_request", "checks"] as const) {
          if (draft.worktreeMetadata.delete(metadataKey(input.worktreeId, kind))) deleted += 1;
        }
        return deleted;
      }),
  };
}

function emptyState(): InMemoryObserverPersistenceState {
  return {
    commands: new Map(),
    commandErrors: new Map(),
    events: new Map(),
    ingressDedupe: new Set(),
    observations: new Map(),
    projects: new Map(),
    worktrees: new Map(),
    terminalTargets: new Map(),
    harnessRuns: new Map(),
    sessions: new Map(),
    sessionHarnessExecutions: new Map(),
    recoveryHandles: new Map(),
    turnReadiness: new Map(),
    worktreeMetadata: new Map(),
  };
}

function applySessionHarnessExecutionEvidence(
  state: InMemoryObserverPersistenceState,
  evidence: SessionHarnessExecutionEvidence,
): boolean {
  const key = sessionHarnessExecutionKey(evidence);
  const current =
    evidence.sessionId === undefined ? undefined : state.sessionHarnessExecutions.get(key);
  const decision = decideSessionHarnessExecution({ current, evidence });
  if (decision.binding !== undefined) {
    state.sessionHarnessExecutions.set(key, decision.binding);
  }
  return decision.mayDeriveState;
}

function applyHarnessExecutionIngress(
  state: InMemoryObserverPersistenceState,
  harnessExecution: HarnessExecutionIngress,
  createdAt: string,
): void {
  if (!applySessionHarnessExecutionEvidence(state, harnessExecution.evidence)) return;
  if (harnessExecution.recoveryHandle !== undefined) {
    upsertSessionRecoveryHandle(state, harnessExecution.recoveryHandle);
  }
  if (harnessExecution.turnReadiness !== undefined) {
    applySessionTurnReadinessMutation(state, harnessExecution.turnReadiness, createdAt);
  }
}

function sessionHarnessExecutionKey(input: { provider: string; sessionId?: string }): string {
  return `${input.provider}\u0000${input.sessionId ?? ""}`;
}

function requireCommand(
  state: InMemoryObserverPersistenceState,
  commandId: CommandId,
): PersistedCommand {
  const command = state.commands.get(commandId);
  if (command === undefined) {
    throw new Error(`Command ${commandId} was not found.`);
  }
  return command;
}

function commandWithDiagnostics(
  state: InMemoryObserverPersistenceState,
  command: PersistedCommand,
): PersistedCommand {
  const diagnostics = commandDiagnostics(
    sortedCommandErrors(state).filter((error) => error.commandId === command.id),
  );
  if (diagnostics.length === 0) return command;
  return { ...command, diagnostics };
}

function sortedCommandErrors(state: InMemoryObserverPersistenceState): PersistedCommandError[] {
  return [...state.commandErrors.values()].sort(
    (left, right) => compareAsc(left.createdAt, right.createdAt) || compareAsc(left.id, right.id),
  );
}

function commandDiagnostics(errors: readonly PersistedCommandError[]): DiagnosticDetail[] {
  const diagnostics: DiagnosticDetail[] = [];
  const seen = new Set<string>();
  for (const error of errors) {
    for (const detail of error.envelope.diagnostics ?? []) {
      const key = stringifyJson(detail);
      if (seen.has(key)) continue;
      seen.add(key);
      diagnostics.push(detail);
    }
  }
  return diagnostics;
}

function insertEvent(
  state: InMemoryObserverPersistenceState,
  event: StationEvent,
  eventId: string,
  options: EventRecordOptions,
  now: () => string,
): PersistedEvent {
  const parsedEvent = StationEventSchema.parse(event);
  if (state.events.has(eventId)) {
    throw new Error(`Event ${eventId} already exists.`);
  }
  const persisted: PersistedEvent = {
    id: eventId,
    type: parsedEvent.type,
    source: options.source ?? "observer",
    event: parsedEvent,
    createdAt: options.createdAt ?? stationEventTimestamp(parsedEvent) ?? now(),
  };
  const commandId = options.commandId ?? stationEventCommandId(parsedEvent);
  if (commandId !== undefined) persisted.commandId = commandId;
  if (options.traceId !== undefined) persisted.traceId = options.traceId;
  if (options.spanId !== undefined) persisted.spanId = options.spanId;
  state.events.set(eventId, persisted);
  return persisted;
}

function claimIngressDedupeKey(
  state: InMemoryObserverPersistenceState,
  dedupe: IngressDedupeKey,
): boolean {
  const key = stringifyJson([dedupe.kind, dedupe.id]);
  if (state.ingressDedupe.has(key)) return false;
  state.ingressDedupe.add(key);
  return true;
}

function insertProviderObservation(
  state: InMemoryObserverPersistenceState,
  input: InsertProviderObservationInput,
): PersistedProviderObservation {
  const validated = parseProviderObservation(input.entityKind, input.payload);
  const parsed = parseProviderObservation(
    validated.entityKind,
    parseJson(stringifyJson(validated.payload)),
  );
  if (input.coalesceUnchanged === true) {
    const latest = latestProviderObservation(state, {
      provider: input.provider,
      providerType: input.providerType,
      entityKind: parsed.entityKind,
      entityKey: input.entityKey,
    });
    if (
      latest !== undefined &&
      stableProviderObservationPayloadKey(latest.payload) ===
        stableProviderObservationPayloadKey(parsed.payload)
    ) {
      latest.observedAt = input.observedAt;
      latest.payload = parsed.payload;
      latest.expired = isExpired(input.expiresAt, input.observedAt);
      delete latest.expiresAt;
      if (input.expiresAt !== undefined) latest.expiresAt = input.expiresAt;
      return observationAtReferenceTime(latest, input.observedAt);
    }
  }

  const observation: PersistedProviderObservation = {
    id: input.id,
    provider: input.provider,
    providerType: input.providerType,
    entityKey: input.entityKey,
    observedAt: input.observedAt,
    expired: isExpired(input.expiresAt, input.observedAt),
    ...parsed,
  };
  if (input.expiresAt !== undefined) observation.expiresAt = input.expiresAt;
  state.observations.set(input.id, observation);
  return observation;
}

function listProviderObservations(
  state: InMemoryObserverPersistenceState,
  options: {
    entityKind?: ProviderObservationKind | readonly ProviderObservationKind[];
    includeExpired?: boolean;
    latestOnly?: boolean;
    referenceTime: string;
  },
): PersistedProviderObservation[] {
  const kinds = options.entityKind === undefined ? undefined : normalizeKinds(options.entityKind);
  if (kinds?.length === 0) return [];
  const candidates = [...state.observations.values()]
    .filter((observation) => kinds === undefined || kinds.includes(observation.entityKind))
    .filter(
      (observation) =>
        options.includeExpired === true ||
        observation.expiresAt === undefined ||
        observation.expiresAt > options.referenceTime,
    );
  const selected =
    options.latestOnly === true ? latestObservationsByEntity(candidates) : candidates;
  return selected
    .sort(
      (left, right) =>
        compareAsc(left.observedAt, right.observedAt) || compareAsc(left.id, right.id),
    )
    .map((observation) => observationAtReferenceTime(observation, options.referenceTime));
}

function listCurrentProviderEntityObservations(
  state: InMemoryObserverPersistenceState,
  options: {
    entityKind?: CurrentProviderObservationKind | readonly CurrentProviderObservationKind[];
    includeExpired?: boolean;
    referenceTime: string;
  },
): PersistedProviderObservation[] {
  const kinds =
    options.entityKind === undefined
      ? (["worktree", "terminal_target"] satisfies CurrentProviderObservationKind[])
      : normalizeKinds(options.entityKind);
  if (kinds.length === 0) return [];

  const entityKeys = new Map<
    string,
    {
      provider: ProviderId;
      providerType: ProviderObservationType;
      entityKind: CurrentProviderObservationKind;
      entityKey: string;
    }
  >();
  if (kinds.includes("worktree")) {
    for (const worktree of state.worktrees.values()) {
      const key = observationEntityKey(worktree.provider, "worktree", "worktree", worktree.id);
      entityKeys.set(key, {
        provider: worktree.provider,
        providerType: "worktree",
        entityKind: "worktree",
        entityKey: worktree.id,
      });
    }
  }
  if (kinds.includes("terminal_target")) {
    for (const target of state.terminalTargets.values()) {
      const key = observationEntityKey(target.provider, "terminal", "terminal_target", target.id);
      entityKeys.set(key, {
        provider: target.provider,
        providerType: "terminal",
        entityKind: "terminal_target",
        entityKey: target.id,
      });
    }
  }

  const observations: PersistedProviderObservation[] = [];
  for (const key of entityKeys.values()) {
    const expiry: { includeExpired?: boolean; referenceTime: string } = {
      referenceTime: options.referenceTime,
    };
    if (options.includeExpired !== undefined) expiry.includeExpired = options.includeExpired;
    const latest = latestProviderObservation(state, key, expiry);
    if (latest !== undefined) observations.push(latest);
  }
  return observations
    .sort(
      (left, right) =>
        compareAsc(left.observedAt, right.observedAt) || compareAsc(left.id, right.id),
    )
    .map((observation) => observationAtReferenceTime(observation, options.referenceTime));
}

function latestObservationsByEntity(
  observations: readonly PersistedProviderObservation[],
): PersistedProviderObservation[] {
  const latest = new Map<string, PersistedProviderObservation>();
  for (const observation of observations) {
    const key = observationEntityKey(
      observation.provider,
      observation.providerType,
      observation.entityKind,
      observation.entityKey,
    );
    const current = latest.get(key);
    if (current === undefined || compareObservationRecency(observation, current) > 0) {
      latest.set(key, observation);
    }
  }
  return [...latest.values()];
}

function latestProviderObservation(
  state: InMemoryObserverPersistenceState,
  key: {
    provider: ProviderId;
    providerType: ProviderObservationType;
    entityKind: ProviderObservationKind;
    entityKey: string;
  },
  expiry?: { includeExpired?: boolean; referenceTime: string },
): PersistedProviderObservation | undefined {
  let latest: PersistedProviderObservation | undefined;
  for (const observation of state.observations.values()) {
    if (
      observation.provider !== key.provider ||
      observation.providerType !== key.providerType ||
      observation.entityKind !== key.entityKind ||
      observation.entityKey !== key.entityKey ||
      (expiry !== undefined &&
        expiry.includeExpired !== true &&
        observation.expiresAt !== undefined &&
        observation.expiresAt <= expiry.referenceTime)
    ) {
      continue;
    }
    if (latest === undefined || compareObservationRecency(observation, latest) > 0) {
      latest = observation;
    }
  }
  return latest;
}

function observationAtReferenceTime(
  observation: PersistedProviderObservation,
  referenceTime: string,
): PersistedProviderObservation {
  return {
    ...observation,
    expired: isExpired(observation.expiresAt, referenceTime),
  };
}

function isExpired(expiresAt: string | undefined, referenceTime: string): boolean {
  return expiresAt === undefined ? false : Date.parse(expiresAt) <= Date.parse(referenceTime);
}

function compareObservationRecency(
  left: PersistedProviderObservation,
  right: PersistedProviderObservation,
): number {
  return compareAsc(left.observedAt, right.observedAt) || compareAsc(left.id, right.id);
}

function observationEntityKey(
  provider: ProviderId,
  providerType: ProviderObservationType,
  entityKind: ProviderObservationKind,
  entityKey: string,
): string {
  return stringifyJson([provider, providerType, entityKind, entityKey]);
}

function persistReconcileResult(
  state: InMemoryObserverPersistenceState,
  input: PersistReconcileResultInput,
  options: { observedAt: string; idFactory: ObserverIdFactory },
): void {
  for (const project of input.projects) {
    state.projects.set(project.id, {
      id: project.id,
      label: project.label,
      root: project.root,
      lastSeenAt: options.observedAt,
    });
  }

  const worktrees = input.worktrees.map((value) => WorktreeObservationSchema.parse(value));
  for (const worktree of worktrees) {
    state.worktrees.set(worktree.id, worktree);
    insertProviderObservation(state, {
      id: options.idFactory.observationId(),
      provider: worktree.provider,
      providerType: "worktree",
      entityKind: "worktree",
      entityKey: worktree.id,
      payload: worktree,
      observedAt: worktree.observedAt,
      expiresAt: reconcileObservationExpiresAt(input, worktree.observedAt),
      coalesceUnchanged: true,
    });
  }

  const terminalTargets = input.terminalTargets.map((value) =>
    stripTerminalProviderData(TerminalTargetObservationSchema.parse(value)),
  );
  for (const target of terminalTargets) {
    state.terminalTargets.set(target.id, target);
    insertProviderObservation(state, {
      id: options.idFactory.observationId(),
      provider: target.provider,
      providerType: "terminal",
      entityKind: "terminal_target",
      entityKey: target.id,
      payload: target,
      observedAt: target.observedAt,
      expiresAt: reconcileObservationExpiresAt(input, target.observedAt),
      coalesceUnchanged: true,
    });
  }

  const harnessRuns = input.harnessRuns.map((value) => HarnessRunObservationSchema.parse(value));
  for (const run of harnessRuns) {
    state.harnessRuns.set(run.id, run);
    insertProviderObservation(state, {
      id: options.idFactory.observationId(),
      provider: run.provider,
      providerType: "harness",
      entityKind: "harness_run",
      entityKey: run.id,
      payload: run,
      observedAt: run.observedAt,
      expiresAt: reconcileObservationExpiresAt(input, run.observedAt),
      coalesceUnchanged: true,
    });
  }

  if (input.providerHealth !== undefined) {
    for (const health of Object.values(input.providerHealth)) {
      insertProviderObservation(state, {
        id: options.idFactory.observationId(),
        provider: health.providerId,
        providerType: "observer",
        entityKind: "provider_health",
        entityKey: health.providerId,
        payload: health,
        observedAt: health.lastCheckedAt,
        expiresAt: reconcileObservationExpiresAt(input, health.lastCheckedAt),
        coalesceUnchanged: true,
      });
    }
  }
  upsertSessions(state, terminalTargets, harnessRuns, worktrees);
}

function reconcileObservationExpiresAt(
  input: PersistReconcileResultInput,
  observedAt: string,
): string | undefined {
  if (input.providerObservationRetentionDays !== undefined) {
    return providerObservationExpiresAt(observedAt, input.providerObservationRetentionDays);
  }
  return input.expiresAt;
}

function upsertSessions(
  state: InMemoryObserverPersistenceState,
  terminalTargets: readonly TerminalTargetObservation[],
  harnessRuns: readonly HarnessRunObservation[],
  worktrees: readonly WorktreeObservation[],
): void {
  const worktreesById = new Map(worktrees.map((worktree) => [worktree.id, worktree]));
  const sessions = new Map<string, PersistedSession>();

  for (const target of terminalTargets) {
    if (
      target.sessionId === undefined ||
      target.projectId === undefined ||
      target.worktreeId === undefined
    ) {
      continue;
    }
    const existing = sessions.get(target.sessionId);
    const activates = terminalCanActivateSession({ target, runs: harnessRuns });
    const session: PersistedSession = {
      id: target.sessionId,
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      lifecycle: activates || existing?.lifecycle === "open" ? "open" : "legacy",
      terminalProvider: target.provider,
      state: target.state,
      createdAt: existing?.createdAt ?? target.observedAt,
      lastSeenAt: maxIso(existing?.lastSeenAt, target.observedAt),
    };
    const title = worktreesById.get(target.worktreeId)?.branch;
    if (title !== undefined) session.title = title;
    else if (existing?.title !== undefined) session.title = existing.title;
    if (existing?.harness !== undefined) session.harness = existing.harness;
    sessions.set(target.sessionId, session);
  }

  for (const run of harnessRuns) {
    if (
      run.sessionId === undefined ||
      run.projectId === undefined ||
      run.worktreeId === undefined
    ) {
      continue;
    }
    const existing = sessions.get(run.sessionId);
    const activates = harnessRunCanActivateSession({
      run,
      terminals: terminalTargets,
      runs: harnessRuns,
    });
    const session: PersistedSession = {
      id: run.sessionId,
      projectId: run.projectId,
      worktreeId: run.worktreeId,
      lifecycle: activates || existing?.lifecycle === "open" ? "open" : "legacy",
      harness: run.provider,
      state: run.state,
      createdAt: existing?.createdAt ?? run.observedAt,
      lastSeenAt: maxIso(existing?.lastSeenAt, run.observedAt),
    };
    const title = worktreesById.get(run.worktreeId)?.branch;
    if (title !== undefined) session.title = title;
    else if (existing?.title !== undefined) session.title = existing.title;
    if (existing?.terminalProvider !== undefined) {
      session.terminalProvider = existing.terminalProvider;
    }
    sessions.set(run.sessionId, session);
  }

  for (const session of sessions.values()) {
    const existing = state.sessions.get(session.id);
    if (existing === undefined) {
      state.sessions.set(session.id, session);
      continue;
    }
    existing.projectId = session.projectId;
    existing.worktreeId = session.worktreeId;
    if (existing.title === undefined && session.title !== undefined) existing.title = session.title;
    if (session.harness !== undefined) existing.harness = session.harness;
    if (session.terminalProvider !== undefined) {
      existing.terminalProvider = session.terminalProvider;
    }
    if (session.state === undefined) delete existing.state;
    else existing.state = session.state;
    existing.lastSeenAt = session.lastSeenAt;
    if (existing.lifecycle !== "ended") {
      existing.lifecycle =
        existing.lifecycle === "open" || session.lifecycle === "open" ? "open" : "legacy";
    }
  }
}

function findRememberedHarnessProviderForWorktree(
  state: InMemoryObserverPersistenceState,
  input: { projectId: string; worktreeId: string; worktreePath: string },
): ProviderId | undefined {
  const sessions = [...state.sessions.values()]
    .filter((session) => session.projectId === input.projectId && session.harness !== undefined)
    .sort(
      (left, right) =>
        compareDesc(left.lastSeenAt, right.lastSeenAt) ||
        compareDesc(left.createdAt, right.createdAt) ||
        compareDesc(left.id, right.id),
    );
  const direct = sessions.find((session) => session.worktreeId === input.worktreeId);
  if (direct?.harness !== undefined) return direct.harness;
  return sessions.find((session) => {
    const worktree = state.worktrees.get(session.worktreeId);
    return (
      worktree !== undefined &&
      worktree.projectId === session.projectId &&
      sameObservedPath(worktree.path, input.worktreePath)
    );
  })?.harness;
}

function upsertSessionRecoveryHandle(
  state: InMemoryObserverPersistenceState,
  input: SessionRecoveryHandle,
): SessionRecoveryHandle {
  const handle = SessionRecoveryHandleSchema.parse({
    ...input,
    id: recoveryHandleId(input),
  });
  const existing = state.recoveryHandles.get(handle.id);
  if (
    existing !== undefined &&
    (existing.provider !== handle.provider ||
      existing.target.kind !== handle.target.kind ||
      recoveryTargetValue(existing) !== recoveryTargetValue(handle))
  ) {
    throw new Error(`Session recovery handle ${handle.id} already exists.`);
  }
  if (existing === undefined) {
    state.recoveryHandles.set(handle.id, handle);
    return handle;
  }

  existing.projectId = handle.projectId;
  existing.worktreeId = handle.worktreeId;
  if (handle.sessionId !== undefined) existing.sessionId = handle.sessionId;
  if (handle.cwd !== undefined) existing.cwd = handle.cwd;
  if (handle.terminalTargetId !== undefined) existing.terminalTargetId = handle.terminalTargetId;
  if (handle.harnessRunId !== undefined) existing.harnessRunId = handle.harnessRunId;
  if (handle.observedAt < existing.observedAt) existing.observedAt = handle.observedAt;
  existing.lastSeenAt = handle.lastSeenAt;
  return SessionRecoveryHandleSchema.parse(existing);
}

function matchesRecoveryHandleOptions(
  handle: SessionRecoveryHandle,
  options: ListSessionRecoveryHandlesOptions,
): boolean {
  return !(
    (options.projectId !== undefined && handle.projectId !== options.projectId) ||
    (options.worktreeId !== undefined && handle.worktreeId !== options.worktreeId) ||
    (options.provider !== undefined && handle.provider !== options.provider)
  );
}

function applySessionTurnReadinessMutation(
  state: InMemoryObserverPersistenceState,
  mutation: SessionTurnReadinessMutation,
  createdAt: string,
): void {
  if (mutation.action === "upsert") {
    upsertSessionTurnReadiness(state, { ...mutation.value, createdAt });
    return;
  }
  deleteSessionTurnReadiness(state, { sessionId: mutation.sessionId });
}

function upsertSessionTurnReadiness(
  state: InMemoryObserverPersistenceState,
  input: {
    sessionId: string;
    projectId: string;
    worktreeId: string;
    token: string;
    completedAt: string;
    createdAt: string;
    updatedAt?: string;
  },
): PersistedSessionTurnReadiness {
  const readiness: PersistedSessionTurnReadiness = {
    sessionId: input.sessionId,
    projectId: input.projectId,
    worktreeId: input.worktreeId,
    token: input.token,
    completedAt: input.completedAt,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt ?? input.createdAt,
  };
  const existing = state.turnReadiness.get(input.sessionId);
  if (existing === undefined) {
    state.turnReadiness.set(input.sessionId, readiness);
    return readiness;
  }
  if (existing.completedAt < readiness.completedAt) {
    existing.projectId = readiness.projectId;
    existing.worktreeId = readiness.worktreeId;
    existing.token = readiness.token;
    existing.completedAt = readiness.completedAt;
    existing.updatedAt = readiness.updatedAt;
  }
  return existing;
}

function deleteSessionTurnReadiness(
  state: InMemoryObserverPersistenceState,
  input: { sessionId: string; token?: string },
): number {
  const current = state.turnReadiness.get(input.sessionId);
  if (current === undefined || (input.token !== undefined && input.token !== current.token)) {
    return 0;
  }
  state.turnReadiness.delete(input.sessionId);
  return 1;
}

function recoveryHandleId(handle: SessionRecoveryHandle): string {
  // Recovery identity follows the provider-native target rather than per-report ingress IDs.
  const key = `${handle.provider}\u0000${handle.target.kind}\u0000${recoveryTargetValue(handle)}`;
  return `rec_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

function recoveryTargetValue(handle: SessionRecoveryHandle): string {
  switch (handle.target.kind) {
    case "native-session":
      return handle.target.id;
    case "session-file":
      return handle.target.path;
  }
}

function metadataKey(worktreeId: string, kind: WorktreeMetadataCurrentKind): string {
  return stringifyJson([worktreeId, kind]);
}

function metadataAtReferenceTime(
  current: PersistedWorktreeMetadataCurrent,
  referenceTime: string,
): PersistedWorktreeMetadataCurrent {
  return {
    ...current,
    expired: isExpired(current.expiresAt, referenceTime),
  };
}

function listWorktreeMetadataCurrent<TKind extends WorktreeMetadataCurrentKind>(
  state: InMemoryObserverPersistenceState,
  options: {
    kind?: TKind | readonly TKind[];
    includeExpired?: boolean;
    referenceTime: string;
  },
): PersistedWorktreeMetadataCurrent<TKind>[] {
  const kinds = options.kind === undefined ? undefined : normalizeKinds(options.kind);
  if (kinds?.length === 0) return [];
  return [...state.worktreeMetadata.values()]
    .filter(
      (current): current is PersistedWorktreeMetadataCurrent<TKind> =>
        kinds === undefined || kinds.includes(current.kind as TKind),
    )
    .filter(
      (current) =>
        options.includeExpired === true ||
        current.expiresAt === undefined ||
        current.expiresAt > options.referenceTime,
    )
    .map(
      (current) =>
        metadataAtReferenceTime(
          current,
          options.referenceTime,
        ) as PersistedWorktreeMetadataCurrent<TKind>,
    )
    .sort(
      (left, right) =>
        compareAsc(left.updatedAt, right.updatedAt) ||
        compareAsc(left.worktreeId, right.worktreeId) ||
        compareAsc(left.kind, right.kind),
    );
}

function validateWorktreeMetadataPayload<TKind extends WorktreeMetadataCurrentKind>(
  kind: TKind,
  payload: unknown,
): WorktreeMetadataCurrentPayloadByKind[TKind] {
  return metadataPayloadSchema(kind).parse(payload) as WorktreeMetadataCurrentPayloadByKind[TKind];
}

function metadataPayloadSchema(kind: WorktreeMetadataCurrentKind) {
  switch (kind) {
    case "change_summary":
      return WorktreeChangeSummarySchema;
    case "pull_request":
      return WorktreePullRequestSchema;
    case "checks":
      return WorktreeChecksSummarySchema;
    default:
      throw new Error(`Unsupported worktree metadata kind: ${String(kind)}`);
  }
}

function normalizeKinds<TKind extends string>(kind: TKind | readonly TKind[]): TKind[] {
  return Array.isArray(kind) ? [...kind] : [kind as TKind];
}

function maxIso(left: string | undefined, right: string): string {
  return left === undefined || Date.parse(left) < Date.parse(right) ? right : left;
}

function compareAsc(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareDesc(left: string, right: string): number {
  return compareAsc(right, left);
}
