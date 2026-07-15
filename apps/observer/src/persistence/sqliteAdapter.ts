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
  listCurrentProviderEntityObservations,
  listProviderObservations,
  pruneExpiredProviderObservations,
} from "./observations.js";
import type { ObserverPersistenceBundle, PersistenceHealthSource } from "./ports.js";
import { providerObservationRetentionDays } from "./retention.js";
import * as sessionRecoveryHandleStore from "./sessionRecoveryHandles.js";
import * as sessionTurnReadinessStore from "./sessionTurnReadiness.js";
import type { ObserverIdFactory } from "./types.js";
import * as worktreeMetadataCurrentStore from "./worktreeMetadataCurrent.js";

export type CreateSqliteObserverPersistenceOptions = {
  sqlite: ObserverSqliteHandle;
  clock?: RuntimeClock;
  idFactory?: Partial<ObserverIdFactory>;
};

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

  return {
    health: () => options.sqlite.health(),

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

    markCommandSucceeded: (commandId, finishedAt) =>
      transaction((database) =>
        commandStore.markCommandSucceeded(database, commandId, finishedAt ?? now()),
      ),

    markCommandFailed: (input) =>
      transaction((database) =>
        commandStore.markCommandFailed(database, {
          ...input,
          finishedAt: input.finishedAt ?? now(),
        }),
      ),

    getCommand: (commandId) =>
      transaction((database) => commandStore.getCommand(database, commandId)),

    listCommands: () => transaction(commandStore.listCommands),

    listCommandErrors: (commandId) =>
      transaction((database) => commandStore.listCommandErrors(database, commandId)),

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
        for (const mutation of input.turnReadiness ?? []) {
          if (mutation.action === "upsert") {
            sessionTurnReadinessStore.upsertSessionTurnReadiness(database, {
              ...mutation.value,
              createdAt: now(),
            });
          } else {
            sessionTurnReadinessStore.deleteSessionTurnReadiness(database, {
              sessionId: mutation.sessionId,
            });
          }
        }
        return { deduped: false, observations };
      }),

    listEvents: (filter = {}) => transaction((database) => listEvents(database, filter)),

    recordProviderObservation: (input) =>
      transaction((database) =>
        insertProviderObservation(database, {
          ...input,
          id: idFactory.observationId(),
          observedAt: input.observedAt ?? now(),
        }),
      ),

    listProviderObservations: (listOptions = {}) =>
      transaction((database) =>
        listProviderObservations(database, {
          ...(listOptions.entityKind === undefined ? {} : { entityKind: listOptions.entityKind }),
          ...(listOptions.includeExpired === undefined
            ? {}
            : { includeExpired: listOptions.includeExpired }),
          ...(listOptions.latestOnly === undefined ? {} : { latestOnly: listOptions.latestOnly }),
          referenceTime: listOptions.now ?? now(),
        }),
      ),

    listCurrentProviderEntityObservations: (listOptions = {}) =>
      transaction((database) =>
        listCurrentProviderEntityObservations(database, {
          ...(listOptions.entityKind === undefined ? {} : { entityKind: listOptions.entityKind }),
          ...(listOptions.includeExpired === undefined
            ? {}
            : { includeExpired: listOptions.includeExpired }),
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
      transaction((database) =>
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

    listSessions: () => transaction(correlationStore.listSessions),

    findRememberedHarnessProviderForWorktree: (input) =>
      transaction((database) =>
        correlationStore.findRememberedHarnessProviderForWorktree(database, input),
      ),

    seedSessionTitle: (input) =>
      transaction((database) => correlationStore.seedSessionTitle(database, input)),

    deleteSessionTitleSeed: (sessionId) =>
      transaction((database) => correlationStore.deleteSessionTitleSeed(database, sessionId)),

    markSessionsEnded: (input) =>
      transaction((database) => correlationStore.markSessionsEnded(database, input)),

    reopenSession: (sessionId) =>
      transaction((database) => correlationStore.reopenSession(database, sessionId)),

    renameSession: (input) =>
      transaction((database) => correlationStore.renameSession(database, input)),

    upsertSessionRecoveryHandle: (input) =>
      transaction((database) =>
        sessionRecoveryHandleStore.upsertSessionRecoveryHandle(database, input),
      ),

    getSessionRecoveryHandle: (handleId) =>
      transaction((database) =>
        sessionRecoveryHandleStore.getSessionRecoveryHandle(database, handleId),
      ),

    listSessionRecoveryHandles: (listOptions = {}) =>
      transaction((database) =>
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
      transaction((database) => sessionTurnReadinessStore.listSessionTurnReadiness(database)),

    deleteSessionTurnReadiness: (input) =>
      transaction((database) =>
        sessionTurnReadinessStore.deleteSessionTurnReadiness(database, input),
      ),
  };
}
