import { StationEventSchema } from "@station/contracts";
import { Effect, type RuntimeClock, systemClock, toIsoTimestamp } from "@station/runtime";
import type { SqlDatabase } from "../sqlite/driver.js";
import { type ObserverSqliteHandle, runSqliteTransactionEffect } from "../sqlite.js";
import * as commandStore from "./commands.js";
import * as correlationStore from "./correlations.js";
import { eventCommandId, eventTimestamp, listEvents, recordEvent } from "./events.js";
import { defaultIdFactory } from "./idFactory.js";
import * as ingressDedupeStore from "./ingressDedupe.js";
import {
  insertProviderObservation,
  listProviderObservations,
  pruneExpiredProviderObservations,
} from "./observations.js";
import type { ObserverPersistenceBundle, PersistenceHealthSource } from "./ports.js";
import { providerObservationRetentionDays } from "./retention.js";
import * as sessionGroupSqlite from "./sessionGroupSqlite.js";
import * as sessionGroupStore from "./sessionGroups.js";
import * as sessionHarnessDerivedState from "./sessionHarnessDerivedState.js";
import * as sessionHarnessExecutionStore from "./sessionHarnessExecutions.js";
import * as sessionRecoveryHandleStore from "./sessionRecoveryHandles.js";
import * as sessionTurnReadinessStore from "./sessionTurnReadiness.js";
import type {
  HarnessExecutionIngress,
  ObserverIdFactory,
  SessionTurnReadinessMutation,
} from "./types.js";
import * as worktreeDisplayTitleStore from "./worktreeDisplayTitles.js";
import * as worktreeMetadataCurrentStore from "./worktreeMetadataCurrent.js";

export type CreateSqliteObserverPersistenceOptions = {
  sqlite: ObserverSqliteHandle;
  clock?: RuntimeClock;
  idFactory?: Partial<ObserverIdFactory>;
};

function compareIdentity(left: { id: string }, right: { id: string }): number {
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

/**
 * ADAPTER
 *
 * Provides Observer persistence and health capabilities through SQLite while keeping SQL rows and transactions at the storage boundary.
 */
export function createSqliteObserverPersistence(
  options: CreateSqliteObserverPersistenceOptions,
): ObserverPersistenceBundle & PersistenceHealthSource {
  const clock = options.clock ?? systemClock;
  const idFactory = { ...defaultIdFactory, ...options.idFactory };
  const now = () => toIsoTimestamp(clock.now());
  const transaction = <T>(task: (database: SqlDatabase) => T): Promise<T> =>
    Effect.runPromise(runSqliteTransactionEffect(options.sqlite, task));
  // Deferred snapshots let queries proceed while another WAL connection reserves the writer.
  const readTransaction = <T>(task: (database: SqlDatabase) => T): Promise<T> =>
    Effect.runPromise(runSqliteTransactionEffect(options.sqlite, task, "deferred"));
  const sessionGroupMutation = <T>(
    mutate: (state: sessionGroupStore.SessionGroupPersistenceState) => {
      state: sessionGroupStore.SessionGroupPersistenceState;
      result: T;
      changed: boolean;
    },
  ): Promise<T> =>
    transaction((database) => {
      const before = sessionGroupSqlite.readSessionGroupState(database);
      const mutation = mutate(before);
      if (mutation.changed) {
        sessionGroupSqlite.writeSessionGroupState(database, before, mutation.state);
      }
      return mutation.result;
    });

  return {
    health: () => options.sqlite.health(),

    readRecoveryInventory: () =>
      readTransaction((database) => {
        const sessions = correlationStore.listSessions(database).sort(compareIdentity);
        const recoveryHandles = sessionRecoveryHandleStore
          .listSessionRecoveryHandles(database, {})
          .sort(compareIdentity);
        return { sessions, recoveryHandles };
      }),

    recordCommandAccepted: (input) =>
      transaction((database) =>
        commandStore.recordCommandAccepted(database, {
          ...input,
          createdAt: input.createdAt ?? now(),
        }),
      ),

    markCommandStarted: (commandId, startedAt) =>
      transaction((database) =>
        commandStore.markCommandStarted(database, commandId, startedAt ?? now()),
      ),

    markCommandSucceeded: (commandId, finishedAt, result) =>
      transaction((database) =>
        commandStore.markCommandSucceeded(database, commandId, finishedAt ?? now(), result),
      ),

    markCommandFailed: (input) =>
      transaction((database) =>
        commandStore.markCommandFailed(database, {
          ...input,
          finishedAt: input.finishedAt ?? now(),
        }),
      ),

    getCommand: (commandId) =>
      readTransaction((database) => commandStore.getCommand(database, commandId)),

    listCommands: () => readTransaction(commandStore.listCommands),

    listCommandErrors: (commandId) =>
      readTransaction((database) => commandStore.listCommandErrors(database, commandId)),

    recordEvent: (event, eventOptions = {}) =>
      transaction((database) => {
        const parsedEvent = StationEventSchema.parse(event);
        const eventId = idFactory.eventId();
        const createdAt = eventOptions.createdAt ?? eventTimestamp(parsedEvent) ?? now();
        const commandId = eventOptions.commandId ?? eventCommandId(parsedEvent);
        return recordEvent(database, parsedEvent, {
          eventId,
          source: eventOptions.source ?? "observer",
          createdAt,
          ...(commandId === undefined ? {} : { commandId }),
          ...(eventOptions.traceId === undefined ? {} : { traceId: eventOptions.traceId }),
          ...(eventOptions.spanId === undefined ? {} : { spanId: eventOptions.spanId }),
        });
      }),

    recordEventWithIngressDedupe: (event, eventOptions) =>
      transaction((database) => {
        const parsedEvent = StationEventSchema.parse(event);
        const eventId = idFactory.eventId();
        const createdAt = eventOptions.createdAt ?? eventTimestamp(parsedEvent) ?? now();
        const claimed = ingressDedupeStore.claimIngressDedupeKey(database, {
          ...eventOptions.dedupe,
          eventId,
          createdAt,
        });
        if (!claimed) {
          return { deduped: true };
        }
        const commandId = eventOptions.commandId ?? eventCommandId(parsedEvent);
        return {
          deduped: false,
          event: recordEvent(database, parsedEvent, {
            eventId,
            source: eventOptions.source ?? "observer",
            createdAt,
            ...(commandId === undefined ? {} : { commandId }),
            ...(eventOptions.traceId === undefined ? {} : { traceId: eventOptions.traceId }),
            ...(eventOptions.spanId === undefined ? {} : { spanId: eventOptions.spanId }),
          }),
        };
      }),

    recordEventAndProviderObservationWithIngressDedupe: (input) =>
      transaction((database) => {
        const parsedEvent = StationEventSchema.parse(input.event);
        const eventId = idFactory.eventId();
        const createdAt = input.eventOptions.createdAt ?? eventTimestamp(parsedEvent) ?? now();
        const claimed = ingressDedupeStore.claimIngressDedupeKey(database, {
          ...input.dedupe,
          eventId,
          createdAt,
        });
        if (!claimed) {
          return { deduped: true };
        }
        const commandId = input.eventOptions.commandId ?? eventCommandId(parsedEvent);
        const event = recordEvent(database, parsedEvent, {
          eventId,
          source: input.eventOptions.source ?? "observer",
          createdAt,
          ...(commandId === undefined ? {} : { commandId }),
          ...(input.eventOptions.traceId === undefined
            ? {}
            : { traceId: input.eventOptions.traceId }),
          ...(input.eventOptions.spanId === undefined ? {} : { spanId: input.eventOptions.spanId }),
        });
        const observation = insertProviderObservation(database, {
          ...input.observation,
          id: idFactory.observationId(),
          observedAt: input.observation.observedAt ?? now(),
        });
        const harnessExecution = input.harnessExecution;
        if (harnessExecution !== undefined) {
          applyHarnessExecutionIngress(database, harnessExecution, now());
        }
        return {
          deduped: false,
          event,
          observation,
        };
      }),

    recordProviderObservationsWithIngressDedupe: (input) =>
      transaction((database) => {
        const createdAt = input.createdAt ?? now();
        const claimed = ingressDedupeStore.claimIngressDedupeKey(database, {
          ...input.dedupe,
          eventId: input.dedupe.id,
          createdAt,
        });
        if (!claimed) {
          return { deduped: true };
        }
        const observations = input.observations.map((observation) =>
          insertProviderObservation(database, {
            ...observation,
            id: idFactory.observationId(),
            observedAt: observation.observedAt ?? now(),
          }),
        );
        for (const harnessExecution of input.harnessExecutions ?? []) {
          applyHarnessExecutionIngress(database, harnessExecution, now());
        }
        for (const mutation of input.turnReadiness ?? []) {
          applySessionTurnReadinessMutation(database, mutation, now());
        }
        return { deduped: false, observations };
      }),

    listEvents: (filter = {}) => readTransaction((database) => listEvents(database, filter)),

    recordProviderObservation: (input) =>
      transaction((database) =>
        insertProviderObservation(database, {
          ...input,
          id: idFactory.observationId(),
          observedAt: input.observedAt ?? now(),
        }),
      ),

    listProviderObservations: (listOptions = {}) =>
      readTransaction((database) =>
        listProviderObservations(database, {
          ...(listOptions.entityKind === undefined ? {} : { entityKind: listOptions.entityKind }),
          ...(listOptions.includeExpired === undefined
            ? {}
            : { includeExpired: listOptions.includeExpired }),
          ...(listOptions.latestOnly === undefined ? {} : { latestOnly: listOptions.latestOnly }),
          referenceTime: listOptions.now ?? now(),
        }),
      ),

    pruneExpiredProviderObservations: (expiresBefore) =>
      transaction((database) => pruneExpiredProviderObservations(database, expiresBefore ?? now())),

    upsertWorktreeMetadataCurrent: (input) =>
      transaction((database) =>
        worktreeMetadataCurrentStore.upsertWorktreeMetadataCurrent(database, {
          ...input,
          updatedAt: input.updatedAt ?? now(),
        }),
      ),

    listWorktreeMetadataCurrent: (listOptions = {}) =>
      readTransaction((database) =>
        worktreeMetadataCurrentStore.listWorktreeMetadataCurrent(database, {
          ...(listOptions.kind === undefined ? {} : { kind: listOptions.kind }),
          ...(listOptions.includeExpired === undefined
            ? {}
            : { includeExpired: listOptions.includeExpired }),
          referenceTime: listOptions.now ?? now(),
        }),
      ),

    deleteWorktreeMetadataCurrent: (input) =>
      transaction((database) =>
        worktreeMetadataCurrentStore.deleteWorktreeMetadataCurrent(database, input),
      ),

    persistReconcileResult: (input) =>
      transaction((database) => {
        const reconcileInput =
          input.expiresAt === undefined && input.providerObservationRetentionDays === undefined
            ? {
                ...input,
                providerObservationRetentionDays: providerObservationRetentionDays(),
              }
            : input;
        correlationStore.persistReconcileResult(database, reconcileInput, {
          observedAt: input.observedAt ?? now(),
          idFactory,
        });
      }),

    listSessions: () => readTransaction(correlationStore.listSessions),

    listSessionGroups: () =>
      readTransaction((database) =>
        sessionGroupStore.listSessionGroups(sessionGroupSqlite.readSessionGroupState(database)),
      ),

    createSessionGroup: (input) =>
      sessionGroupMutation((state) =>
        sessionGroupStore.createSessionGroup(state, {
          ...input,
          createdAt: input.createdAt ?? now(),
        }),
      ),

    renameSessionGroup: (input) =>
      sessionGroupMutation((state) =>
        sessionGroupStore.renameSessionGroup(state, {
          ...input,
          updatedAt: input.updatedAt ?? now(),
        }),
      ),

    updateSessionGroupMembership: (input) =>
      sessionGroupMutation((state) =>
        sessionGroupStore.updateSessionGroupMembership(state, {
          ...input,
          updatedAt: input.updatedAt ?? now(),
        }),
      ),

    reparentSessionGroup: (input) =>
      sessionGroupMutation((state) =>
        sessionGroupStore.reparentSessionGroup(state, {
          ...input,
          updatedAt: input.updatedAt ?? now(),
        }),
      ),

    deleteSessionGroup: (input) =>
      sessionGroupMutation((state) =>
        sessionGroupStore.deleteSessionGroup(state, {
          ...input,
          updatedAt: input.updatedAt ?? now(),
        }),
      ),

    repairSessionGroups: (input) =>
      sessionGroupMutation((state) =>
        sessionGroupStore.repairSessionGroups(state, {
          ...input,
          updatedAt: input.updatedAt ?? now(),
        }),
      ),

    listWorktreeDisplayTitles: () =>
      readTransaction(worktreeDisplayTitleStore.listWorktreeDisplayTitles),

    getSessionHarnessExecution: (input) =>
      readTransaction((database) =>
        sessionHarnessExecutionStore.getSessionHarnessExecution(database, input),
      ),

    listSessionHarnessExecutions: () =>
      readTransaction(sessionHarnessExecutionStore.listSessionHarnessExecutions),

    resetSessionForFreshStart: (input) =>
      transaction((database) => {
        const execution = sessionHarnessExecutionStore.getSessionHarnessExecution(database, input);
        const readiness = sessionTurnReadinessStore.readSessionTurnReadiness(
          database,
          input.sessionId,
        );
        const deletedHandles = sessionRecoveryHandleStore.deleteSessionRecoveryHandles(
          database,
          input,
        );
        sessionHarnessExecutionStore.replaceSessionHarnessExecution(database, input);
        sessionTurnReadinessStore.deleteSessionTurnReadiness(database, {
          sessionId: input.sessionId,
        });
        return {
          changed: execution !== undefined || readiness !== undefined || deletedHandles > 0,
        };
      }),

    repairSessionHarnessDerivedState: (input) =>
      transaction((database) => {
        const currentExecution = sessionHarnessExecutionStore.getSessionHarnessExecution(
          database,
          input,
        );
        const requestedReadiness =
          input.turnReadiness !== undefined &&
          sessionHarnessDerivedState.turnReadinessWasAcknowledged(
            commandStore.listCommands(database),
            input.turnReadiness,
          )
            ? undefined
            : input.turnReadiness;
        const currentReadiness = sessionTurnReadinessStore.readSessionTurnReadiness(
          database,
          input.sessionId,
        );
        if (
          sessionHarnessDerivedState.sessionHarnessExecutionEqual(
            currentExecution,
            input.harnessExecution,
          ) &&
          sessionHarnessDerivedState.sessionTurnReadinessEqual(currentReadiness, requestedReadiness)
        ) {
          return { changed: false };
        }
        sessionHarnessExecutionStore.replaceSessionHarnessExecution(database, input);
        sessionTurnReadinessStore.deleteSessionTurnReadiness(database, {
          sessionId: input.sessionId,
        });
        if (requestedReadiness !== undefined) {
          sessionTurnReadinessStore.upsertSessionTurnReadiness(database, requestedReadiness);
        }
        return { changed: true };
      }),

    findRememberedHarnessProviderForWorktree: (input) =>
      readTransaction((database) =>
        correlationStore.findRememberedHarnessProviderForWorktree(database, input),
      ),

    seedSession: (input) =>
      transaction((database) => {
        const groupBefore = sessionGroupSqlite.readSessionGroupState(database);
        const placement = sessionGroupStore.placeSessionSeed(groupBefore, {
          sessionId: input.sessionId,
          projectId: input.projectId,
          ...(input.group === undefined ? {} : { placement: input.group }),
          updatedAt: input.createdAt,
        });
        if (!placement.result.ok) return placement.result;

        const session = correlationStore.seedSession(database, input);
        if (placement.changed) {
          sessionGroupSqlite.writeSessionGroupState(database, groupBefore, placement.state);
        }
        return {
          ok: true,
          session,
          ...(placement.result.groupProvenance !== undefined
            ? { groupProvenance: placement.result.groupProvenance }
            : {}),
        };
      }),

    discardSessionSeed: (input) =>
      transaction((database) => {
        const session = correlationStore
          .listSessions(database)
          .find((candidate) => candidate.id === input.sessionId);
        const groupBefore = sessionGroupSqlite.readSessionGroupState(database);
        if (session === undefined) {
          if (input.groupProvenance !== undefined || groupBefore.assignments.has(input.sessionId)) {
            throw new Error("Session seed no longer matches cleanup provenance.");
          }
          return correlationStore.discardSessionSeed(database, input);
        }
        const placement = sessionGroupStore.discardSessionSeedPlacement(groupBefore, {
          sessionId: input.sessionId,
          projectId: session.projectId,
          ...(input.groupProvenance === undefined
            ? {}
            : { groupProvenance: input.groupProvenance }),
          updatedAt: input.discardedAt ?? now(),
        });
        const result = correlationStore.discardSessionSeed(database, input);
        if (placement.changed) {
          sessionGroupSqlite.writeSessionGroupState(database, groupBefore, placement.state);
        }
        return result;
      }),

    markSessionsEnded: (input) =>
      transaction((database) => correlationStore.markSessionsEnded(database, input)),

    reopenSession: (sessionId) =>
      transaction((database) => correlationStore.reopenSession(database, sessionId)),

    renameSession: (input) =>
      transaction((database) => correlationStore.renameSession(database, input)),

    retireRemovedWorktreeSessionState: (input) =>
      transaction((database) =>
        correlationStore.retireRemovedWorktreeSessionState(database, input),
      ),

    importSessionRecoveryHandle: (input) =>
      transaction((database) => {
        if (input.title !== undefined) {
          const canonical = worktreeDisplayTitleStore.upsertWorktreeDisplayTitle(database, {
            projectId: input.handle.projectId,
            worktreeId: input.handle.worktreeId,
            title: input.title,
            createdAt: input.importedAt,
            updatedAt: input.importedAt,
          });
          worktreeDisplayTitleStore.synchronizeSessionTitleProjections(database, canonical);
        }
        return sessionRecoveryHandleStore.upsertSessionRecoveryHandle(database, input.handle);
      }),

    upsertSessionRecoveryHandle: (input) =>
      transaction((database) =>
        sessionRecoveryHandleStore.upsertSessionRecoveryHandle(database, input),
      ),

    getSessionRecoveryHandle: (handleId) =>
      readTransaction((database) =>
        sessionRecoveryHandleStore.getSessionRecoveryHandle(database, handleId),
      ),

    listSessionRecoveryHandles: (listOptions = {}) =>
      readTransaction((database) =>
        sessionRecoveryHandleStore.listSessionRecoveryHandles(database, listOptions),
      ),

    upsertSessionTurnReadiness: (input) =>
      transaction((database) => {
        const createdAt = input.createdAt ?? now();
        return sessionTurnReadinessStore.upsertSessionTurnReadiness(database, {
          ...input,
          createdAt,
          updatedAt: input.updatedAt ?? createdAt,
        });
      }),

    listSessionTurnReadiness: () =>
      readTransaction((database) => sessionTurnReadinessStore.listSessionTurnReadiness(database)),

    deleteSessionTurnReadiness: (input) =>
      transaction((database) =>
        sessionTurnReadinessStore.deleteSessionTurnReadiness(database, input),
      ),
  };
}

function applyHarnessExecutionIngress(
  database: SqlDatabase,
  harnessExecution: HarnessExecutionIngress,
  createdAt: string,
): void {
  if (
    !sessionHarnessExecutionStore.applySessionHarnessExecutionEvidence(
      database,
      harnessExecution.evidence,
    )
  ) {
    return;
  }
  if (harnessExecution.recoveryHandle !== undefined) {
    sessionRecoveryHandleStore.upsertSessionRecoveryHandle(
      database,
      harnessExecution.recoveryHandle,
    );
  }
  if (harnessExecution.turnReadiness !== undefined) {
    applySessionTurnReadinessMutation(database, harnessExecution.turnReadiness, createdAt);
  }
}

function applySessionTurnReadinessMutation(
  database: SqlDatabase,
  mutation: SessionTurnReadinessMutation,
  createdAt: string,
): void {
  if (mutation.action === "upsert") {
    sessionTurnReadinessStore.upsertSessionTurnReadiness(database, {
      ...mutation.value,
      createdAt,
    });
    return;
  }
  sessionTurnReadinessStore.deleteSessionTurnReadiness(database, {
    sessionId: mutation.sessionId,
  });
}
